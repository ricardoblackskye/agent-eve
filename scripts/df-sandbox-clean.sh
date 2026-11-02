#!/usr/bin/env bash
# #570 AC3 - teardown for the local sandbox.
#
# Leftover sandboxes exhaust the single minikube node: new pods stay Pending with
# "FailedScheduling: Insufficient memory", so a later run fails for state rather than for
# code. This is an EXPLICIT teardown rather than something the setup does silently, because
# deleting sandboxes at setup time could destroy one belonging to a run in progress.
#
#   npm run df:sandbox-clean
set -euo pipefail

NS_SB="${NS_SB:-opensandbox}"
KUBECTL="${KUBECTL:-kubectl}"

# AC3 safety: this deletes EVERY sandbox and pod in $NS_SB. It must only ever run
# against the local minikube, never a remote/cluster context - a wrong context would
# wipe a live run's sandboxes on another cluster. Refuse unless the active context is
# the expected one (override with SANDBOX_CLEAN_CONTEXT when your local minikube is
# named differently).
EXPECTED_CTX="${SANDBOX_CLEAN_CONTEXT:-minikube}"
CURRENT_CTX="$("$KUBECTL" config current-context 2>/dev/null || true)"
if [ -z "$CURRENT_CTX" ]; then
  echo "ERROR: df:sandbox-clean needs an active kubectl context (expected '$EXPECTED_CTX')." >&2
  exit 1
fi
if [ "$CURRENT_CTX" != "$EXPECTED_CTX" ]; then
  echo "ERROR: df:sandbox-clean deletes ALL sandboxes and pods in namespace '$NS_SB'." >&2
  echo "  Active kubectl context is '$CURRENT_CTX'; expected '$EXPECTED_CTX' (local minikube)." >&2
  echo "  Point kubectl at your local minikube, or set SANDBOX_CLEAN_CONTEXT='$CURRENT_CTX' to override." >&2
  exit 1
fi

echo "==> sandboxes before:"
"$KUBECTL" -n "$NS_SB" get batchsandboxes -o name 2>/dev/null | wc -l

"$KUBECTL" -n "$NS_SB" delete batchsandboxes --all --ignore-not-found
"$KUBECTL" -n "$NS_SB" delete pods --all --ignore-not-found

echo "==> sandboxes after:"
"$KUBECTL" -n "$NS_SB" get batchsandboxes -o name 2>/dev/null | wc -l
