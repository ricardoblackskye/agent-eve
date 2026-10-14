# Dark Factory sandbox image (#358).
#
# ADR 0036 makes an image carrying the project a DEPLOYMENT REQUIREMENT: the developer loop writes
# authored files into the workspace and then runs its tests there, so the sandbox needs the repository
# AND its installed dependencies. The default `python:3.12` has no Node toolchain at all.
#
# Dependencies are installed INSIDE the image on purpose: the host's `node_modules` is Windows-native,
# so its compiled native binaries would be the wrong platform for a Linux sandbox.
#
# .git is included deliberately. The sandbox must already be a work tree, because the run's git flow
# only clones when `rev-parse` says the workspace is not one — and a clone inside the sandbox would
# need a credential the sandbox must not have. It also carries the commit identity, so the sandbox does
# not depend on a HOME-directory gitconfig.
FROM node:24-bookworm

# git performs the run's commit and push; the egress sidecar injects the push credential for it.
# Versions are pinned to satisfy DL3008 and the apt-pin policy check: a rebuild then fails LOUDLY when
# Debian rotates one of these, instead of silently changing what the sandbox contains.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git=1:2.39.5-0+deb12u3 \
    ca-certificates=20250419~deb12u1 \
  && rm -rf /var/lib/apt/lists/*

# The workspace is created while the image still builds as root, so the unprivileged user below can
# install into it without a recursive chown over node_modules (which doubles the image size).
RUN mkdir -p /workspace && chown node:node /workspace

WORKDIR /workspace

# Layer the manifest first so a source-only change does not re-install dependencies.
COPY --chown=node:node package.json package-lock.json ./

# Everything below runs as the unprivileged `node` user: the sandbox never needs root, and the code it
# executes is authored by a model, so it should hold no privileges beyond its own workspace.
USER node
RUN npm ci

# Then the project itself, including .git.
COPY --chown=node:node . .

# The OpenSandbox runtime drives this container over exec and reports its own health; this check only
# asserts that the toolchain the loop depends on is present.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD git --version && node --version || exit 1

# Keep the container alive: the sandbox is driven over exec, and the SDK assumes a long-lived pod.
CMD ["sleep", "infinity"]
