#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Re-runnable bootstrap for a LOCAL OpenSandbox control plane that serves the
# Credential Vault.  The vault is Kubernetes-only (the docker runtime rejects
# secure_access outright), so this stands up minikube + the umbrella Helm chart.
#
# Verified: minikube v1.39.0 / Kubernetes v1.34.0 / OpenSandbox 1.1.1
#           egress mode "dns+nft" + ingress "gateway" + live MITM injection.
#
# Usage:  bash scripts/k8s-vault-proof/bootstrap.sh
# Then:   kubectl -n opensandbox-system port-forward svc/opensandbox-server 18082:80
#         python scripts/k8s-vault-proof/vault-proof.py --port 18082
#
# This is operator-run dev tooling; it is not part of the CI trust boundary.
# ---------------------------------------------------------------------------
set -euo pipefail

NS_CP="${NS_CP:-opensandbox-system}"     # control-plane namespace
NS_SB="${NS_SB:-opensandbox}"            # sandbox namespace
REPO_DIR="${REPO_DIR:-$HOME/opensandbox-repo}"
# helm and kubectl are NATIVE Windows binaries and do NOT translate MSYS paths (/c/Users/...),
# so anything handed to them as a FILE PATH must be in mixed form (C:/Users/...). Repo paths
# used only by bash (cd, heredocs) are fine as-is. REPO_NATIVE is the path for native tools.
REPO_NATIVE="$(cygpath -m "$REPO_DIR" 2>/dev/null || echo "$REPO_DIR")"
MINIKUBE="${MINIKUBE:-/c/Program Files/Kubernetes/Minikube/minikube.exe}"
HELM="${HELM:-$LOCALAPPDATA/Temp/helm/windows-amd64/helm.exe}"
FORWARD_PORT="${FORWARD_PORT:-18082}"
KEYID="${KEYID:-a}"                      # one character in [0-9a-z]

# --- 0. preflight: the engine minikube drives -------------------------------
# AC6: with the engine down, the first thing reported used to be minikube failing on a
# Docker-internal named pipe, which names neither the cause nor the remedy. Say it plainly.
if ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  echo "ERROR: Docker Desktop's engine is not reachable." >&2
  echo "  minikube drives Docker on this host, so nothing can start without it." >&2
  echo "  Start Docker Desktop (Linux containers), confirm 'docker ps' works, then re-run." >&2
  exit 1
fi

# --- 1. cluster ------------------------------------------------------------
if ! "$MINIKUBE" status >/dev/null 2>&1; then
  "$MINIKUBE" start --driver=docker --cpus=4 --memory=4096
fi

# --- 2. chart source (the umbrella chart lives in the repo clone) ----------
[ -d "$REPO_DIR" ] || git clone --depth 1 \
  https://github.com/opensandbox-group/OpenSandbox.git "$REPO_DIR"

# --- 3. helm (the winget package id is wrong; use the official binary) -----
if [ ! -x "$HELM" ]; then
  TAG=$(curl -fsSL https://api.github.com/repos/helm/helm/releases/latest \
        | python -c "import sys,json;print(json.loads(sys.stdin.read())['tag_name'])")
  mkdir -p "$(dirname "$HELM")"
  curl -fsSL -L "https://get.helm.sh/helm-${TAG}-windows-amd64.zip" -o "$HELM.zip"
  unzip -o "$HELM.zip" -d "$(dirname "$HELM")" >/dev/null
fi

# --- 4. ephemeral local signing key (test-only; never committed) -----------
KEY=$(python -c "import os,base64;print(base64.b64encode(os.urandom(32)).decode())")

# --- 5. the proven server config ------------------------------------------
# Key points: workload_provider=batchsandbox, [egress].mode="dns+nft",
# [ingress].mode="gateway", a secure_access signing key, and
# sandbox_create_timeout_seconds raised from the default 60 (the egress sidecar
# needs roughly 20-40s to pass its readiness probe).
mkdir -p "$REPO_DIR/.local"
cat > "$REPO_DIR/.local/config.toml" <<EOF
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

# --- 5b. the sandbox WORKLOAD namespace ------------------------------------
# The chart creates only the control-plane namespace (--create-namespace below). The
# workload namespace the config names is deliberately NOT created by the chart - its
# values.yaml says so - and the server refuses to create a sandbox without it:
#   Create sandbox failed: Namespace not found: (404)
# This was invisible on a cluster built by an earlier manual run, where the namespace
# already existed, and only surfaced on a genuine cold start.
kubectl create namespace "$NS_SB" --dry-run=client -o yaml | kubectl apply -f -

# --- 6. install (subchart overrides: the umbrella passes opensandbox-server.* to the
# server subchart, whose gateway values live under server.gateway.* — so the override is
# opensandbox-server.server.gateway.*, NOT opensandbox-server.gateway.*. The bare path maps
# to nothing and silently leaves [ingress] mode="direct". secureAccess signing uses
# activeKey + keys[].key_id/key, not keyId/key.) ----------
# helm is a native Windows binary and does NOT translate MSYS paths, so the config path must be
# handed to it in the mixed form (C:/Users/...). cygpath -m does that; where cygpath is absent
# (non-MSYS hosts) the raw path is already what helm expects.
CONFIG_TOML="$REPO_NATIVE/.local/config.toml"
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
cd "$REPO_DIR/manifests/charts/opensandbox"
"$HELM" dependency build
"$HELM" upgrade --install opensandbox . -n "$NS_CP" --create-namespace \
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

# --- 7. CRDs the base chart omits (the controller crashloops without them) -
for crd in pools sandboxsnapshots; do
  kubectl apply -f "$REPO_NATIVE/kubernetes/config/crd/bases/sandbox.opensandbox.io_${crd}.yaml"
done

# --- 8. (removed) the config and the env are Helm values now -----------------
# Both were once applied with kubectl against objects the chart creates, which left
# the ConfigMap with two managers (helm + kubectl-client-side-apply) and made every
# subsequent `helm upgrade` abort with "Apply failed with 1 conflict". Helm is the
# single owner now: the config arrives via configToml, the env via server.env[], and
# the only remaining kubectl apply is for the CRDs the base chart omits (step 7).
# No manual rollout restart is needed either - a values change alters the pod spec,
# so the rollout is spec-driven. The wait below stays, so the caller knows it is up.
kubectl -n "$NS_CP" rollout restart deployment/opensandbox-server
kubectl -n "$NS_CP" rollout restart deployment/opensandbox-controller-manager 2>/dev/null || true
kubectl -n "$NS_CP" rollout status  deployment/opensandbox-server --timeout=180s

# --- 9. verify the config the server actually loaded -----------------------
kubectl -n "$NS_CP" exec deploy/opensandbox-server -- sh -c \
  "cd /app && python -c \"from opensandbox_server.config import load_config as L; c=L('/etc/opensandbox/config.toml'); print('egress.mode=', c.egress.mode); print('create_timeout=', c.kubernetes.sandbox_create_timeout_seconds)\""

echo
echo "READY. Next:"
echo "  kubectl -n $NS_CP port-forward svc/opensandbox-server $FORWARD_PORT:80"
echo "  python scripts/k8s-vault-proof/vault-proof.py --port $FORWARD_PORT"
