#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Re-runnable bootstrap for a LOCAL OpenSandbox control plane that serves the
# Credential Vault.  The vault is Kubernetes-only (the docker runtime rejects
# secure_access outright), so this stands up minikube + the umbrella Helm chart.
#
# Verified: minikube v1.39.0 / Kubernetes v1.34.0 / OpenSandbox 1.1.1
#           egress mode "dns+nft" + ingress "gateway" + live MITM injection.
#
# #553: this script fetches NOTHING at run time. The chart and the CRDs are committed
# in-tree (vendor/opensandbox-charts, vendor/opensandbox-crds) and the images come from a
# populated local cache. When the cache is empty it REFUSES and names the vendor command
# instead of silently cloning and pulling, because a silent fetch is exactly the
# non-reproducibility this change exists to remove (AC2/AC6).
#
# Usage:  bash scripts/k8s-vault-proof/bootstrap.sh
# Prereq: npm run df:sandbox-vendor     (once; populates the image cache)
# Then:   kubectl -n opensandbox-system port-forward svc/opensandbox-server 18082:80
#         python scripts/k8s-vault-proof/vault-proof.py --port 18082
#
# Environment overrides:
#   KUBE_CONTEXT   target an existing cluster instead of starting minikube (AC4)
#   CHART_DIR      committed chart directory   (default vendor/opensandbox-charts/opensandbox)
#   CACHE_DIR      image cache directory       (default scripts/sandbox-vendor/cache)
#   MINIKUBE/HELM  explicit binaries; PATH is tried first, this is the fallback
#   NS_CP/NS_SB    control-plane and sandbox namespaces
#   FORWARD_PORT   the port the vault proof uses
#
# This is operator-run dev tooling; it is not part of the CI trust boundary. Windows only:
# helm/kubectl/minikube are native Windows binaries and do NOT translate MSYS paths, so every
# path handed to them goes through cygpath -m.
# ---------------------------------------------------------------------------
set -euo pipefail

NS_CP="${NS_CP:-opensandbox-system}"     # control-plane namespace
NS_SB="${NS_SB:-opensandbox}"            # sandbox namespace
FORWARD_PORT="${FORWARD_PORT:-18082}"
KEYID="${KEYID:-a}"                      # one character in [0-9a-z]

# --- 0. resolve our own location and the committed artefacts ----------------
# The script lives in scripts/k8s-vault-proof/, so the checkout root is two levels up. This
# replaces REPO_DIR ($HOME/opensandbox-repo), which pointed at a clone this script used to make.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# helm and kubectl are NATIVE Windows binaries and do NOT translate MSYS paths (/c/Users/...),
# so anything handed to them as a FILE PATH must be in mixed form (C:/Users/...). Repo paths
# used only by bash (cd, heredocs) are fine as-is. REPO_NATIVE is the path for native tools.
REPO_NATIVE="$(cygpath -m "$REPO_ROOT" 2>/dev/null || echo "$REPO_ROOT")"

CHART_DIR="${CHART_DIR:-$REPO_ROOT/vendor/opensandbox-charts/opensandbox}"
CACHE_DIR="${CACHE_DIR:-$REPO_ROOT/scripts/sandbox-vendor/cache}"
KUBE_CONTEXT="${KUBE_CONTEXT:-}"

CHART_NATIVE="$(cygpath -m "$CHART_DIR" 2>/dev/null || echo "$CHART_DIR")"

# PATH-first resolution, env override second. Hardcoded install paths were why this only ever
# worked on one machine (AC1).
MINIKUBE="${MINIKUBE:-$(command -v minikube 2>/dev/null || true)}"
HELM="${HELM:-$(command -v helm 2>/dev/null || true)}"

# The images the committed chart config actually runs. Kept in step with
# scripts/sandbox-vendor/artifacts.lock.json - the vendoring test pins that they agree.
IMAGES=(
  "sandbox-registry.cn-zhangjiakou.cr.aliyuncs.com/opensandbox/execd:release-1.1.1"
  "sandbox-registry.cn-zhangjiakou.cr.aliyuncs.com/opensandbox/egress:release-1.1.1"
)

# --- 0a. the committed artefacts must be present ---------------------------
for required in "$CHART_DIR/Chart.yaml" "$REPO_ROOT/vendor/opensandbox-crds"; do
  if [ ! -e "$required" ]; then
    echo "ERROR: a committed sandbox artefact is missing: $required" >&2
    echo "  The checkout is incomplete. Re-checkout; do not work around it by fetching." >&2
    exit 1
  fi
done

# --- 0b. preflight: the engine minikube drives -----------------------------
# AC6: with the engine down, the first thing reported used to be minikube failing on a
# Docker-internal named pipe, which names neither the cause nor the remedy. Say it plainly.
if ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  echo "ERROR: Docker Desktop's engine is not reachable." >&2
  echo "  minikube drives Docker on this host, so nothing can start without it." >&2
  echo "  Start Docker Desktop (Linux containers), confirm 'docker ps' works, then re-run." >&2
  exit 1
fi

# --- 0c. the image cache must be populated (AC2/AC6) -----------------------
if [ ! -d "$CACHE_DIR" ] || [ -z "$(ls -A "$CACHE_DIR" 2>/dev/null)" ]; then
  echo "ERROR: the local image cache is empty: $CACHE_DIR" >&2
  echo "  Nothing was deployed. Populate it first:" >&2
  echo "    npm run df:sandbox-vendor" >&2
  exit 1
fi

# AC6: refuse BY NAME when an image the deploy needs is not in the local store. A pod that
# cannot pull reports only "ImagePullBackOff", which names neither the image nor the fix.
for IMAGE in "${IMAGES[@]}"; do
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "ERROR: image not present in the local store: $IMAGE" >&2
    echo "  Nothing was deployed. Populate the cache first: npm run df:sandbox-vendor" >&2
    exit 1
  fi
done

# --- 1. cluster ------------------------------------------------------------
# AC4: one parameter. With KUBE_CONTEXT set we target that cluster and never start minikube;
# without it we drive the local one. Same provisioning, local or remote.
CONTEXT_ARGS=()
if [ -n "$KUBE_CONTEXT" ]; then
  CONTEXT_ARGS+=(--kube-context "$KUBE_CONTEXT")
  echo "targeting existing cluster context: $KUBE_CONTEXT"
else
  if [ -z "$MINIKUBE" ]; then
    echo "ERROR: minikube was not found on PATH and MINIKUBE is not set." >&2
    echo "  Install minikube, or set KUBE_CONTEXT to target an existing cluster." >&2
    exit 1
  fi
  if ! "$MINIKUBE" status >/dev/null 2>&1; then
    "$MINIKUBE" start --driver=docker --cpus=4 --memory=4096
  fi
fi

if [ -z "$HELM" ]; then
  echo "ERROR: helm was not found on PATH and HELM is not set." >&2
  echo "  Install helm (winget's package id is wrong; use the official binary) or set HELM." >&2
  exit 1
fi

# --- 2. ephemeral local signing key (test-only; never committed) -----------
KEY=$(python -c "import os,base64;print(base64.b64encode(os.urandom(32)).decode())")

# --- 3. the proven server config ------------------------------------------
# Key points: workload_provider=batchsandbox, [egress].mode="dns+nft",
# [ingress].mode="gateway", a secure_access signing key, and
# sandbox_create_timeout_seconds raised from the default 60 (the egress sidecar
# needs roughly 20-40s to pass its readiness probe).
# #553: the config is written to a scratch dir in the checkout, not into a cloned repo.
mkdir -p "$REPO_ROOT/.local"
CONFIG_FILE="$REPO_ROOT/.local/config.toml"
cat > "$CONFIG_FILE" <<EOF
[server]
host = "0.0.0.0"
port = 80
api_key = ""

[log]
level = "INFO"

[runtime]
type = "kubernetes"
execd_image = "sandbox-registry.cn-zhangjiakou.cr.aliyuncs.com/opensandbox/execd:release-1.1.1"

[kubernetes]
kubeconfig_path = ""
namespace = "$NS_SB"
informer_resync_seconds = 300
informer_watch_timeout_seconds = 60
workload_provider = "batchsandbox"
batchsandbox_template_file = "/etc/opensandbox/example.batchsandbox-template.yaml"
sandbox_create_timeout_seconds = 300

[egress]
image = "sandbox-registry.cn-zhangjiakou.cr.aliyuncs.com/opensandbox/egress:release-1.1.1"
mode = "dns+nft"


EOF

# --- 3b. the sandbox WORKLOAD namespace ------------------------------------
# The chart creates only the control-plane namespace (--create-namespace below). The
# workload namespace the config names is deliberately NOT created by the chart - its
# values.yaml says so - and the server refuses to create a sandbox without it:
#   Create sandbox failed: Namespace not found: (404)
# This was invisible on a cluster built by an earlier manual run, where the namespace
# already existed, and only surfaced on a genuine cold start.
kubectl create namespace "$NS_SB" --dry-run=client -o yaml | kubectl apply -f -

# --- 4. install (subchart overrides: the umbrella passes opensandbox-server.* to the
# server subchart, whose gateway values live under server.gateway.* — so the override is
# opensandbox-server.server.gateway.*, NOT opensandbox-server.gateway.*. The bare path maps
# to nothing and silently leaves [ingress] mode="direct". secureAccess signing uses
# activeKey + keys[].key_id/key, not keyId/key.) ----------
# helm is a native Windows binary and does NOT translate MSYS paths, so the config path must be
# handed to it in the mixed form (C:/Users/...). cygpath -m does that; where cygpath is absent
# (non-MSYS hosts) the raw path is already what helm expects.
CONFIG_TOML="$(cygpath -m "$CONFIG_FILE" 2>/dev/null || echo "$CONFIG_FILE")"
# REPAIR: an earlier version of this script owned this ConfigMap with kubectl
# (`kubectl create configmap ... | kubectl apply`), and a managedFields entry cannot be
# edited away - the only way to clear a foreign field manager is to delete the object.
# Helm recreates it from configToml in the upgrade below, so nothing is lost and nothing
# needs detecting: this is unconditional, and therefore idempotent by construction.
# (The first attempt at this used a jsonpath to detect the foreign manager, and it reported
# "no foreign field manager" while one was plainly present - a broken detector is worse
# than no detector, so it is gone.)
kubectl -n "$NS_CP" delete configmap opensandbox-server-config --ignore-not-found
echo "config for helm: $CONFIG_TOML"
cd "$CHART_DIR"
"$HELM" dependency build
"$HELM" upgrade --install opensandbox . -n "$NS_CP" --create-namespace \
  "${CONTEXT_ARGS[@]}" \
  --set opensandbox-server.server.gateway.enabled=true \
  --set opensandbox-server.server.gateway.host=opensandbox.example.com \
  --set opensandbox-server.server.gateway.gatewayRouteMode=header \
  --set opensandbox-server.server.gateway.secureAccess.activeKey="$KEYID" \
  --set "opensandbox-server.server.gateway.secureAccess.keys[0].key_id=$KEYID" \
  --set "opensandbox-server.server.gateway.secureAccess.keys[0].key=$KEY" \
  --set ingress-gateway.enabled=true \
  --set "ingress-gateway.gateway.secureAccess.keys[0].key_id=$KEYID" \
  --set "ingress-gateway.gateway.secureAccess.keys[0].key=$KEY" \
  --set-file opensandbox-server.configToml="$CONFIG_TOML" \
  --set opensandbox-server.server.env[0].name=OPENSANDBOX_INSECURE_SERVER \
  --set opensandbox-server.server.env[0].value=YES \
  --set opensandbox-server.server.env[1].name=OPENSANDBOX_CONFIG \
  --set opensandbox-server.server.env[1].value=/etc/opensandbox/config.toml

# --- 5. CRDs the base chart omits (the controller crashloops without them) -
# These are the committed CRDs under vendor/opensandbox-crds. The path stays REPO_NATIVE-
# prefixed because kubectl is a native binary and cannot read an MSYS path.
for crd in pools sandboxsnapshots; do
  kubectl apply -f "$REPO_NATIVE/vendor/opensandbox-crds/sandbox.opensandbox.io_${crd}.yaml"
done

# --- 6. (removed) the config and the env are Helm values now ---------------
# Both were once applied with kubectl against objects the chart creates, which left
# the ConfigMap with two managers (helm + kubectl-client-side-apply) and made every
# subsequent `helm upgrade` abort with "Apply failed with 1 conflict". Helm is the
# single owner now: the config arrives via configToml, the env via server.env[], and
# the only remaining kubectl apply is for the CRDs the base chart omits (step 5).
# No manual rollout restart is needed either - a values change alters the pod spec,
# so the rollout is spec-driven. The wait below stays, so the caller knows it is up.
kubectl -n "$NS_CP" rollout restart deployment/opensandbox-server
kubectl -n "$NS_CP" rollout restart deployment/opensandbox-controller-manager 2>/dev/null || true
kubectl -n "$NS_CP" rollout status  deployment/opensandbox-server --timeout=180s

# --- 7. verify the config the server actually loaded -----------------------
kubectl -n "$NS_CP" exec deploy/opensandbox-server -- sh -c \
  "cd /app && python -c \"from opensandbox_server.config import load_config as L; c=L('/etc/opensandbox/config.toml'); print('egress.mode=', c.egress.mode); print('create_timeout=', c.kubernetes.sandbox_create_timeout_seconds)\""

echo
echo "READY. Next:"
echo "  kubectl -n $NS_CP port-forward svc/opensandbox-server $FORWARD_PORT:80"
echo "  python scripts/k8s-vault-proof/vault-proof.py --port $FORWARD_PORT"
