import { extname } from "node:path";

import { ConnectionConfig, Sandbox } from "@alibaba-group/opensandbox";

import {
  ALLOWED_TEST_COMMAND_PREFIXES,
  ALLOWED_WORKSPACE_EXTENSIONS,
  InvalidTaskError,
  type WorkspaceTools,
} from "./developer-agent";
import { SandboxRefusedError, type SandboxProvider } from "./sandbox";

/**
 * #281 (R2) T4 — the live sandbox execution driver.
 *
 * Runs generated code and tests INSIDE an OpenSandbox instead of the runner's own filesystem, behind
 * the same `WorkspaceTools` interface and the same guards. The guards are re-applied here because
 * moving the backend must not move the security boundary: a command or extension that the local path
 * refuses must not become runnable merely because it now happens in a container.
 *
 * The slice of the SDK used here is declared STRUCTURALLY, so tests drive the driver with a fake and
 * need neither a live sandbox nor a credential.
 */

export interface SandboxHandle {
  readonly id: string;
  commands: {
    run(command: string): Promise<{
      exitCode?: number;
      logs: { stdout: { text: string }[]; stderr: { text: string }[] };
    }>;
  };
  files: {
    readFile(path: string): Promise<unknown>;
    writeFiles(entries: { path: string; data: string }[]): Promise<void>;
    listDirectory(entry: {
      path: string;
      depth?: number;
    }): Promise<{ path: string; type?: string; name?: string }[]>;
  };
  kill(): Promise<void>;
  close(): Promise<void>;
}

export interface SandboxNetworkPolicy {
  defaultAction: "allow" | "deny";
  egress: { action: "allow" | "deny"; target: string }[];
}

export interface SandboxCreateSpec {
  image: string;
  timeoutSeconds: number;
  networkPolicy: SandboxNetworkPolicy;
  /**
   * #282 (R3) — when set, the sandbox requests the OpenSandbox credential proxy so outbound calls
   * carry a PLACEHOLDER that the egress sidecar substitutes with the real credential. OMITTED unless
   * the operator opted in, so secret injection is never enabled by accident.
   */
  credentialProxy?: { enabled: true } | undefined;
  /** Run-scoped label so orphans can be reaped by run id (T5b/B4). Optional for non-run contexts. */
  metadata?: Record<string, string> | undefined;
}

export interface OpenSandboxDriverDeps {
  /** Creates the sandbox. Injected so the driver is testable with no live sandbox. */
  createSandbox(spec: SandboxCreateSpec): Promise<SandboxHandle>;
  /** Run-scoped label attached to the created sandbox; enables reaping by run id. */
  metadata?: Record<string, string> | undefined;
}

export interface OpenSandboxDriverEnv {
  DF_SANDBOX_IMAGE?: string | undefined;
  DF_SANDBOX_TIMEOUT_SECONDS?: string | undefined;
  DF_SANDBOX_EGRESS_ALLOW?: string | undefined;
  DF_SANDBOX_EGRESS_GATEWAY_HOST?: string | undefined;
  DF_SANDBOX_EGRESS_GIT_HOST?: string | undefined;
  DF_SANDBOX_WORKSPACE?: string | undefined;
  /** #282 (R3) — opt-in gate for the OpenSandbox credential proxy. Unset/blank = today's behaviour. */
  DF_SANDBOX_VAULT_ENABLED?: string | undefined;
}

export const DEFAULT_SANDBOX_WORKSPACE = "/workspace";

/**
 * Recursion depth for listings. Verified against a live sandbox: the API returns entries as
 * `{ path, type, ... }` — there is NO `name` field — and a shallow depth returns only the immediate
 * directory, so a pattern like `*.ts` would miss nested files entirely.
 */
export const SANDBOX_LIST_DEPTH = 10;

/**
 * Egress is DENY by default and allows ONLY what is listed. The gateway host is the only intended
 * destination, so a missing base-URL override cannot silently reach a provider and spend.
 */
export function sandboxNetworkPolicy(
  env: OpenSandboxDriverEnv,
): SandboxNetworkPolicy {
  const explicit = (env.DF_SANDBOX_EGRESS_ALLOW ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  // The gateway is the only intended destination for the sandbox CLI (its base-URL override points
  // here). It is ALWAYS allowed so an operator mistake in the allow-list cannot silently open egress
  // to a model provider. The git host is allowed only when explicitly configured.
  const targets = new Set<string>();
  const gatewayHost = env.DF_SANDBOX_EGRESS_GATEWAY_HOST?.trim();
  const gitHost = env.DF_SANDBOX_EGRESS_GIT_HOST?.trim();
  if (gatewayHost) targets.add(gatewayHost);
  if (gitHost) targets.add(gitHost);
  for (const target of explicit) targets.add(target);
  return {
    defaultAction: "deny",
    egress: [...targets].map((target) => ({
      action: "allow" as const,
      target,
    })),
  };
}

/**
 * #282 (R3) — the credential-proxy gate is OPT-IN and fail-closed: only a non-blank
 * `DF_SANDBOX_VAULT_ENABLED` turns it on, so an unset variable keeps today's behaviour and a
 * deployment that never asked for the vault path cannot have secrets injected into its sandboxes.
 */
export function vaultEnabled(env: OpenSandboxDriverEnv): boolean {
  return (env.DF_SANDBOX_VAULT_ENABLED ?? "").trim().length > 0;
}

function joinInsideWorkspace(root: string, relPath: string): string {
  if (
    relPath.startsWith("/") ||
    /^[A-Za-z]:/.test(relPath) ||
    relPath.includes("\0")
  ) {
    throw new InvalidTaskError(
      `Path '${relPath}' must be relative to the sandbox workspace.`,
    );
  }
  if (relPath.split(/[\\/]+/).includes("..")) {
    throw new InvalidTaskError(
      `Path '${relPath}' escapes the sandbox workspace; rejected.`,
    );
  }
  return `${root.replace(/\/$/, "")}/${relPath}`;
}

function assertAllowedExtension(relPath: string): void {
  const ext = extname(relPath).toLowerCase();
  if (!ALLOWED_WORKSPACE_EXTENSIONS.has(ext)) {
    throw new InvalidTaskError(
      `Extension '${ext}' is not allowed in the workspace.`,
    );
  }
}

function assertAllowedTestCommand(command: string): void {
  const allowed = ALLOWED_TEST_COMMAND_PREFIXES.some(
    (prefix) => command === prefix || command.startsWith(`${prefix} `),
  );
  if (!allowed) {
    throw new InvalidTaskError(
      `Command '${command}' is not allowed. Only test commands starting with [${ALLOWED_TEST_COMMAND_PREFIXES.join(", ")}] are permitted.`,
    );
  }
}

/**
 * #354 — arguments that may pass through the sandbox shell BARE. `*`, `~` and every quoting
 * metacharacter are absent, so an argument matching this needs no quoting; everything else is
 * single-quoted by `shellQuote`.
 */
const SAFE_GIT_ARG = /^[A-Za-z0-9._/@:^+-]+$/;

/**
 * POSIX single-quoting: inside `'...'` every character is literal, so the sandbox shell cannot act on
 * a metacharacter. An embedded single quote is closed, escaped and reopened (`'\''`) — the only
 * sequence that can leave the quoted word.
 */
function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * #354 — the arguments are interpolated into ONE shell command, so each is either provably safe and
 * passed bare, or single-quoted. This cannot be a blanket REJECT: a commit message legitimately
 * carries spaces, `:` and `#`. Only what no shell word can represent (a NUL byte) is refused.
 */
function assertQuotableGitArgs(args: string[]): void {
  if (args.length === 0) {
    throw new InvalidTaskError("git requires at least one argument; refusing an empty call.");
  }
  for (const arg of args) {
    if (arg.includes("\0")) {
      throw new InvalidTaskError(
        "git argument contains a NUL byte and cannot be passed to the sandbox shell.",
      );
    }
  }
}

/** Minimal glob: `*` and `?` only, which is all the workspace listing needs. */
export function matchesPattern(pattern: string, name: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(name);
}

/**
 * The live SDK wiring. Kept beside the driver so the fake used in tests and the real handle are
 * visibly the same contract. The SDK's own types are richer than the slice declared above; the small
 * casts below map that richness down to what this driver uses, rather than widening our interface.
 */
/** Builds the lifecycle-API connection config from the environment. Shared by the live driver and the reaper. */
export function sandboxConnectionConfig(): ConnectionConfig {
  const domain = (process.env.DF_SANDBOX_ENDPOINT ?? "127.0.0.1:8080").trim();
  const protocol = (process.env.DF_SANDBOX_PROTOCOL ?? "http").trim();
  const apiKey = (process.env.OPEN_SANDBOX_API_KEY ?? "").trim();
  const requestTimeoutSeconds = Number.parseInt(
    process.env.DF_SANDBOX_REQUEST_TIMEOUT_SECONDS ?? "180",
    10,
  );
  return new ConnectionConfig({
    domain,
    protocol: protocol as "http" | "https",
    requestTimeoutSeconds,
    ...(apiKey ? { apiKey } : {}),
  });
}

export async function createLiveSandbox(
  spec: SandboxCreateSpec,
): Promise<SandboxHandle> {
  const createOptions = {
    connectionConfig: sandboxConnectionConfig(),
    image: spec.image,
    timeoutSeconds: spec.timeoutSeconds,
    // Deny-by-default egress: the SDK's own default is "deny", so widening is always explicit.
    networkPolicy: spec.networkPolicy,
    // #282 (R3): only present when the operator opted in; the SDK's default is off.
    ...(spec.credentialProxy ? { credentialProxy: spec.credentialProxy } : {}),
    ...(spec.metadata ? { metadata: spec.metadata } : {}),
  };
  // The SDK types rules as open records and accepts more than this driver sets; the assertion maps our
  // structural subset onto its richer type without widening what we actually send.
  const sandbox = await Sandbox.create(
    createOptions as unknown as Parameters<typeof Sandbox.create>[0],
  );

  const readLines = (lines: unknown): { text: string }[] =>
    Array.isArray(lines)
      ? lines.map((line) => ({
          text: String((line as { text?: unknown })?.text ?? ""),
        }))
      : [];

  return {
    id: String((sandbox as unknown as { id?: unknown }).id ?? ""),
    commands: {
      run: async (command: string) => {
        const execution = await sandbox.commands.run(command);
        const logs = (
          execution as unknown as {
            logs?: { stdout?: unknown; stderr?: unknown };
          }
        ).logs;
        return {
          exitCode: (execution as unknown as { exitCode?: number }).exitCode,
          logs: {
            stdout: readLines(logs?.stdout),
            stderr: readLines(logs?.stderr),
          },
        };
      },
    },
    files: {
      readFile: async (path: string) => await sandbox.files.readFile(path),
      writeFiles: async (entries) => {
        await sandbox.files.writeFiles(entries as never);
      },
      listDirectory: async (entry) =>
        (await sandbox.files.listDirectory(entry)) as unknown as {
          path: string;
          name?: string;
        }[],
    },
    kill: async () => {
      await sandbox.kill();
    },
    close: async () => {
      await sandbox.close();
    },
  };
}

export function createOpenSandboxProvider(
  env: OpenSandboxDriverEnv = {
    DF_SANDBOX_IMAGE: process.env.DF_SANDBOX_IMAGE,
    DF_SANDBOX_TIMEOUT_SECONDS: process.env.DF_SANDBOX_TIMEOUT_SECONDS,
    DF_SANDBOX_EGRESS_ALLOW: process.env.DF_SANDBOX_EGRESS_ALLOW,
    DF_SANDBOX_EGRESS_GATEWAY_HOST: process.env.DF_SANDBOX_EGRESS_GATEWAY_HOST,
    DF_SANDBOX_EGRESS_GIT_HOST: process.env.DF_SANDBOX_EGRESS_GIT_HOST,
    DF_SANDBOX_WORKSPACE: process.env.DF_SANDBOX_WORKSPACE,
    DF_SANDBOX_VAULT_ENABLED: process.env.DF_SANDBOX_VAULT_ENABLED,
  },
  deps: OpenSandboxDriverDeps,
): SandboxProvider {
  const image = (env.DF_SANDBOX_IMAGE ?? "python:3.12").trim();
  const timeoutSeconds = Number.parseInt(
    env.DF_SANDBOX_TIMEOUT_SECONDS ?? "900",
    10,
  );
  const networkPolicy = sandboxNetworkPolicy(env);
  const credentialProxy = vaultEnabled(env)
    ? ({ enabled: true } as const)
    : undefined;
  let pending: Promise<SandboxHandle> | undefined;
  let disposed = false;

  /** Created lazily, once per run: cold start (image pull + execd injection) is per RUN, not per file. */
  const sandbox = (): Promise<SandboxHandle> => {
    if (disposed) throw new SandboxRefusedError("sandbox was already disposed");
    pending ??= deps.createSandbox({
      image,
      timeoutSeconds,
      networkPolicy,
      ...(credentialProxy ? { credentialProxy } : {}),
      ...(deps.metadata ? { metadata: deps.metadata } : {}),
    });
    return pending;
  };

  // #354 — in-sandbox git exists ONLY on the vault path: the egress sidecar supplies the credential,
  // so the sandbox runs a bare command. Every other driver keeps the host-side push unchanged.
  const gitCapability: Pick<SandboxProvider, "runGit"> = vaultEnabled(env)
    ? {
        runGit: async (args: string[]) => {
          // Validate BEFORE creating or touching the sandbox, so a refused call costs nothing.
          assertQuotableGitArgs(args);
          const handle = await sandbox();
          // Safe args stay readable; anything else is single-quoted, never interpolated raw.
          const command = args
            .map((arg) => (SAFE_GIT_ARG.test(arg) ? arg : shellQuote(arg)))
            .join(" ");
          // GIT_TERMINAL_PROMPT=0: git must never block on a credential prompt it cannot answer — the
          // credential arrives as a header the egress sidecar injects.
          const execution = await handle.commands.run(
            `GIT_TERMINAL_PROMPT=0 git ${command}`,
          );
          const stdout = execution.logs.stdout
            .map((line) => line.text)
            .join("");
          const stderr = execution.logs.stderr
            .map((line) => line.text)
            .join("");
          // An unreadable exit code is NOT a pass.
          return {
            exitCode: execution.exitCode ?? 1,
            output: stdout || stderr,
          };
        },
      }
    : {};

  return {
    driver: "opensandbox",
    isolated: true,
    ...gitCapability,
    create: (workspaceDir: string): WorkspaceTools => {
      const root = (
        workspaceDir ||
        env.DF_SANDBOX_WORKSPACE ||
        DEFAULT_SANDBOX_WORKSPACE
      ).trim();
      return {
        readFile: async (relPath: string): Promise<string> => {
          const handle = await sandbox();
          return String(
            await handle.files.readFile(joinInsideWorkspace(root, relPath)),
          );
        },
        writeFile: async (relPath: string, content: string): Promise<void> => {
          // Guard BEFORE creating or touching the sandbox, so a refused write costs nothing.
          assertAllowedExtension(relPath);
          const target = joinInsideWorkspace(root, relPath);
          const handle = await sandbox();
          await handle.files.writeFiles([{ path: target, data: content }]);
        },
        listFiles: async (pattern?: string): Promise<string[]> => {
          const handle = await sandbox();
          const entries = await handle.files.listDirectory({
            path: root,
            depth: SANDBOX_LIST_DEPTH,
          });
          const prefix = `${root.replace(/\/$/, "")}/`;
          const names = entries
            // Directories are not files, and the local path never returned them.
            .filter((entry) => entry.type !== "directory")
            .map((entry) =>
              entry.path.startsWith(prefix)
                ? entry.path.slice(prefix.length)
                : entry.path,
            )
            .filter((name) => name.length > 0);
          return pattern
            ? names.filter((name) => matchesPattern(pattern, name))
            : names;
        },
        runTests: async (
          cmd?: string,
        ): Promise<{ passed: boolean; output: string }> => {
          const command = (
            cmd ??
            ALLOWED_TEST_COMMAND_PREFIXES[0] ??
            "npx vitest"
          ).trim();
          assertAllowedTestCommand(command);
          const handle = await sandbox();
          const execution = await handle.commands.run(command);
          const stdout = execution.logs.stdout
            .map((line) => line.text)
            .join("");
          const stderr = execution.logs.stderr
            .map((line) => line.text)
            .join("");
          // An unknown exit code is NOT a pass: never report success for a command whose outcome we
          // could not read.
          return { passed: execution.exitCode === 0, output: stdout || stderr };
        },
      };
    },
    /**
     * Teardown. Never throws: it runs in a `finally`, and a teardown failure must not mask the error
     * that caused the cleanup. Idempotent, because a caller may `dispose()` defensively.
     */
    dispose: async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      const handle = await pending?.catch(() => undefined);
      if (!handle) return;
      await handle.kill().catch(() => undefined);
      await handle.close().catch(() => undefined);
    },
  };
}
