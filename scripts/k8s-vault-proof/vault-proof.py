#!/usr/bin/env python
"""End-to-end proof of OpenSandbox Credential Vault transparent injection.

Proves the property the dark-factory depends on: a sandbox created with
``credentialProxy.enabled=true`` NEVER sees the real secret. The sandbox is given a
placeholder; the egress sidecar MITMs outbound HTTPS and substitutes the real value, so
the upstream receives the secret while the sandbox only ever held the placeholder.

Prerequisites
  - a local cluster bootstrapped by ``bootstrap.sh`` (control plane deployed)
  - ``kubectl -n opensandbox-system port-forward svc/opensandbox-server <PORT>:80``
  - the ``opensandbox`` Python SDK installed (``pip install opensandbox``)

Usage
  python vault-proof.py --port 18082

Exit code 0 means substitution was proven; 1 means it was not.
"""

import argparse
import datetime
import subprocess
import sys

PLACEHOLDER = "__VAULT_SECRET__"
REAL = "REALVAULT-9f3a2b"
HOST = "httpbin.org"


def main():
    # type: () -> int
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=18082)
    parser.add_argument("--domain", default="127.0.0.1")
    parser.add_argument("--namespace", default="opensandbox")
    args = parser.parse_args()

    from opensandbox import SandboxSync
    from opensandbox.config.connection_sync import ConnectionConfigSync
    from opensandbox.models.sandboxes import (
        Credential,
        CredentialBinding,
        CredentialProxyConfig,
        NetworkPolicy,
        NetworkRule,
    )

    # use_server_proxy=True is required locally: the SDK otherwise derives the vault URL
    # from the sandbox endpoint (the ingress-gateway host, e.g. opensandbox.example.com),
    # which does not resolve on the host machine.
    conn = ConnectionConfigSync(
        domain=f"{args.domain}:{args.port}",
        protocol="http",
        api_key=None,
        request_timeout=datetime.timedelta(seconds=300),
        use_server_proxy=True,
    )

    print(f"[1/4] creating sandbox with credentialProxy.enabled (host={HOST}) ...")
    sandbox = SandboxSync.create(
        image="alpine:3.19",
        entrypoint=["sleep", "900"],
        env={"MY_SECRET": PLACEHOLDER},
        credential_proxy=CredentialProxyConfig(enabled=True),
        network_policy=NetworkPolicy(
            default_action="deny",
            egress=[NetworkRule(action="allow", target=HOST)],
        ),
        connection_config=conn,
        skip_health_check=True,
        ready_timeout=datetime.timedelta(seconds=280),
    )
    print(f"       sandbox id: {sandbox.id}")

    print("[2/4] writing the real secret into the vault plus a substitution binding ...")
    state = sandbox.credential_vault.create(
        credentials=[Credential(name="vault-secret", source={"value": REAL})],
        bindings=[
            CredentialBinding(
                name="echo-binding",
                match={
                    "schemes": ["https"],
                    "hosts": [HOST],
                    "methods": ["GET"],
                    "paths": ["/headers"],
                },
                auth={
                    "type": "passthrough",
                    "substitutions": [
                        {
                            "credential": "vault-secret",
                            "placeholder": PLACEHOLDER,
                            "in": ["header"],
                        }
                    ],
                },
            )
        ],
    )
    print(
        f"       vault revision: {state.revision} | credentials: {[c.name for c in sandbox.credential_vault.list_credentials()]} | bindings: {[b.name for b in sandbox.credential_vault.list_bindings()]}"
    )

    print("[3/4] sandbox sends only the placeholder; the upstream should see the secret ...")
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
        (
            "wget -q -O - --timeout=25 --no-check-certificate "
            f"--header='Authorization: Bearer {PLACEHOLDER}' https://{HOST}/headers"
        ),
    ]
    output = subprocess.run(command, check=False, capture_output=True, text=True).stdout
    print(output.strip()[:500])

    proven = f"Bearer {REAL}" in output
    print(
        "[4/4] {}".format(
            "PASS - real secret injected by MITM substitution"
            if proven
            else "FAIL - placeholder was not substituted"
        )
    )

    try:
        sandbox.destroy()
    except Exception:  # noqa: BLE001
        print("warning: sandbox teardown failed; the verdict above still stands")
    return 0 if proven else 1


if __name__ == "__main__":
    sys.exit(main())
