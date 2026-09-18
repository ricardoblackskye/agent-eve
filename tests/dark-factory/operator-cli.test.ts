import { describe, it, expect } from "vitest";
import {
  parseOperatorArgs,
  runOperatorCli,
  OperatorCliUsageError,
} from "../../agent/lib/dark-factory/operator-cli";
import type {
  OperatorDecision,
  OperatorDecisionStore,
} from "../../agent/lib/dark-factory/self-improve-state";

/**
 * #159 — the operator CLI is the ONLY way the self-improvement gate can be
 * satisfied outside a test: `createOperatorDecisionStore` is re-exported but
 * never called by the app, so every `access-widening` proposal is blocked with
 * "operator gate missing" until something records an `allow`.
 *
 * These tests drive a pure command layer with an injected store and clock, so
 * every rule is provable without a process, a filesystem or a network.
 */

const CLOCK = () => new Date("2026-09-18T12:00:00.000Z");

function fakeStore(initial: OperatorDecision[] = []) {
  const records = [...initial];
  const arm = (decision: OperatorDecision) => {
    const i = records.findIndex(
      (r) => r.surfaceId === decision.surfaceId && r.kind === decision.kind,
    );
    if (i >= 0) records.splice(i, 1);
    records.push(decision);
  };
  const store: OperatorDecisionStore = {
    record: async (d) => void arm(d),
    get: async (surfaceId, kind, now) => {
      const found = records.find(
        (r) => r.surfaceId === surfaceId && r.kind === kind,
      );
      if (!found) return null;
      if (found.expiresAt === null) return found;
      const at = Date.parse(found.expiresAt);
      const time = (now ? now() : new Date()).getTime();
      return Number.isNaN(at) || time >= at ? null : found;
    },
    list: async () => [...records],
    clear: async (surfaceId, kind) => {
      const i = records.findIndex(
        (r) => r.surfaceId === surfaceId && r.kind === kind,
      );
      if (i >= 0) records.splice(i, 1);
    },
  };
  return { store, records };
}

const deps = (records: OperatorDecision[] = [], overrides = {}) => {
  const { store } = fakeStore(records);
  return {
    deps: {
      storeId: "sqlite",
      target: "/tmp/agent-eve/state.sqlite",
      decisions: store,
      now: CLOCK,
      ...overrides,
    },
    store,
  };
};

describe("parseOperatorArgs (#159)", () => {
  it("parses allow with flags, defaulting --kind to access-widening", () => {
    const cmd = parseOperatorArgs([
      "allow",
      "skill-surface",
      "--by",
      "Richard Lloyd",
    ]);
    expect(cmd).toEqual({
      kind: "set",
      decision: "allow",
      surfaceId: "skill-surface",
      proposalKind: "access-widening",
      by: "Richard Lloyd",
      expiresAt: null,
    });
  });

  it("rejects an unknown command and a missing surfaceId as usage errors", () => {
    expect(() => parseOperatorArgs(["grant", "x"])).toThrow(
      OperatorCliUsageError,
    );
    expect(() => parseOperatorArgs(["allow"])).toThrow(OperatorCliUsageError);
    expect(() => parseOperatorArgs([])).toThrow(OperatorCliUsageError);
  });

  it("rejects an unknown --kind and an unknown flag", () => {
    expect(() =>
      parseOperatorArgs(["allow", "x", "--kind", "widening"]),
    ).toThrow(OperatorCliUsageError);
    expect(() => parseOperatorArgs(["list", "--wat"])).toThrow(
      OperatorCliUsageError,
    );
  });
});

describe("runOperatorCli: arming a decision (#159)", () => {
  it("records exactly the requested decision, stamped from the injected clock", async () => {
    const { deps: d, store } = deps();
    const result = await runOperatorCli(
      ["allow", "skill-surface", "--by", "Richard Lloyd"],
      d,
    );

    expect(result.exitCode).toBe(0);
    expect(await store.list()).toEqual([
      {
        surfaceId: "skill-surface",
        kind: "access-widening",
        decision: "allow",
        decidedBy: "Richard Lloyd",
        decidedAt: "2026-09-18T12:00:00.000Z",
        expiresAt: null,
      },
    ]);
  });

  it("echoes WHICH store was armed, so an ephemeral local file is visible", async () => {
    const { deps: d } = deps();
    const result = await runOperatorCli(
      ["allow", "skill-surface", "--by", "me"],
      d,
    );

    expect(result.lines.join("\n")).toContain("sqlite");
    expect(result.lines.join("\n")).toContain("/tmp/agent-eve/state.sqlite");
  });

  it("REFUSES an access-widening allow with no --by, and records nothing", async () => {
    const { deps: d, store } = deps();
    const result = await runOperatorCli(["allow", "skill-surface"], d);

    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toMatch(/--by/);
    expect(await store.list()).toEqual([]);
  });

  it("allows a bounded-tuning allow without --by (not the gated decision)", async () => {
    const { deps: d, store } = deps();
    const result = await runOperatorCli(
      ["allow", "bounds", "--kind", "bounded-tuning"],
      d,
    );

    expect(result.exitCode).toBe(0);
    expect((await store.list())[0].kind).toBe("bounded-tuning");
  });

  it("records a deny", async () => {
    const { deps: d, store } = deps();
    const result = await runOperatorCli(
      ["deny", "skill-surface", "--by", "me"],
      d,
    );

    expect(result.exitCode).toBe(0);
    expect((await store.list())[0].decision).toBe("deny");
  });

  it("clears a decision", async () => {
    const { deps: d, store } = deps();
    await runOperatorCli(["allow", "skill-surface", "--by", "me"], d);
    const result = await runOperatorCli(["clear", "skill-surface"], d);

    expect(result.exitCode).toBe(0);
    expect(await store.list()).toEqual([]);
  });
});

describe("runOperatorCli: --expires is never silently null (#159)", () => {
  it("refuses a malformed expiry instead of writing null", async () => {
    for (const bad of [
      "soon",
      "2030-13-45",
      "+7",
      "+7w",
      "2026-09-18T12:00:00",
    ]) {
      const { deps: d, store } = deps();
      const result = await runOperatorCli(
        ["allow", "skill-surface", "--by", "me", "--expires", bad],
        d,
      );
      expect(result.exitCode, `--expires ${bad} must be refused`).toBe(1);
      expect(
        await store.list(),
        `--expires ${bad} must record nothing`,
      ).toEqual([]);
    }
  });

  it("computes a relative expiry from the injected clock", async () => {
    const { deps: d, store } = deps();
    await runOperatorCli(["allow", "s", "--by", "me", "--expires", "+7d"], d);
    expect((await store.list())[0].expiresAt).toBe("2026-09-25T12:00:00.000Z");
  });

  it("accepts an ISO expiry, and 'never' as an explicit null", async () => {
    const { deps: d1, store: s1 } = deps();
    await runOperatorCli(
      ["allow", "s", "--by", "me", "--expires", "2030-01-02T03:04:05Z"],
      d1,
    );
    expect((await s1.list())[0].expiresAt).toBe("2030-01-02T03:04:05.000Z");

    const { deps: d2, store: s2 } = deps();
    await runOperatorCli(
      ["allow", "s", "--by", "me", "--expires", "never"],
      d2,
    );
    expect((await s2.list())[0].expiresAt).toBeNull();
  });
});

describe("operator CLI — review round on PR #166", () => {
  it("refuses a flag with no value at the END of argv, rather than reading past it", async () => {
    // The reviewer read `argv[i + 1]` as a potential off-by-one. JS returns
    // `undefined` (no crash), and that is refused — locked here so the handling
    // is a fact rather than an argument.
    const { deps: d, store } = deps();
    const result = await runOperatorCli(["allow", "s", "--by"], d);

    expect(result.exitCode).toBe(2);
    expect(result.lines.join("\n")).toMatch(/--by/);
    expect(await store.list()).toEqual([]);
    expect(() => parseOperatorArgs(["allow", "s", "--by"])).toThrow(
      OperatorCliUsageError,
    );
  });

  it("refuses a surfaceId that could forge a stored record or a log line", async () => {
    const bad = [
      "",
      "   ",
      "with\nnewline",
      "tab\there",
      "nul\u0000byte",
      "semi;colon",
      "--looks-like-a-flag",
    ];
    for (const value of bad) {
      const { deps: d, store } = deps();
      const result = await runOperatorCli(["allow", value, "--by", "me"], d);
      expect(
        result.exitCode,
        `surfaceId ${JSON.stringify(value)} must be refused`,
      ).toBe(2);
      expect(
        await store.list(),
        `${JSON.stringify(value)} must record nothing`,
      ).toEqual([]);
    }
  });

  it("accepts every surfaceId shape the repo's surfaces actually use", async () => {
    for (const value of [
      "iteration-bounds",
      "skill-set",
      "skill.set",
      "skill_set",
      "Surface:1",
    ]) {
      const { deps: d, store } = deps();
      const result = await runOperatorCli(["allow", value, "--by", "me"], d);
      expect(result.exitCode, `surfaceId ${value} must be accepted`).toBe(0);
      expect((await store.list())[0].surfaceId).toBe(value);
    }
  });

  it("refuses an expiry that overflows the date range, instead of throwing a RangeError", async () => {
    const huge = ["+999999999d", "+" + "9".repeat(400) + "h"];
    for (const value of huge) {
      const { deps: d, store } = deps();
      const result = await runOperatorCli(
        ["allow", "s", "--by", "me", "--expires", value],
        d,
      );
      expect(
        result.exitCode,
        `--expires ${value.slice(0, 24)}... must be refused`,
      ).toBe(1);
      expect(result.lines.join("\n")).toMatch(/overflows/i);
      expect(await store.list()).toEqual([]);
    }
  });
});

describe("runOperatorCli: list and refusal paths (#159)", () => {
  it("lists live and expired decisions, marking the expired ones", async () => {
    const { deps: d } = deps([
      {
        surfaceId: "live",
        kind: "access-widening",
        decision: "allow",
        decidedBy: "me",
        decidedAt: "2026-09-01T00:00:00.000Z",
        expiresAt: null,
      },
      {
        surfaceId: "gone",
        kind: "access-widening",
        decision: "allow",
        decidedBy: "me",
        decidedAt: "2026-09-01T00:00:00.000Z",
        expiresAt: "2026-09-02T00:00:00.000Z",
      },
      {
        surfaceId: "corrupt",
        kind: "access-widening",
        decision: "allow",
        decidedBy: "me",
        decidedAt: "2026-09-01T00:00:00.000Z",
        expiresAt: "not-a-date",
      },
    ]);
    const result = await runOperatorCli(["list"], d);
    const out = result.lines.join("\n");

    expect(result.exitCode).toBe(0);
    expect(out).toContain("live");
    expect(out).toMatch(/gone.*expired/i);
    expect(out).toMatch(/corrupt.*expired/i);
  });

  it("says so plainly when nothing is armed", async () => {
    const { deps: d } = deps();
    const result = await runOperatorCli(["list"], d);
    expect(result.exitCode).toBe(0);
    expect(result.lines.join("\n")).toMatch(/no .*decision/i);
  });

  it("REFUSES rather than claim success when the store will not persist", async () => {
    // The console driver refuses every write, so arming there must not look like
    // it worked — a false "armed" is how an operator would believe access was
    // granted when nothing was recorded.
    const refusing: OperatorDecisionStore = {
      record: async () => {
        throw new Error(
          "Could not persist the operator decision via 'console' (blocked).",
        );
      },
      get: async () => null,
      list: async () => [],
      clear: async () => undefined,
    };
    const { deps: d } = deps([], {
      decisions: refusing,
      storeId: "console",
      target: null,
    });
    const result = await runOperatorCli(["allow", "s", "--by", "me"], d);

    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toMatch(/could not persist/i);
    expect(result.lines.join("\n")).not.toMatch(/armed/i);
  });
});
