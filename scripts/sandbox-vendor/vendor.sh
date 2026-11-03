#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# #553 AC2 — populate the local image cache from the committed digest lock.
#
# The chart is committed in-tree (vendor/opensandbox-charts), so nothing here touches
# GitHub. What is NOT committed is the image blobs: they are large binaries. This script
# pulls each image named in artifacts.lock.json, verifies the digest matches the lock, and
# saves it into the gitignored cache so `df:sandbox-up` can load it without reaching the
# network.
#
# Windows only. helm/kubectl/docker are native Windows binaries and do not translate MSYS
# paths, so every path handed to them is converted with `cygpath -m`.
#
# Usage:  bash scripts/sandbox-vendor/vendor.sh [--force]
# Then:   bash scripts/k8s-vault-proof/bootstrap.sh   (or npm run df:sandbox-up)
#
# This is operator-run dev tooling; it is not part of the CI trust boundary.
# ---------------------------------------------------------------------------
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
LOCK="$HERE/artifacts.lock.json"
CACHE="$HERE/cache"
FORCE="${1:-}"

# Native path form for docker AND python: both are native Windows binaries and neither
# translates MSYS paths (/c/Users/...), so a file path handed to them must be mixed form
# (C:/Users/...). Found by running this script for real - python reported the lock as missing
# while it sat right there, because it was handed the MSYS form.
CACHE_NATIVE="$(cygpath -m "$CACHE" 2>/dev/null || echo "$CACHE")"
LOCK_NATIVE="$(cygpath -m "$LOCK" 2>/dev/null || echo "$LOCK")"

if [ ! -f "$LOCK" ]; then
  echo "ERROR: lock file not found: $LOCK" >&2
  exit 1
fi

if ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  echo "ERROR: Docker Desktop's engine is not reachable." >&2
  echo "  The image cache cannot be populated without it." >&2
  echo "  Start Docker Desktop (Linux containers), confirm 'docker ps' works, then re-run." >&2
  exit 1
fi

mkdir -p "$CACHE"

# Read the lock with python: the repo already depends on python for the vault proof, and a
# JSON parser in bash would be a liability. Emits "ref<TAB>digest" per image.
# WINDOWS CARRIAGE RETURN: python's print emits \r\n here, and the read loop below leaves that
# \r attached to the digest. That made every comparison fail while both digests printed
# identically - the mismatch was invisible whitespace. Writing through sys.stdout with an
# explicit \n removes the character at the source instead of sanitising every consumer.
IMAGES=$(python - "$LOCK_NATIVE" <<'PY'
import json, sys
# Windows text-mode stdout translates \n to \r\n regardless of how the string is written, so
# the digest arrived with a trailing \r and every comparison failed on invisible whitespace.
# Binary mode is the only way to emit a bare \n here.
out = sys.stdout.buffer
with open(sys.argv[1], "r", encoding="utf-8") as handle:
    lock = json.load(handle)
for image in lock["images"]:
    out.write(f"{image['ref']}\t{image['digest']}\n".encode("utf-8"))
PY
)

if [ -z "$IMAGES" ]; then
  echo "ERROR: the lock names no images; nothing to vendor." >&2
  exit 1
fi

while IFS=$'\t' read -r REF DIGEST; do
  [ -n "$REF" ] || continue
  # Cache file name: repository path with slashes flattened, tag replaced by the digest.
  NAME="$(printf '%s' "$REF" | sed -e 's#^[^/]*/##' -e 's#/#_#g' -e 's#:#_#')"
  TAR="$CACHE/${NAME}.tar"

  if [ -f "$TAR" ] && [ "$FORCE" != "--force" ]; then
    echo "cached: $REF"
    continue
  fi

  echo "pulling: $REF"
  docker pull "$REF" >/dev/null

  # AC6: refuse loudly, naming the image, if what arrived is not the locked digest.
  # tr -d '\r' on this side too: docker's output is also CRLF on Windows. Sanitising only one
  # side of the comparison would just move the bug.
  ACTUAL=$(docker image inspect --format '{{index .RepoDigests 0}}' "$REF" 2>/dev/null | sed 's/.*@//' | tr -d '\r')
  if [ -z "$ACTUAL" ]; then
    echo "ERROR: could not read a digest for $REF after pulling it." >&2
    exit 1
  fi
  if [ "$ACTUAL" != "$DIGEST" ]; then
    echo "ERROR: digest mismatch for $REF" >&2
    echo "  lock:   $DIGEST" >&2
    echo "  actual: $ACTUAL" >&2
    echo "  The registry served different bits than the lock pins. Refusing to cache it." >&2
    exit 1
  fi

  echo "saving: $TAR"
  docker save -o "$CACHE_NATIVE/${NAME}.tar" "$REF"
done <<< "$IMAGES"

echo
echo "VENDORED. Cache: $CACHE"
echo "Load into minikube before df:sandbox-up:"
echo "  minikube image load $CACHE_NATIVE/<image>.tar"
