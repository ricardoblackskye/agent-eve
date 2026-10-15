/**
 * #358 — verify that a sandbox built from our image can run the developer loop's TEST STEP.
 *
 * This is the check #354 could not make: the default `python:3.12` image carries neither the
 * repository nor a Node toolchain, so the loop's `npx vitest run` could never run inside the sandbox.
 * This drives the REAL driver code (`createOpenSandboxProvider` + `createLiveSandbox`) against a live
 * OpenSandbox control plane and runs the tests where the loop would run them.
 *
 * It deliberately does NOT enable the credential vault: this is about the image, so it needs no push
 * token, spends nothing, and writes nothing to the repository.
 *
 * Prerequisites
 *   - the image built and LOADED into the cluster (see README.md in this directory)
 *   - a port-forward to the control plane:
 *       kubectl -n opensandbox-system port-forward svc/opensandbox-server 18082:80
 *
 * Usage
 *   DF_SANDBOX_ENDPOINT=127.0.0.1:18082 DF_SANDBOX_USE_SERVER_PROXY=1 \
 *     npx tsx scripts/sandbox-image/verify-image.ts \
 *       --image df-sandbox-agent-eve:358 [--command "npx vitest run"]
 *
 * Exit code 0 means the tests executed inside the sandbox; 1 means they did not.
 */
import {
  createLiveSandbox,
  createOpenSandboxProvider,
} from "../../agent/lib/dark-factory/opensandbox-driver";

/** One file is the fast signal; the runner itself runs the whole suite. */
const DEFAULT_COMMAND =
  "npx vitest run tests/dark-factory/opensandbox-driver.test.ts";
const WORKSPACE = "/workspace";

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  return at !== -1 && argv[at + 1] ? argv[at + 1] : undefined;
}

async function main(): Promise<number> {
  const image = flag(process.argv, "image") ?? "df-sandbox-agent-eve:358";
  const command = flag(process.argv, "command") ?? DEFAULT_COMMAND;

  const provider = createOpenSandboxProvider(
    {
      DF_SANDBOX_IMAGE: image,
      DF_SANDBOX_TIMEOUT_SECONDS: "900",
      DF_SANDBOX_WORKSPACE: WORKSPACE,
    },
    { createSandbox: createLiveSandbox },
  );

  console.log(`image:   ${image}`);
  console.log(`command: ${command}`);
  const tools = provider.create(WORKSPACE);

  // try/finally, not a trailing call: a rejected command (the runTests allowlist refuses anything
  // that is not a test command) threw straight past a bare dispose() and left a Sandbox object
  // running in the cluster. Observed, not hypothetical.
  try {
    console.log("[1] is the project present in the image?");
    const manifest = await tools.listFiles("package.json");
    const lockfile = await tools.listFiles("package-lock.json");
    console.log(
      `    package.json: ${JSON.stringify(manifest)} | package-lock.json: ${JSON.stringify(lockfile)}`,
    );

    console.log("[2] running the loop's test step INSIDE the sandbox ...");
    const result = await tools.runTests(command);
    console.log(`    passed: ${result.passed}`);
    console.log(`    output tail:\n${result.output.slice(-1400)}`);

    console.log(
      result.passed
        ? "[3] PASS - the tests executed inside the sandbox"
        : "[3] FAIL - the tests did not run inside the sandbox",
    );
    return result.passed ? 0 : 1;
  } finally {
    await provider.dispose?.();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(
      `VERIFY ERROR: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  });
