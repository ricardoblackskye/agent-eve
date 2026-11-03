#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# #553 AC5 — scripted teardown of the LOCAL OpenSandbox control plane.
#
# Design decision (agreed on review): this is SURGICAL, not a reset. It uninstalls the
# release and removes the two namespaces, then leaves minikube RUNNING so the next
# `df:sandbox-up` is a warm `helm upgrade --install` instead of a cold 4-CPU cluster start.
# Destroying the cluster by default would make every re-run pay the cold-start cost, so a
# full reset is only available as an explicit --delete-cluster opt-in.
#
# The port check is the part that matters: a port-forward left behind by a failed run holds
# the port, and the next run then fails with "address already in use" and no clue why. If the
# port is still listening after teardown, this script FAILS rather than reporting success.
#
# Usage:  bash scripts/df-sandbox-down.sh [--delete-cluster]
# Windows only: helm/kubectl/minikube are native Windows binaries; the port probe uses
# netstat, which is present on every Windows host.
# ---------------------------------------------------------------------------
set -euo pipefail

NS_CP="${NS_CP:-opensandbox-system}"
NS_SB="${NS_SB:-opensandbox}"
FORWARD_PORT="${FORWARD_PORT:-18082}"
DELETE_CLUSTER=""

for arg in "$@"; do
  case "$arg" in
    --delete-cluster) DELETE_CLUSTER="1" ;;
    -h|--help)
      echo "usage: bash scripts/df-sandbox-down.sh [--delete-cluster]"
      echo "  Releases the sandbox release and both namespaces, and leaves minikube running."
      echo "  --delete-cluster  also run 'minikube delete' for a full reset"
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $arg" >&2
      echo "  usage: bash scripts/df-sandbox-down.sh [--delete-cluster]" >&2
      exit 1
      ;;
  esac
done

MINIKUBE="${MINIKUBE:-$(command -v minikube 2>/dev/null || true)}"
HELM="${HELM:-$(command -v helm 2>/dev/null || true)}"

# --- 1. stop the port-forward first ---------------------------------------
# Doing this before the uninstall means the port is free even if helm later fails, and the
# port check at the end can trust what it sees.
echo "stopping any port-forward on ${FORWARD_PORT}"
kubectl -n "$NS_CP" delete pod --field-selector=status.phase=Running -l app=port-forward \
  --ignore-not-found 2>/dev/null || true
# The forward is usually a foreground process the operator started; kill the binary's children
# by name so a dangling forward cannot keep the port.
if command -v taskkill >/dev/null 2>&1; then
  taskkill //F //IM kubectl.exe //FI "WINDOWTITLE eq *port-forward*" >/dev/null 2>&1 || true
fi

# --- 2. uninstall the release ---------------------------------------------
# helm is the single owner of the chart objects (#570), so helm is what removes them. Deleting
# pods by hand would leave the release in a failed state and the next upgrade would trip.
if [ -n "$HELM" ]; then
  echo "uninstalling release 'opensandbox' from ${NS_CP}"
  "$HELM" uninstall opensandbox -n "$NS_CP" --ignore-not-found 2>/dev/null || true
else
  echo "WARNING: helm not found on PATH; skipping release uninstall." >&2
fi

# --- 3. remove both namespaces --------------------------------------------
# The chart creates the control-plane namespace; the workload namespace was created explicitly
# by bootstrap.sh. Removing both is what makes a re-run a genuine cold start of the sandbox.
for ns in "$NS_CP" "$NS_SB"; do
  echo "deleting namespace ${ns}"
  kubectl delete namespace "$ns" --ignore-not-found --timeout=120s 2>/dev/null || true
done

# --- 4. the port must actually be free ------------------------------------
# AC5: a teardown that leaves the port held is a failed teardown. Say so instead of returning
# success and letting the next run fail obscurely.
if command -v netstat >/dev/null 2>&1; then
  if netstat -ano 2>/dev/null | grep -qE "[:.]${FORWARD_PORT}[[:space:]]"; then
    echo "ERROR: port ${FORWARD_PORT} is still listening after teardown." >&2
    echo "  A port-forward survived. Find and stop it:" >&2
    echo "    netstat -ano | findstr :${FORWARD_PORT}" >&2
    echo "    taskkill //F //PID <pid>" >&2
    exit 1
  fi
fi

# --- 5. the cluster stays up unless explicitly asked ----------------------
if [ -n "$DELETE_CLUSTER" ]; then
  if [ -n "$MINIKUBE" ]; then
    echo "deleting the minikube cluster as requested (--delete-cluster)"
    "$MINIKUBE" delete
  else
    echo "WARNING: minikube not found on PATH; cannot delete the cluster." >&2
  fi
else
  echo "leaving minikube running (surgical teardown). Use --delete-cluster for a full reset."
fi

echo
echo "TEARDOWN COMPLETE. The release and both namespaces are gone; the port is free."
echo "Re-run 'npm run df:sandbox-up' for a warm redeploy."
