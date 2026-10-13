/**
 * #281 (R2) T0 — smoke-proof the sandbox platform from OUR client path.
 *
 * Proves the whole platform works before any seam code exists: create -> run a command -> write and
 * read a file -> tear down. It exists so "the sandbox is up" is a measured fact rather than an
 * assumption, and so the bring-up is reproducible on any host.
 *
 *   npx tsx scripts/sandbox-smoke.ts
 *
 * Env: DF_SANDBOX_ENDPOINT (host[:port], default 127.0.0.1:8080), DF_SANDBOX_PROTOCOL (http|https),
 * OPEN_SANDBOX_API_KEY (only if the server was started with a key), DF_SANDBOX_IMAGE,
 * DF_SANDBOX_TIMEOUT_SECONDS.
 *
 * Teardown note: the JavaScript SDK tears a sandbox down with kill() + close(). Closing alone does
 * NOT terminate the remote sandbox — an orphan is both a leak and spend, so both are called, and the
 * failure path calls them too.
 */
import { ConnectionConfig, Sandbox, SandboxException, type Sandbox as SandboxHandle } from "@alibaba-group/opensandbox";

const endpoint = (process.env.DF_SANDBOX_ENDPOINT ?? "127.0.0.1:8080").trim();
const protocol = (process.env.DF_SANDBOX_PROTOCOL ?? "http").trim();
const apiKey = (process.env.OPEN_SANDBOX_API_KEY ?? "").trim();
const image = (process.env.DF_SANDBOX_IMAGE ?? "python:3.12").trim();
const timeoutSeconds = Number.parseInt(process.env.DF_SANDBOX_TIMEOUT_SECONDS ?? "600", 10);
// Sandbox CREATE is a long-running call: on a cold host it pulls the workload image AND injects the
// execd image. The SDK's default request timeout (30s) is far too short for that — observed as
// "[http] Request timed out (timeoutSeconds=30)" on the very first create. This bounds the CLIENT
// request; the sandbox's own lifetime is timeoutSeconds above.
const requestTimeoutSeconds = Number.parseInt(
  process.env.DF_SANDBOX_REQUEST_TIMEOUT_SECONDS ?? "180",
  10,
);

function step(message: string): void {
  console.log(`  -> ${message}`);
}

async function main(): Promise<void> {
  console.log(`OpenSandbox smoke: ${protocol}://${endpoint} (image ${image}, timeout ${timeoutSeconds}s)`);

  const connectionConfig = new ConnectionConfig({
    domain: endpoint,
    protocol: protocol as "http" | "https",
    requestTimeoutSeconds,
    ...(apiKey ? { apiKey } : {}),
  });

  let sandbox: SandboxHandle | undefined;
  try {
    step("creating sandbox");
    sandbox = await Sandbox.create({ connectionConfig, image, timeoutSeconds });
    step(`created ${String(sandbox.id)}`);

    step("running a command");
    const execution = await sandbox.commands.run("python -c 'print(41 + 1)'");
    const stdout = execution.logs.stdout.map((line) => line.text).join("");
    if (!stdout.includes("42")) {
      throw new Error(`command did not return 42; stdout was ${JSON.stringify(stdout)}`);
    }
    step(`command returned ${stdout.trim()}`);

    step("writing and reading a file inside the sandbox");
    const path = "/tmp/df-sandbox-smoke.txt";
    const payload = "wrote from the Dark Factory smoke test";
    await sandbox.files.writeFiles([{ path, data: payload }]);
    const readBack = await sandbox.files.readFile(path);
    const text = typeof readBack === "string" ? readBack : String(readBack);
    if (!text.includes(payload)) {
      throw new Error(`file round-trip mismatch: ${JSON.stringify(text)}`);
    }
    step("file round-trip verified");

    console.log("SMOKE OK");
  } finally {
    if (sandbox) {
      step("terminating sandbox (kill + close)");
      await sandbox.kill().catch((error: unknown) => {
        console.error(`  !! kill failed: ${String(error)}`);
      });
      await sandbox.close().catch(() => undefined);
    }
  }
}

main().catch((error: unknown) => {
  if (error instanceof SandboxException) {
    console.error(`SMOKE FAILED: [${error.error.code}] ${error.error.message ?? ""}`);
    if (error.requestId) console.error(`request id: ${error.requestId}`);
  } else {
    console.error(`SMOKE FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exit(1);
});
