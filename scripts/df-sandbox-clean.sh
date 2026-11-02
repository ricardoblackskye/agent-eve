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

echo "==> sandboxes before:"
"$KUBECTL" -n "$NS_SB" get batchsandboxes -o name 2>/dev/null | wc -l

"$KUBECTL" -n "$NS_SB" delete batchsandboxes --all --ignore-not-found
"$KUBECTL" -n "$NS_SB" delete pods --all --ignore-not-found

echo "==> sandboxes after:"
"$KUBECTL" -n "$NS_SB" get batchsandboxes -o name 2>/dev/null | wc -l
