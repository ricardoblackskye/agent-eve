# Dark Factory sandbox image (#358).
#
# ADR 0036 makes an image carrying the project a DEPLOYMENT REQUIREMENT: the developer loop writes
# authored files into the workspace and then runs its tests there, so the sandbox needs the repository
# AND its installed dependencies. The default `python:3.12` has no Node toolchain at all.
#
# Dependencies are installed INSIDE the image on purpose: the host's `node_modules` is Windows-native
# and its binaries (esbuild, lightningcss, ...) would be the wrong platform for a Linux sandbox.
#
# .git is included deliberately. The sandbox must already be a work tree, because the run's git flow
# only clones when `rev-parse` says the workspace is not one — and a clone inside the sandbox would
# need a credential the sandbox must not have.
FROM node:24-bookworm

# git performs the run's commit and push; the egress sidecar injects the push credential for it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# Layer the manifest first so a source-only change does not re-install dependencies.
COPY package.json package-lock.json ./
RUN npm ci

# Then the project itself, including .git.
COPY . .

# Keep the container alive: the sandbox is driven over exec, and the SDK assumes a long-lived pod.
CMD ["sleep", "infinity"]
