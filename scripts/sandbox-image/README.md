# Dark Factory sandbox image

The developer loop writes authored files into the sandbox workspace and then runs its tests **there**,
so the sandbox needs the project: the repository *and* its installed dependencies. The default
`DF_SANDBOX_IMAGE` is `python:3.12`, which has neither, so a real run cannot pass its test step
without an image like this one. ADR 0036 records the decision this image implements.

## Build

Run from the repository root: the build context must be the repository, because the image carries it.

```bash
docker build -f scripts/sandbox-image/Dockerfile -t df-sandbox-agent-eve:358 .
```

## Make the image available to the cluster

The local harness runs minikube on the **containerd** runtime, so the image is not automatically
visible to the cluster's own image store. Load it explicitly:

```bash
minikube image load df-sandbox-agent-eve:358
```

For a real deployment, push the image to a registry the cluster can pull from. Avoid the `latest`
tag there: Kubernetes defaults `latest` to `imagePullPolicy: Always`, which would try to pull over a
locally loaded image instead of using it.

## Use it

```bash
DF_SANDBOX_DRIVER=opensandbox
DF_SANDBOX_IMAGE=df-sandbox-agent-eve:358
DF_SANDBOX_USE_SERVER_PROXY=1    # when the client cannot reach sandboxes directly
DF_SANDBOX_VAULT_ENABLED=1       # the vault-injected push token (#354)
DF_SANDBOX_EGRESS_GIT_HOST=<git host>
```

## Verify

`verify-image.ts` drives the REAL driver code against a live control plane and runs the loop's test
command inside a sandbox created from the image. It needs no push token and writes nothing to the
repository, because the vault gate stays off for this check.

```bash
kubectl -n opensandbox-system port-forward svc/opensandbox-server 18082:80
DF_SANDBOX_ENDPOINT=127.0.0.1:18082 DF_SANDBOX_USE_SERVER_PROXY=1 \
  npx tsx scripts/sandbox-image/verify-image.ts --image df-sandbox-agent-eve:358
```

Exit code 0 means the tests executed inside the sandbox. Pass `--command "npx vitest run"` to run the
whole suite exactly as the runner does, which takes roughly three and a half minutes.

## Why the image carries `.git`

The run's git flow probes `git rev-parse --is-inside-work-tree` and clones **only** when the workspace
is not already a work tree. A clone inside the sandbox would need a credential the sandbox must not
possess, so this image ships the repository including `.git`.

## Why dependencies are installed inside the image

`npm ci` runs during the build, on Linux, on purpose. Copying the host's `node_modules` would ship
Windows-native compiled binaries, which a Linux sandbox cannot run.

## Size

Roughly 3 GB, dominated by `node_modules` and `.git`. Adequate for a local end-to-end run; a
deployment would want a slimmer image or a better layer-caching strategy.
