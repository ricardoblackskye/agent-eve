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
MINIKUBE="${MINIKUBE:-/c/Program Files/Kubernetes/Minikube/minikube.exe}"
HELM="${HELM:-$LOCALAPPDATA/Temp/helm/windows-amd64/helm.exe}"
FORWARD_PORT="${FORWARD_PORT:-18082}"
KEYID="${KEYID:-a}"                      # one character in [0-9a-z]

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

[ingress]
mode = "gateway"

[ingress.gateway]
address = "opensandbox.example.com"

[ingress.gateway.route]
mode = "header"

[ingress.secure_access]
active_key = "$KEYID"

[[ingress.secure_access.keys]]
key_id = "$KEYID"
key = "$KEY"
EOF

# --- 6. install (subchart overrides go under the DEPENDENCY NAME) ----------
cd "$REPO_DIR/manifests/charts/opensandbox"
"$HELM" dependency build
"$HELM" upgrade --install opensandbox . -n "$NS_CP" --create-namespace \
  --set opensandbox-server.gateway.secureAccess.keyId="$KEYID" \
  --set opensandbox-server.gateway.secureAccess.key="$KEY" \
  --set ingress-gateway.gateway.secureAccess.keyId="$KEYID" \
  --set ingress-gateway.gateway.secureAccess.key="$KEY"

# --- 7. CRDs the base chart omits (the controller crashloops without them) -
for crd in pools sandboxsnapshots; do
  kubectl apply -f "$REPO_DIR/kubernetes/config/crd/bases/sandbox.opensandbox.io_${crd}.yaml"
done

# --- 8. config + the three environment fixes -------------------------------
kubectl -n "$NS_CP" create configmap opensandbox-server-config \
  --from-file=config.toml="$REPO_DIR/.local/config.toml" \
  --dry-run=client -o yaml | kubectl apply -f -

# OPENSANDBOX_CONFIG is the critical one: the chart sets SANDBOX_CONFIG_PATH
# (a name the server never reads), so without this the server silently runs a
# default config with no [egress] and credentialProxy.enabled is always rejected.
kubectl -n "$NS_CP" set env deployment/opensandbox-server \
  OPENSANDBOX_INSECURE_SERVER=YES \
  OPENSANDBOX_CONFIG=/etc/opensandbox/config.toml

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
