#!/usr/bin/env python
# pyright: reportMissingImports=false
# pylint: disable=import-error
"""Measure OpenSandbox cold-start latency against a local cluster.

Two numbers, timed against the live local cluster the same way the vault
proof (``vault-proof.py``) runs:

  - create-to-ready : wall time from the ``SandboxSync.create()`` call until
                      the sandbox reports ready (pod scheduling + container
                      start).
  - first-command   : wall time from issuing the first command until it
                      returns - i.e. time until the sandbox is actually
                      usable.

Usage
  python measure-cold-start.py --port 18082

Exit codes
  0  measurement completed and create-to-ready is within the threshold.
  2  create-to-ready exceeded the regression threshold (likely regression).
  1  measurement could not be taken (cluster unreachable, sandbox failed, ...).

MEASUREMENT CONDITIONS (the baseline below only holds under these)
  - a WARM cluster: control plane already deployed by ``bootstrap.sh`` and the
    opensandbox-server port-forwarded (see README.md).
  - the image is PRE-LOADED into containerd (e.g. ``npm run df:sandbox-vendor``
    / ``minikube image load``): pod scheduling and container start only, NO
    registry pull.
  - baseline measured with image ``df-sandbox-agent-eve:358`` (3.12 GB,
    pre-built and pre-loaded) on minikube.

BASELINE (also recorded in docs/pages/dark-factory-local-runs.md, guarded by
tests/dark-factory/cold-start-docs.test.ts)
  | Run | create-to-ready | first-command | Notes                       |
  | --- | ---            | ---           | ---                         |
  | 1   | 3.02s          | 0.33s         | health check skipped        |
  | 2   | 2.63s          | 0.28s         | health check skipped        |
  | 3   | 2.41s          | 0.28s         | health check enabled (default) |
  Median create-to-ready ~= 2.63s, range 2.41-3.02s.
  First-command range 0.28-0.33s.

REGRESSION THRESHOLD
  create-to-ready is flagged if it exceeds REGRESSION_THRESHOLD_S = 15.0
  (~5x the 2.63s median): enough headroom for cluster variance, tight enough
  to catch an order-of-magnitude drift (image change, scheduling-policy change,
  resource-request bump). Enforced at runtime - the script exits 2 when breached.

NOT a CI gate: cold start needs a live cluster, which CI does not have. Run this
periodically against a local cluster.
"""

# Fixed argv subprocess calls use shell=False with no untrusted interpolation, so
# the generic subprocess warnings are suppressed.
import argparse
import datetime
import subprocess  # nosec B404
import sys
import time

REGRESSION_THRESHOLD_S = 15.0
DEFAULT_IMAGE = "alpine:3.19"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Measure OpenSandbox cold-start latency against a local cluster."
    )
    parser.add_argument("--port", type=int, default=18082)
    parser.add_argument("--domain", default="127.0.0.1")
    parser.add_argument("--namespace", default="opensandbox")
    parser.add_argument("--image", default=DEFAULT_IMAGE)
    parser.add_argument(
        "--skip-health-check",
        action="store_true",
        help="skip the sandbox health check (matches the 2.63s median baseline runs)",
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=REGRESSION_THRESHOLD_S,
        help="create-to-ready regression threshold in seconds (default 15.0)",
    )
    args = parser.parse_args()

    from opensandbox import SandboxSync
    from opensandbox.config.connection_sync import ConnectionConfigSync

    # use_server_proxy=True is required locally: the SDK otherwise derives the
    # vault URL from the sandbox endpoint (the ingress-gateway host), which does
    # not resolve from the host machine. Mirrors vault-proof.py.
    conn = ConnectionConfigSync(
        domain=f"{args.domain}:{args.port}",
        protocol="http",
        api_key=None,
        request_timeout=datetime.timedelta(seconds=300),
        use_server_proxy=True,
    )

    print("[1/3] creating sandbox (timing create-to-ready) ...")
    t0 = time.perf_counter()
    sandbox = SandboxSync.create(
        image=args.image,
        entrypoint=["sleep", "900"],
        connection_config=conn,
        skip_health_check=args.skip_health_check,
        ready_timeout=datetime.timedelta(seconds=280),
    )
    create_to_ready = time.perf_counter() - t0
    print(f"       sandbox id: {sandbox.id} | create-to-ready: {create_to_ready:.2f}s")

    print("[2/3] running first command (timing first-command latency) ...")
    pod = f"{sandbox.id}-0"
    command = [
        "kubectl",
        "-n",
        args.namespace,
        "exec",
        pod,
        "-c",
        "sandbox",
        "--",
        "sh",
        "-c",
        "echo ready",
    ]
    # Fixed argv list with shell=False and no untrusted interpolation.
    t1 = time.perf_counter()
    completed = subprocess.run(  # nosec B603
        command, check=False, capture_output=True, text=True
    )
    first_command = time.perf_counter() - t1
    if completed.returncode != 0:
        print(f"       first-command FAILED: {completed.stderr.strip()[:300]}")
        _destroy(sandbox)
        return 1
    print(f"       first-command: {first_command:.2f}s")

    print("[3/3] summary")
    print(f"       create-to-ready: {create_to_ready:.2f}s "
          f"(threshold {args.threshold:.2f}s)")
    print(f"       first-command:   {first_command:.2f}s")

    _destroy(sandbox)

    if create_to_ready > args.threshold:
        print(
            f"REGRESSION: create-to-ready {create_to_ready:.2f}s exceeds "
            f"threshold {args.threshold:.2f}s (~5x the 2.63s median)"
        )
        return 2
    print("OK: within baseline range")
    return 0


def _destroy(sandbox) -> None:
    try:
        sandbox.destroy()
    except Exception:  # noqa: BLE001
        print("warning: teardown failed; the measurement above still stands")


if __name__ == "__main__":
    sys.exit(main())
