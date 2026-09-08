# User Story (Issue) Generation — Implementation Plan

> **Issue:** [#61 — User Story (Issue) Generation](https://github.com/ricardoblackskye/agent-eve/issues/61)
> **Parent:** [#55 — Requirements and Planning Handling](https://github.com/ricardoblackskye/agent-eve/issues/55) (Portfolio Epic)
> **Branch (R1):** `feat/user-story-core-61`
> **Plan date:** 2026-09-08

**Goal:** Give Agent Eve a `product-owner` subagent that turns a raw feature request into a
machine-readable, AI-ready user story — and, when the request is too vague to do that
safely, pauses and asks a targeted clarifying question instead of inventing detail.

**Architecture:** A new declared Eve subagent `agent/subagents/product-owner/` with its own
`instructions.md` and two tools. Deterministic logic (template validation, refinement-gap
detection, NFR injection) lives in import-only `agent/lib/`, unit-tested with Vitest; the LLM
handles only the genuinely fuzzy work (prose intent, examples, constraints). Backlog delivery
is **platform-agnostic** — the agent emits a canonical JSON payload; a provider adapter turns
it into Azure DevOps / GitHub / Jira. R1 ships the payload + a dry-run `console` provider only.

**Tech Stack:** Eve framework (`defineAgent`, `defineTool`), Zod 4.4.3, TypeScript 7.0.2
(strict), Vitest 4 (`tests/**/*.test.ts`), Playwright (e2e), MegaLinter (cspell/prettier).

---

## Release Split (agreed with user)

Issue #61 has 4 phases. They are split across **3 releases** so each is independently
reviewable, deployable, and useful:

| Release            | Branch                         | Issue phases      | Scope                                                                            |
| ------------------ | ------------------------------ | ----------------- | -------------------------------------------------------------------------------- |
| **R1** (this plan) | `feat/user-story-core-61`      | Phase 2 + Phase 3 | Story schema, structuring, refinement loop, canonical payload + dry-run provider |
| **R2**             | `feat/user-story-ingestion-61` | Phase 1           | Feedback/ticket parsing + context retrieval                                      |
| **R3**             | `feat/user-story-backlog-61`   | Phase 4           | Platform-agnostic backlog push (Azure DevOps first adapter)                      |

Two clarifications the user gave while scoping:

- **Backlog integration must be platform agnostic.** Not Azure-DevOps-only. R1 therefore
  defines the canonical payload + a provider interface, and ships only a `console`/dry-run
  provider. No `AZDO_*` env vars, no real network push, in R1.
- **Context retrieval (Phase 1) is out of scope for R1.** No doc-querying tool in R1. R2
  covers it. This is noted as a known R1 limitation.

---

## Current Context / Assumptions (verified 2026-09-08)

Verified against `origin/main` @ `371c8b6`:

- Repo is a Next.js 16 app wrapping an Eve agent. Subagents live at
  `agent/subagents/<id>/` with a **required** `description` in `agent.ts`.
- Existing subagents: `pr-reviewer`, `release-manager`. Both build an OpenRouter client via
  `createOpenAI` and set `modelContextWindowTokens: 1_048_576`.
- Tools are `defineTool({ description, inputSchema: z.object({...}), execute })` under
  `agent/subagents/<id>/tools/`. The **filename is the model-facing tool name**.
- `agent/lib/` is the documented place for shared authored helper code ("Import-only; not
  mounted into the workspace" — `node_modules/eve/docs/getting-started.mdx:111`). No `lib/`
  exists yet; R1 creates it.
- Tests: Vitest, `include: ["tests/**/*.test.ts", "tests/**/*.spec.ts"]`, node environment,
  globals on. **Baseline: 7 files / 33 tests pass.** `npx tsc --noEmit` is clean.
- Evals live in `evals/*.eval.ts`. `release-notes-tool.eval.ts` asserts a subagent is
  registered by string-matching `/eve/v1/info`, and carries `tags: ["production"]`.
  CI runs `npx eve eval --strict --exclude-tag production --url http://127.0.0.1:3000`, so
  **production-tagged evals are excluded locally/CI** — R1 must not depend on one.
- The root `agent/agent.ts` uses `mockModel` unconditionally (no API key needed for evals).
- Lint gate: MegaLinter with cspell (`.cspell.json`, words list) + prettier. **Plan files and
  dotfiles are linted too** — new words must be added to `.cspell.json`.

---

## Task 1 — Story schema + validator (`agent/lib/story-schema.ts`)

**Objective:** One Zod schema that is the single source of truth for an AI-ready story, plus a
pure validator the tools and tests share.

**Files:**

- Create: `agent/lib/story-schema.ts`
- Test: `tests/story-schema.test.ts`

**Step 1: Write the failing test**

```ts
// tests/story-schema.test.ts
import { describe, it, expect } from "vitest";
import {
  UserStorySchema,
  validateStory,
  NFR_DEFAULTS,
} from "../agent/lib/story-schema";

const goodStory = {
  id: "US-001",
  title: "Export report as CSV",
  intent:
    "A project manager can export the current sprint report as a CSV file from the report page.",
  acceptanceCriteria: [
    {
      given: "a sprint report with 12 items",
      when: "the user clicks Export CSV",
      then: "a UTF-8 CSV file downloads containing exactly 12 data rows plus one header row",
    },
  ],
  examples: [{ input: "click Export CSV", output: "report-2026-09-08.csv" }],
  constraints: ["MUST NOT block the UI thread during export"],
  nfrs: {
    performance: "p95 < 2s for 5k rows",
    security: "respect tenant scoping",
    latency: "n/a",
  },
  openQuestions: [],
};

describe("UserStorySchema", () => {
  it("accepts a complete story", () => {
    expect(UserStorySchema.safeParse(goodStory).success).toBe(true);
  });

  it("rejects a story with no acceptance criteria", () => {
    const r = UserStorySchema.safeParse({
      ...goodStory,
      acceptanceCriteria: [],
    });
    expect(r.success).toBe(false);
  });

  it("rejects an intent under 20 chars (not unambiguous)", () => {
    const r = UserStorySchema.safeParse({ ...goodStory, intent: "do export" });
    expect(r.success).toBe(false);
  });

  it("rejects a constraint that is not a MUST/MUST NOT/SHOULD statement", () => {
    const r = UserStorySchema.safeParse({
      ...goodStory,
      constraints: ["avoid slow things"],
    });
    expect(r.success).toBe(false);
  });
});

describe("validateStory", () => {
  it("returns ok for a complete story", () => {
    expect(validateStory(goodStory).ok).toBe(true);
  });

  it("lists missing sections when they are absent", () => {
    const r = validateStory({ ...goodStory, examples: [] });
    expect(r.ok).toBe(false);
    expect(r.missing).toContain("examples");
  });

  it("fills default NFRs when nfrs is omitted", () => {
    const { nfrs, ...withoutNfrs } = goodStory;
    const r = validateStory(withoutNfrs);
    expect(r.story?.nfrs).toEqual(NFR_DEFAULTS);
  });
});
```

**Step 2: Run test to verify failure**
Run: `npx vitest run tests/story-schema.test.ts`
Expected: FAIL — cannot resolve `../agent/lib/story-schema`.

**Step 3: Write the minimal implementation**

```ts
// agent/lib/story-schema.ts
import { z } from "zod";

export const AcceptanceCriterionSchema = z.object({
  given: z.string().min(1),
  when: z.string().min(1),
  then: z.string().min(1),
});

export const ExampleSchema = z.object({
  input: z.string().min(1),
  output: z.string().min(1),
});

const CONSTRAINT_PATTERN = /^(MUST NOT|MUST|SHOULD NOT|SHOULD|MAY)\s+\S.*$/;

export const NFR_DEFAULTS = {
  performance:
    "Not specified — confirm expected throughput before implementation.",
  security: "Must respect existing authentication and tenant scoping.",
  latency: "Not specified — confirm acceptable response time.",
} as const;

export const NfrSchema = z.object({
  performance: z.string().min(1),
  security: z.string().min(1),
  latency: z.string().min(1),
});

export const UserStorySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  intent: z.string().min(20),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1),
  examples: z.array(ExampleSchema).min(1),
  constraints: z
    .array(
      z
        .string()
        .regex(
          CONSTRAINT_PATTERN,
          "constraint must start with MUST/SHOULD/MAY",
        ),
    )
    .min(1),
  nfrs: NfrSchema,
  openQuestions: z.array(z.string()),
});

export type UserStory = z.infer<typeof UserStorySchema>;

export function validateStory(input: unknown): {
  ok: boolean;
  missing: string[];
  issues: string[];
  story?: UserStory;
} {
  const withNfrs =
    input &&
    typeof input === "object" &&
    !(input as Record<string, unknown>).nfrs
      ? { ...(input as Record<string, unknown>), nfrs: NFR_DEFAULTS }
      : input;

  const parsed = UserStorySchema.safeParse(withNfrs);
  if (parsed.success) {
    return { ok: true, missing: [], issues: [], story: parsed.data };
  }

  const missing = [
    ...new Set(parsed.error.issues.map((i) => String(i.path[0]))),
  ].filter((k) => k !== "undefined");

  return {
    ok: false,
    missing,
    issues: parsed.error.issues.map(
      (i) => `${i.path.join(".") || "root"}: ${i.message}`,
    ),
  };
}
```

**Step 4: Run test to verify pass**
Run: `npx vitest run tests/story-schema.test.ts` — expected 8 passed.

**Step 5: Commit**
`git commit -m "feat(story): add AI-ready user story schema and validator"`

---

## Task 2 — Refinement-gap detector (`agent/lib/story-refinement.ts`)

**Objective:** Pure function that decides whether a draft has enough specificity to finalize,
or whether the agent must pause and ask the Product Owner a question. This is Phase 3.

**Files:**

- Create: `agent/lib/story-refinement.ts`
- Test: `tests/story-refinement.test.ts`

**Step 1: Write the failing test**

```ts
// tests/story-refinement.test.ts
import { describe, it, expect } from "vitest";
import { detectGaps, type DraftStory } from "../agent/lib/story-refinement";

const draft: DraftStory = {
  intent: "A user can reset their password from the login screen.",
  acceptanceCriteria: [
    {
      given: "a registered email",
      when: "the user submits reset",
      then: "an email is sent",
    },
  ],
  examples: [{ input: "user@example.com", output: "reset email delivered" }],
  constraints: ["MUST NOT reveal whether an account exists"],
};

describe("detectGaps", () => {
  it("returns no gaps for a specific draft", () => {
    expect(detectGaps(draft)).toEqual([]);
  });

  it("flags a vague intent (under 40 chars)", () => {
    expect(
      detectGaps({ ...draft, intent: "make login better" }).map((g) => g.field),
    ).toContain("intent");
  });

  it("flags an unmeasurable acceptance criterion", () => {
    const g = detectGaps({
      ...draft,
      acceptanceCriteria: [{ given: "x", when: "y", then: "it works well" }],
    });
    expect(g.map((x) => x.field)).toContain("acceptanceCriteria");
  });

  it("flags a missing example", () => {
    expect(
      detectGaps({ ...draft, examples: [] }).map((g) => g.field),
    ).toContain("examples");
  });

  it("returns a question for every gap", () => {
    const gaps = detectGaps({ ...draft, examples: [] });
    expect(gaps[0].question.length).toBeGreaterThan(10);
  });

  it("reports multiple independent gaps at once", () => {
    const gaps = detectGaps({ ...draft, examples: [], intent: "tweak it" });
    expect(gaps.length).toBeGreaterThanOrEqual(2);
  });
});
```

**Step 2: Run test to verify failure**
Run: `npx vitest run tests/story-refinement.test.ts` — expected FAIL (module not found).

**Step 3: Write the minimal implementation**

```ts
// agent/lib/story-refinement.ts
export interface DraftStory {
  intent: string;
  acceptanceCriteria: Array<{ given: string; when: string; then: string }>;
  examples: Array<{ input: string; output: string }>;
  constraints: string[];
}

export interface Gap {
  field: "intent" | "acceptanceCriteria" | "examples" | "constraints";
  reason: string;
  question: string;
}

const MEASURABLE =
  /\d|specific|exactly|within|equals?|returns?|contains?|status\s+\d{3}|true|false/i;

export function detectGaps(draft: DraftStory): Gap[] {
  const gaps: Gap[] = [];

  if (draft.intent.trim().length < 40) {
    gaps.push({
      field: "intent",
      reason: "Intent is too short to be unambiguous.",
      question:
        "Who is the user, and what exact outcome should they see? Describe it in one full sentence.",
    });
  }

  const unmeasurable = draft.acceptanceCriteria.filter(
    (ac) => !MEASURABLE.test(ac.then),
  );
  if (unmeasurable.length > 0) {
    gaps.push({
      field: "acceptanceCriteria",
      reason: `${unmeasurable.length} acceptance criterion/criteria has no verifiable outcome.`,
      question:
        "How should a test verify this? Give a concrete number, status code, or exact expected value.",
    });
  }

  if (draft.examples.length === 0) {
    gaps.push({
      field: "examples",
      reason: "No concrete input/output example was provided.",
      question:
        "Give one concrete input and the exact output you expect for it.",
    });
  }

  if (draft.constraints.length === 0) {
    gaps.push({
      field: "constraints",
      reason: "No explicit constraint was provided.",
      question:
        "What must the implementation NOT do? (e.g. 'MUST NOT call the third-party API directly')",
    });
  }

  return gaps;
}
```

**Step 4: Run test to verify pass** — expected 6 passed.

**Step 5: Commit**
`git commit -m "feat(story): add refinement gap detector"`

---

## Task 3 — Canonical payload + provider adapters (`agent/lib/backlog-provider.ts`)

**Objective:** Platform-agnostic delivery. The agent always produces the same canonical
payload; a provider translates it. R1 ships `console` (dry-run) only — no network, no secrets.

**Files:**

- Create: `agent/lib/backlog-provider.ts`
- Test: `tests/backlog-provider.test.ts`

**Step 1: Write the failing test**

```ts
// tests/backlog-provider.test.ts
import { describe, it, expect } from "vitest";
import {
  toCanonicalPayload,
  getProvider,
  type BacklogProvider,
} from "../agent/lib/backlog-provider";
import type { UserStory } from "../agent/lib/story-schema";

const story: UserStory = {
  id: "US-001",
  title: "Export report as CSV",
  intent: "A project manager can export the sprint report as CSV.",
  acceptanceCriteria: [
    { given: "12 items", when: "click Export", then: "12 rows download" },
  ],
  examples: [{ input: "click Export", output: "report.csv" }],
  constraints: ["MUST NOT block the UI thread"],
  nfrs: { performance: "p95 < 2s", security: "tenant scoped", latency: "n/a" },
  openQuestions: [],
};

describe("toCanonicalPayload", () => {
  it("is platform neutral — no provider-specific fields", () => {
    const json = JSON.stringify(toCanonicalPayload(story));
    expect(json).not.toMatch(/azure|devops|jira|github/i);
  });

  it("carries every section of the story", () => {
    const p = toCanonicalPayload(story);
    expect(p.story.id).toBe("US-001");
    expect(p.acceptanceCriteria).toHaveLength(1);
    expect(p.nfrs).toBeDefined();
  });
});

describe("getProvider", () => {
  it("defaults to the console provider (dry run)", () => {
    expect(getProvider("console").id).toBe("console");
  });

  it("console provider never performs a network call", async () => {
    const p: BacklogProvider = getProvider("console");
    const res = await p.publish(toCanonicalPayload(story));
    expect(res.delivered).toBe(false);
    expect(res.mode).toBe("dry-run");
  });

  it("returns a not-configured result for an unknown provider", async () => {
    const res = await getProvider("nonexistent").publish(
      toCanonicalPayload(story),
    );
    expect(res.delivered).toBe(false);
  });
});
```

**Step 2: Run to verify failure** — `npx vitest run tests/backlog-provider.test.ts` → FAIL.

**Step 3: Write the minimal implementation**

```ts
// agent/lib/backlog-provider.ts
import type { UserStory } from "./story-schema";

export interface CanonicalPayload {
  version: "1.0";
  kind: "user-story";
  story: UserStory;
  acceptanceCriteria: UserStory["acceptanceCriteria"];
  examples: UserStory["examples"];
  constraints: UserStory["constraints"];
  nfrs: UserStory["nfrs"];
  openQuestions: UserStory["openQuestions"];
  generatedAt: string;
}

export function toCanonicalPayload(
  story: UserStory,
  now: Date = new Date(),
): CanonicalPayload {
  return {
    version: "1.0",
    kind: "user-story",
    story,
    acceptanceCriteria: story.acceptanceCriteria,
    examples: story.examples,
    constraints: story.constraints,
    nfrs: story.nfrs,
    openQuestions: story.openQuestions,
    generatedAt: now.toISOString(),
  };
}

export interface PublishResult {
  delivered: boolean;
  mode: "dry-run" | "live";
  provider: string;
  reference?: string;
  message: string;
}

export interface BacklogProvider {
  id: string;
  publish(payload: CanonicalPayload): Promise<PublishResult>;
}

const consoleProvider: BacklogProvider = {
  id: "console",
  async publish(payload) {
    return {
      delivered: false,
      mode: "dry-run",
      provider: "console",
      message:
        `Dry run — payload for ${payload.story.id} validated and NOT pushed. ` +
        `Configure a live provider to deliver it.`,
    };
  },
};

const unknownProvider = (id: string): BacklogProvider => ({
  id,
  async publish() {
    return {
      delivered: false,
      mode: "dry-run",
      provider: id,
      message: `Provider '${id}' is not configured in this release.`,
    };
  },
});

export function getProvider(id: string | undefined): BacklogProvider {
  if (!id || id === "console") return consoleProvider;
  return unknownProvider(id);
}
```

**Step 4: Run to verify pass** — expected 5 passed.

**Step 5: Commit**
`git commit -m "feat(story): add platform-agnostic backlog payload and provider interface"`

---

## Task 4 — `draft_user_story` tool

**Objective:** Expose the schema + refinement loop to the model. Given a draft, it either
returns a validated canonical payload or returns the gaps the agent must ask about.

**Files:**

- Create: `agent/subagents/product-owner/tools/draft_user_story.ts`
- Test: `tests/draft-user-story.test.ts`

**Step 1: Write the failing test**

```ts
// tests/draft-user-story.test.ts
import { describe, it, expect } from "vitest";
import tool from "../agent/subagents/product-owner/tools/draft_user_story";

const complete = {
  intent:
    "A project manager can export the current sprint report as a CSV file.",
  acceptanceCriteria: [
    {
      given: "a report with 12 items",
      when: "click Export CSV",
      then: "a file with 12 rows downloads",
    },
  ],
  examples: [{ input: "click Export CSV", output: "report.csv" }],
  constraints: ["MUST NOT block the UI thread"],
};

describe("draft_user_story", () => {
  it("is a valid eve tool definition", () => {
    expect(tool.description.length).toBeGreaterThan(10);
    expect(tool.inputSchema).toBeDefined();
  });

  it("returns status complete for a specific draft", async () => {
    const r = await tool.execute(complete as any, {} as any);
    expect(r.status).toBe("complete");
    expect(r.payload.story.acceptanceCriteria).toHaveLength(1);
  });

  it("returns status needs_clarification with questions for a vague draft", async () => {
    const r = await tool.execute(
      { ...complete, intent: "make it better", examples: [] } as any,
      {} as any,
    );
    expect(r.status).toBe("needs_clarification");
    expect(r.questions.length).toBeGreaterThan(0);
  });

  it("auto-fills NFRs when omitted", async () => {
    const r = await tool.execute(complete as any, {} as any);
    expect(r.payload.nfrs.performance).toBeTruthy();
    expect(r.payload.nfrs.security).toBeTruthy();
  });
});
```

**Step 2: Run to verify failure** — `npx vitest run tests/draft-user-story.test.ts` → FAIL.

**Step 3: Write the minimal implementation**

```ts
// agent/subagents/product-owner/tools/draft_user_story.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { validateStory } from "../../../lib/story-schema";
import { detectGaps } from "../../../lib/story-refinement";
import { toCanonicalPayload } from "../../../lib/backlog-provider";

export default defineTool({
  description:
    "Turn a raw feature request into a structured, AI-ready user story. " +
    "Returns either a validated story payload (status 'complete') or a list of " +
    "targeted clarifying questions (status 'needs_clarification'). When the " +
    "status is 'needs_clarification', ask the user those questions before " +
    "calling this tool again.",
  inputSchema: z.object({
    title: z.string().min(1),
    intent: z.string().min(1),
    acceptanceCriteria: z.array(
      z.object({ given: z.string(), when: z.string(), then: z.string() }),
    ),
    examples: z.array(z.object({ input: z.string(), output: z.string() })),
    constraints: z.array(z.string()),
    id: z.string().optional(),
  }),
  async execute(input) {
    const gaps = detectGaps(input);
    if (gaps.length > 0) {
      return {
        status: "needs_clarification" as const,
        questions: gaps.map((g) => g.question),
        gaps: gaps.map(({ field, reason }) => ({ field, reason })),
      };
    }

    const result = validateStory({
      id: input.id ?? `US-${Date.now()}`,
      title: input.title,
      intent: input.intent,
      acceptanceCriteria: input.acceptanceCriteria,
      examples: input.examples,
      constraints: input.constraints,
      openQuestions: [],
    });

    if (!result.ok || !result.story) {
      return {
        status: "needs_clarification" as const,
        questions: result.issues,
        gaps: result.missing.map((field) => ({
          field,
          reason: "missing or invalid",
        })),
      };
    }

    return {
      status: "complete" as const,
      payload: toCanonicalPayload(result.story),
    };
  },
});
```

**Step 4: Run to verify pass** — expected 4 passed.

**Step 5: Commit**
`git commit -m "feat(story): add draft_user_story tool with refinement loop"`

---

## Task 5 — `publish_story` tool (dry-run in R1)

**Objective:** Deliver a finalized payload. R1 resolves the console provider by default so
nothing is pushed; the interface is what R3 fills in with a live adapter.

**Files:**

- Create: `agent/subagents/product-owner/tools/publish_story.ts`
- Test: `tests/publish-story.test.ts`

**Step 1: Write the failing test**

```ts
// tests/publish-story.test.ts
import { describe, it, expect } from "vitest";
import tool from "../agent/subagents/product-owner/tools/publish_story";

const payload = {
  version: "1.0",
  kind: "user-story",
  story: {
    id: "US-001",
    title: "Export CSV",
    intent: "A project manager can export the sprint report as a CSV file.",
    acceptanceCriteria: [
      { given: "12 items", when: "click Export", then: "12 rows download" },
    ],
    examples: [{ input: "click Export", output: "report.csv" }],
    constraints: ["MUST NOT block the UI thread"],
    nfrs: {
      performance: "p95 < 2s",
      security: "tenant scoped",
      latency: "n/a",
    },
    openQuestions: [],
  },
  acceptanceCriteria: [
    { given: "12 items", when: "click Export", then: "12 rows download" },
  ],
  examples: [{ input: "click Export", output: "report.csv" }],
  constraints: ["MUST NOT block the UI thread"],
  nfrs: { performance: "p95 < 2s", security: "tenant scoped", latency: "n/a" },
  openQuestions: [],
  generatedAt: new Date().toISOString(),
};

describe("publish_story", () => {
  it("defaults to a dry run and never delivers", async () => {
    const r = await tool.execute({ payload } as any, {} as any);
    expect(r.delivered).toBe(false);
    expect(r.mode).toBe("dry-run");
  });

  it("returns the canonical payload it was given", async () => {
    const r = await tool.execute({ payload } as any, {} as any);
    expect(r.payload.story.id).toBe("US-001");
  });

  it("rejects an invalid payload rather than publishing it", async () => {
    const r = await tool.execute(
      {
        payload: { ...payload, story: { ...payload.story, intent: "x" } },
      } as any,
      {} as any,
    );
    expect(r.delivered).toBe(false);
    expect(r.error).toBeTruthy();
  });
});
```

**Step 2: Run to verify failure** — `npx vitest run tests/publish-story.test.ts` → FAIL.

**Step 3: Write the minimal implementation**

```ts
// agent/subagents/product-owner/tools/publish_story.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  getProvider,
  type CanonicalPayload,
} from "../../../lib/backlog-provider";
import { UserStorySchema } from "../../../lib/story-schema";

export default defineTool({
  description:
    "Publish a finalized user story payload to the configured backlog provider. " +
    "In this release the default provider is 'console', which performs a dry run " +
    "and does NOT create a work item. Set the provider argument to select a " +
    "different adapter when one is configured.",
  inputSchema: z.object({
    payload: z.record(z.string(), z.unknown()),
    provider: z.string().optional(),
  }),
  async execute({ payload, provider }) {
    const storyCheck = UserStorySchema.safeParse(
      (payload as Record<string, unknown>).story,
    );
    if (!storyCheck.success) {
      return {
        delivered: false,
        error: `Refusing to publish an invalid story: ${storyCheck.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      };
    }

    const result = await getProvider(provider).publish(
      payload as unknown as CanonicalPayload,
    );
    return { ...result, payload };
  },
});
```

**Step 4: Run to verify pass** — expected 3 passed.

**Step 5: Commit**
`git commit -m "feat(story): add publish_story tool with dry-run provider"`

---

## Task 6 — `product-owner` subagent + instructions

**Objective:** Register the specialist so the root agent can delegate to it.

**Files:**

- Create: `agent/subagents/product-owner/agent.ts`
- Create: `agent/subagents/product-owner/instructions.md`
- Test: `tests/product-owner-agent.test.ts`

**Step 1: Write the failing test**

```ts
// tests/product-owner-agent.test.ts
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const dir = path.join(process.cwd(), "agent", "subagents", "product-owner");

describe("product-owner subagent", () => {
  it("has an agent.ts with a required description", () => {
    const src = fs.readFileSync(path.join(dir, "agent.ts"), "utf8");
    expect(src).toMatch(/description:\s*\n?\s*["'`]/);
  });

  it("declares a model", () => {
    const src = fs.readFileSync(path.join(dir, "agent.ts"), "utf8");
    expect(src).toMatch(/model:/);
  });

  it("does not hardcode the model id (uses MODEL_NAME env)", () => {
    const src = fs.readFileSync(path.join(dir, "agent.ts"), "utf8");
    expect(src).toMatch(/MODEL_NAME/);
  });

  it("has instructions covering all five story sections", () => {
    const src = fs
      .readFileSync(path.join(dir, "instructions.md"), "utf8")
      .toLowerCase();
    for (const section of [
      "intent",
      "acceptance",
      "example",
      "constraint",
      "nfr",
    ]) {
      expect(src).toContain(section);
    }
  });

  it("instructs the agent to pause and ask when data is missing", () => {
    const src = fs
      .readFileSync(path.join(dir, "instructions.md"), "utf8")
      .toLowerCase();
    expect(src).toMatch(/needs_clarification|clarif/);
  });

  it("has both tools in its tools directory", () => {
    const tools = fs.readdirSync(path.join(dir, "tools"));
    expect(tools).toContain("draft_user_story.ts");
    expect(tools).toContain("publish_story.ts");
  });
});
```

**Step 2: Run to verify failure** — `npx vitest run tests/product-owner-agent.test.ts` → FAIL.

**Step 3: Write the minimal implementation**

```ts
// agent/subagents/product-owner/agent.ts
import { createOpenAI } from "@ai-sdk/openai";
import { defineAgent } from "eve";

const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  name: "openrouter",
});

const DEFAULT_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";

export default defineAgent({
  description:
    "Product Owner: turns a raw feature request or piece of customer feedback into a " +
    "structured, AI-ready user story with machine-verifiable acceptance criteria, " +
    "concrete examples, explicit constraints and NFRs. Pauses to ask a targeted " +
    "clarifying question when the request is too vague to finalize.",
  model: openrouter.chat(process.env.MODEL_NAME || DEFAULT_MODEL),
  modelContextWindowTokens: 1_048_576,
});
```

`instructions.md` must cover: the five required sections (intent, machine-verifiable
acceptance criteria, concrete examples, explicit MUST/SHOULD constraints, NFRs); the rule
that `draft_user_story` returning `needs_clarification` means **stop and ask the user the
returned questions** before retrying; and that publishing in this release is dry-run only.

**Step 4: Run to verify pass** — expected 6 passed.

**Step 5: Commit**
`git commit -m "feat(story): register product-owner subagent"`

---

## Task 7 — Eval: subagent is registered

**Objective:** Prove the subagent is visible to the running agent, matching the existing
`release-notes-tool.eval.ts` pattern.

**Files:**

- Create: `evals/product-owner.eval.ts`

**Note:** Do **not** tag this `production`. CI runs
`npx eve eval --strict --exclude-tag production`, so an untagged eval runs in CI while a
production-tagged one is skipped.

```ts
// evals/product-owner.eval.ts
import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

export default defineEval({
  description:
    "Verifies the product-owner subagent is registered and story-shaped.",
  async test(t) {
    const infoResponse = await t.target.fetch("/eve/v1/info");
    const info = await infoResponse.json();
    const jsonStr = JSON.stringify(info);

    t.check(
      jsonStr.includes("product-owner"),
      satisfies(
        (found: boolean) => found === true,
        "product-owner subagent is registered",
      ),
    );

    t.check(
      jsonStr.includes("user story"),
      satisfies(
        (found: boolean) => found === true,
        "product-owner description mentions user story",
      ),
    );
  },
});
```

**Step: Run locally**

```
npm run dev -- --hostname 127.0.0.1 --port 3000 &
npx eve eval --url http://127.0.0.1:3000
```

**Step: Commit**
`git commit -m "test(evals): add product-owner subagent registration eval"`

---

## Task 8 — Lint gate + full verification (MANDATORY before push)

**Objective:** MegaLinter (cspell + prettier) and the full suite must be green locally.

**Steps:**

1. `npx vitest run` — expect **7 → 12 files, 33 → 59 tests, all passing**.
2. `npx tsc --noEmit` — expect clean (exit 0).
3. `npm run build` — expect success.
4. `npx -y cspell@8 --config .cspell.json agent/lib/*.ts agent/subagents/product-owner/**/*.ts agent/subagents/product-owner/instructions.md tests/*.test.ts evals/product-owner.eval.ts .hermes/plans/2026-09-08_feat-user-story-generation-61.md`
   - Add any flagged project terms to the `.cspell.json` `words` array (this plan file is
     linted too — `nfr`, `nfrs`, `Azdo`-class terms will likely need adding).
5. `npx -y prettier@3 --check agent tests evals .hermes/plans`
   - Run `--write` if it reports formatting drift.
6. `npx vitest run` again after any lint-driven edits.

**Commit**
`git commit -m "fix(lint): satisfy cspell and prettier for story generation"`

---

## Files Likely to Change

| File                                                        | Action                     |
| ----------------------------------------------------------- | -------------------------- |
| `agent/lib/story-schema.ts`                                 | Create                     |
| `agent/lib/story-refinement.ts`                             | Create                     |
| `agent/lib/backlog-provider.ts`                             | Create                     |
| `agent/subagents/product-owner/agent.ts`                    | Create                     |
| `agent/subagents/product-owner/instructions.md`             | Create                     |
| `agent/subagents/product-owner/tools/draft_user_story.ts`   | Create                     |
| `agent/subagents/product-owner/tools/publish_story.ts`      | Create                     |
| `tests/story-schema.test.ts`                                | Create                     |
| `tests/story-refinement.test.ts`                            | Create                     |
| `tests/backlog-provider.test.ts`                            | Create                     |
| `tests/draft-user-story.test.ts`                            | Create                     |
| `tests/publish-story.test.ts`                               | Create                     |
| `tests/product-owner-agent.test.ts`                         | Create                     |
| `evals/product-owner.eval.ts`                               | Create                     |
| `.cspell.json`                                              | Modify (new project terms) |
| `.hermes/plans/2026-09-08_feat-user-story-generation-61.md` | This file                  |

**Not changed in R1:** `agent/agent.ts` (root keeps `mockModel`), `ARCHITECTURE.md` (update in
R3 once the backlog flow is real), `release-manager.config.json`, any CI workflow.

---

## Validation

- **Unit:** `npx vitest run` — baseline 33 tests must stay green; ~26 new tests added.
- **Types:** `npx tsc --noEmit` — clean.
- **Build:** `npm run build` — succeeds (Eve compiles the new subagent).
- **Evals:** `npx eve eval --url http://127.0.0.1:3000` — `product-owner.eval.ts` passes
  (untagged, so it also runs in CI).
- **Lint:** cspell + prettier clean on all new/changed files **including this plan file**.
- **Manual smoke:** start `npm run dev`, ask the agent to draft a story from a vague
  one-liner, and confirm it asks a clarifying question rather than inventing detail; then
  supply the detail and confirm it returns a complete payload.

---

## Risks / Tradeoffs / Open Questions

1. **`agent/lib/` import from a subagent.** Eve docs describe `lib/` as shared authored
   helper code, and `concepts/state.md` shows a tool importing `../lib/budget`. A subagent
   importing `../../../lib/...` should resolve, but if the Eve compiler treats a subagent
   directory as a hard package root, imports may fail at `npm run build`. **Mitigation:**
   Task 6's build step is the check; if it fails, inline the helpers into
   `agent/subagents/product-owner/lib/` and update the two import paths. Tests keep working
   either way.
2. **Model-dependent output quality.** The tools validate structure; they cannot judge whether
   an acceptance criterion is genuinely good. The measurable-outcome regex is a heuristic —
   it will pass some weak criteria and flag some valid ones. Trade-off accepted: it is a
   guardrail, not an oracle. R2's feedback parsing may refine it.
3. **Constraint regex is strict.** Requiring `MUST`/`SHOULD`/`MAY` at the start will reject
   reasonable prose constraints. Deliberate — the issue asks for constraints that "explicitly
   dictate what downstream agents must not do". Watch for false rejections in smoke testing.
4. **R1 does not push anywhere.** `publish_story` is dry-run only by design (user asked for
   platform-agnostic). Real delivery lands in R3.
5. **Context retrieval deferred.** Phase 1's "query system documentation before drafting" is
   R2. Until then, the agent drafts without architectural context and may propose features
   that conflict with existing boundaries.
6. **Open question for R2:** which doc set should be indexed — this repo's
   `ARCHITECTURE.md`/`README.md`/`AGENTS.md`, or an external source?
7. **Open question for R3:** which provider adapter first? The canonical payload is
   provider-neutral; Azure DevOps is the one named in the issue, but GitHub Issues would need
   no new credentials since `GH_RELEASE_TOKEN` already exists.
8. **`next-env.d.ts` is modified in the working tree** (pre-existing, unrelated to this
   work). Do not commit it as part of this branch unless the user asks.

---

## Release Plan Summary

- **R1 — `feat/user-story-core-61` (this plan):** schema, structuring, refinement loop,
  canonical payload, dry-run provider, `product-owner` subagent. Phases 2 + 3.
- **R2 — `feat/user-story-ingestion-61`:** Phase 1 — feedback/ticket parsing (recurring
  pain-point extraction) and context retrieval.
- **R3 — `feat/user-story-backlog-61`:** Phase 4 — live platform-agnostic backlog push,
  starting with whichever provider the user picks.

Each release follows the same SDLC: plan branch → approval gate → TDD RED/GREEN → lint gate →
implementation commit → separate PR authorization.
