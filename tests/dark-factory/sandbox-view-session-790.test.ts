import { describe, expect, it, vi } from "vitest";
import {
  isLocalSandboxEndpoint,
  openSandboxView,
  type SandboxManagerLike,
  type SandboxViewClient,
} from "../../agent/lib/dark-factory/sandbox-view";

/**
 * #790 R1 (#791) - reaching a live LOCAL sandbox, read-only (tasks 4 and 6).
 *
 * Route B is served by the console the operator already has open, so two things it does NOT do are as load-bearing as
 * the thing it does:
 *
 *   AC3 - it must not offer a view of a sandbox this machine cannot reach directly. A remote or cluster endpoint
 *         answers "not-local", and the sandbox server is never even called: a deployed console has nothing to point
 *         at, so it must not hang trying.
 *
 *   AC5 - it must not hold anything open. Each request re-derives the view from the live sandbox list, answers
 *         "the view has ended" when there is none, and releases ONLY the client transport it opened - never the run's
 *         sandbox, which belongs to the run.
 *
 * The fake manager carries a throwing `killSandbox` on purpose: the type the view accepts has no kill operation, and
 * this proves the implementation cannot have reached for the real one either.
 */

const LOCAL_ENDPOINT = "127.0.0.1:18082";

function managerReturning(ids: string[]) {
  const calls: Array<{ metadata?: Record<string, string>; states?: string[] }> = [];
  const listSandboxInfos = vi.fn(
    async (filter?: { metadata?: Record<string, string>; states?: string[] }) => {
      calls.push({ metadata: filter?.metadata, states: filter?.states });
      return { items: ids.map((id) => ({ id })) };
    },
  );
  const killSandbox = vi.fn(async () => {
    throw new Error("the view must never touch the run's sandbox lifecycle");
  });
  return {
    manager: { listSandboxInfos, killSandbox } as unknown as SandboxManagerLike,
    calls,
    listSandboxInfos,
    killSandbox,
  };
}

function connectStub() {
  const closed: number[] = [];
  const client = {
    files: {
      listDirectory: async () => [{ path: "src/App.tsx", type: "file", name: "App.tsx" }],
      readFile: async (path: string) => `contents of ${path}`,
    },
    close: async () => {
      closed.push(closed.length + 1);
    },
  } as unknown as SandboxViewClient;
  return { client, closed };
}

const env = (overrides: Record<string, string | undefined> = {}) => ({
  DF_SANDBOX_ENDPOINT: LOCAL_ENDPOINT,
  ...overrides,
});

describe("#790 R1 AC3 - only a local endpoint yields a view", () => {
  it("treats every loopback form the endpoint may arrive in as local", () => {
    for (const endpoint of [
      "127.0.0.1:18082",
      "127.0.0.1",
      "localhost:18082",
      "http://localhost:18082",
      "[::1]:18082",
      "::1",
      // Unset is the driver's own default (`127.0.0.1:8080`), and blank is unset spelled badly.
      undefined,
      "   ",
    ]) {
      expect(isLocalSandboxEndpoint(endpoint), String(endpoint)).toBe(true);
    }
  });

  it("does not treat a remote, a wildcard or a private address as local", () => {
    for (const endpoint of [
      "sandbox.example.com:443",
      "https://sandbox.example.com",
      "10.1.2.3:8080",
      // A listen-all address is not a place to connect to; treating it as local is the exact mistake AC3 is about.
      "0.0.0.0:18082",
    ]) {
      expect(isLocalSandboxEndpoint(endpoint), endpoint).toBe(false);
    }
  });
});

describe("#790 R1 task 4 - the view is offered when, and only when, a live local sandbox exists", () => {
  it("reads the run's live sandbox, found by the run label", async () => {
    const { manager, calls } = managerReturning(["sb-live-1"]);
    const { client } = connectStub();

    const result = await openSandboxView({
      runId: "run-7",
      env: env(),
      manager,
      connect: async () => client,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.sandboxId).toBe("sb-live-1");
    expect(result.session.workspace).toBe("/workspace");
    // The run's own label, and a RUNNING filter: a paused sandbox is not being observed, and a deleted one cannot be.
    expect(calls[0]?.metadata).toEqual({ run: "run-7" });
    expect(calls[0]?.states).toEqual(["Running"]);
    expect(await result.session.reader.files.listDirectory({ path: "/workspace" })).toHaveLength(1);
  });

  it("answers not-local for a remote endpoint WITHOUT reaching the sandbox server", async () => {
    const { manager, listSandboxInfos } = managerReturning(["sb-remote"]);

    const result = await openSandboxView({
      runId: "run-7",
      env: env({ DF_SANDBOX_ENDPOINT: "sandbox.example.com:443" }),
      manager,
      connect: async () => {
        throw new Error("connect must not be reached for a remote endpoint");
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not-local");
    expect(listSandboxInfos).not.toHaveBeenCalled();
  });

  it("answers that the view has ended when the run has no live sandbox, and connects to nothing", async () => {
    const { manager } = managerReturning([]);
    const connect = vi.fn(async () => {
      throw new Error("connect must not be reached without a live sandbox");
    });

    const result = await openSandboxView({ runId: "run-7", env: env(), manager, connect });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no-live-sandbox");
    // AC5 asks for a sentence, not a hang: the operator has to be able to tell "it finished" from "it broke".
    expect(result.message).toMatch(/ended|no longer running/i);
    expect(connect).not.toHaveBeenCalled();
  });

  it("reports an unreachable sandbox server instead of throwing", async () => {
    const listSandboxInfos = vi.fn(async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:18082");
    });

    const result = await openSandboxView({
      runId: "run-7",
      env: env(),
      manager: { listSandboxInfos } as unknown as SandboxManagerLike,
      connect: async () => {
        throw new Error("connect must not be reached");
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unreachable");
    expect(result.message).toMatch(/127\.0\.0\.1:18082/);
  });

  it("reports a failed connect instead of throwing", async () => {
    const { manager } = managerReturning(["sb-live-1"]);

    const result = await openSandboxView({
      runId: "run-7",
      env: env(),
      manager,
      connect: async () => {
        throw new Error("execd endpoint never came up");
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unreachable");
  });

  it("lists the workspace the run was configured with, not a hardcoded one", async () => {
    const { manager } = managerReturning(["sb-live-1"]);
    const { client } = connectStub();

    const result = await openSandboxView({
      runId: "run-7",
      env: env({ DF_SANDBOX_WORKSPACE: "/repo" }),
      manager,
      connect: async () => client,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.workspace).toBe("/repo");
  });
});

describe("#790 R1 task 6 - a view is released, and the run is left alone", () => {
  it("releases the transport it opened, and never touches the run's sandbox", async () => {
    const { manager, killSandbox } = managerReturning(["sb-live-1"]);
    const { client, closed } = connectStub();

    const result = await openSandboxView({
      runId: "run-7",
      env: env(),
      manager,
      connect: async () => client,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await result.session.release();

    expect(closed).toHaveLength(1);
    expect(killSandbox).not.toHaveBeenCalled();
  });

  it("holds nothing open between requests: the same run answers ended once its sandbox is gone", async () => {
    const live = managerReturning(["sb-live-1"]);
    const { client } = connectStub();
    const first = await openSandboxView({
      runId: "run-7",
      env: env(),
      manager: live.manager,
      connect: async () => client,
    });
    expect(first.ok).toBe(true);

    // The run finished between the two requests: the view is derived from the sandbox list, so it is gone with it.
    const gone = managerReturning([]);
    const second = await openSandboxView({
      runId: "run-7",
      env: env(),
      manager: gone.manager,
      connect: async () => {
        throw new Error("connect must not be reached once the sandbox is gone");
      },
    });

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe("no-live-sandbox");
  });

  it("CONTROL: the same input with a live sandbox does produce a session, so the ended cases are not vacuous", async () => {
    const { manager } = managerReturning(["sb-live-1"]);
    const { client } = connectStub();
    const result = await openSandboxView({
      runId: "run-7",
      env: env(),
      manager,
      connect: async () => client,
    });
    expect(result.ok).toBe(true);
  });
});
