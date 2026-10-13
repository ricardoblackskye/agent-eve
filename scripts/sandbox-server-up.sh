#!/usr/bin/env bash
# #281 (R2) T0 — bring the OpenSandbox lifecycle server up, reproducibly.
#
# Self-hosted, so NO vendor credential is involved: any API key is one WE mint for OUR server.
# Runs the same way locally and on any Docker (or Kubernetes, via the config template) host.
#
#   bash scripts/sandbox-server-up.sh                 # local dev (insecure ack, see below)
#   OPENSANDBOX_API_KEY=... bash scripts/sandbox-server-up.sh   # keyed server
#
# Why the insecure acknowledgment: with an empty `api_key` the server refuses to start unless it is
# explicitly acknowledged — interactively, or via OPENSANDBOX_INSECURE_SERVER=YES. We set it ONLY
# when no key is supplied and we are binding to loopback, so a keyed/remote server can never take the
# insecure path by accident.
set -euo pipefail

CONFIG="${SANDBOX_CONFIG_PATH:-$HOME/.sandbox.toml}"
# NATIVE tools (uvx/python) do NOT translate MSYS paths on Windows/git-bash: passing
# "/c/Users/.../.sandbox.toml" makes the server silently miss the file and die with
# "AppConfig: runtime Field required". Convert for the native call, keep POSIX for bash.
if command -v cygpath >/dev/null 2>&1; then
  CONFIG_NATIVE="$(cygpath -w "$CONFIG")"
else
  CONFIG_NATIVE="$CONFIG"
fi
HEALTH_URL="${SANDBOX_HEALTH_URL:-http://127.0.0.1:8080/health}"
LOG="${SANDBOX_LOG:-$HOME/.opensandbox/server.log}"
EXAMPLE="${SANDBOX_CONFIG_EXAMPLE:-docker}"   # docker | k8s

if ! command -v uvx >/dev/null 2>&1; then
  echo "uvx not found. Install uv (https://docs.astral.sh/uv/) — the server ships as a uv tool." >&2
  exit 1
fi

if [ ! -f "$CONFIG" ]; then
  echo "==> generating $CONFIG (example: $EXAMPLE)"
  uvx opensandbox-server init-config "$CONFIG_NATIVE" --example "$EXAMPLE"
fi

if curl -s -m 3 "$HEALTH_URL" 2>/dev/null | grep -q healthy; then
  echo "==> already healthy at $HEALTH_URL"
  exit 0
fi

mkdir -p "$(dirname "$LOG")"
ENV_ARGS=()
if [ -n "${OPENSANDBOX_API_KEY:-}" ]; then
  echo "==> starting with an API key (clients must send OPEN_SANDBOX_API_KEY)"
else
  echo "==> no OPENSANDBOX_API_KEY set: starting with the insecure acknowledgment (local dev only)"
  ENV_ARGS+=(OPENSANDBOX_INSECURE_SERVER=YES)
fi

echo "==> starting server (log: $LOG)"
nohup env "${ENV_ARGS[@]}" uvx opensandbox-server --config "$CONFIG_NATIVE" >>"$LOG" 2>&1 &

for _ in $(seq 1 30); do
  if curl -s -m 3 "$HEALTH_URL" 2>/dev/null | grep -q healthy; then
    echo "==> healthy at $HEALTH_URL"
    exit 0
  fi
  sleep 2
done

echo "==> server did not become healthy. Last log lines:" >&2
tail -20 "$LOG" >&2
exit 1
