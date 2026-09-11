# User Story (Issue) Generation — Implementation Plan

> **Issue:** [#61 — User Story (Issue) Generation](https://github.com/ricardoblackskye/agent-eve/issues/61)
> **Parent:** [#55 — Requirements and Planning Handling](https://github.com/ricardoblackskye/agent-eve/issues/55) (Portfolio Epic)
> **Branch (R1):** `feat/user-story-core-61`
> **Plan date:** 2026-09-08

**Goal:** A Product Owner drafts a rough feature request as a GitHub issue and tags the Eve
Agent. Eve turns it into a machine-readable, AI-ready user story and **creates a new linked
story issue** on GitHub. When the request is too vague to do that safely, Eve **comments the
clarifying questions back on the original issue and stops**, waiting for the answer.

**Architecture:** A new declared Eve subagent `agent/subagents/product-owner/` with its own
`instructions.md` and two tools. Deterministic logic (trigger detection, template validation,
refinement-gap detection, NFR injection) lives in import-only `agent/lib/`, unit-tested with
Vitest; the LLM handles only the genuinely fuzzy work (prose intent, examples, constraints).
Backlog delivery stays **platform-agnostic** — the agent always emits a canonical JSON payload
and a provider adapter translates it — but R1 ships **GitHub as the first real provider**, so
the loop is end-to-end usable. A dry-run `console` provider remains the default for safety.

**End-to-end R1 flow:**

```text
PO opens GitHub issue mentioning @eve-agent (or applies the trigger label)
        │
        ▼
POST /api/github/webhook   (x-github-event: issues)
        │  verify GH_WEBHOOK_SECRET, look up repo config
        │  detect trigger → build message → POST /eve/v1/session
        ▼
product-owner subagent
        │  draft_user_story
        ├── needs_clarification → comment questions on original issue → STOP
        └── complete           → publish_story (github provider)
                                      │
                                      ▼
                        new story issue created, linked back to the original
```

**Tech Stack:** Eve framework (`defineAgent`, `defineTool`), Zod 4.4.3, TypeScript 7.0.2
(strict), Vitest 4 (`tests/**/*.test.ts`), Playwright (e2e), MegaLinter (cspell/prettier).

---

## Release Split (agreed with user)

Issue #61 has 4 phases. They are split across **3 releases** so each is independently
reviewable, deployable, and useful:

| Release            | Branch                         | Issue phases         | Scope                                                                                                      |
|--------------------|--------------------------------|----------------------|------------------------------------------------------------------------------------------------------------|
| **R1** (this plan) | `feat/user-story-core-61`      | Phase 2 + 3 + 4 (GH) | GitHub-issue trigger, story schema, structuring, refinement loop, canonical payload, **real GitHub write** |
| **R2**             | `feat/user-story-ingestion-61` | Phase 1              | Feedback/ticket parsing + context retrieval                                                                |
| **R3**             | `feat/user-story-backlog-61`   | Phase 4 (others)     | Additional platform-agnostic providers (Azure DevOps, Jira) behind the same payload + provider interface   |

Clarifications the user gave while scoping:

- **Backlog integration must be platform agnostic.** Not Azure-DevOps-only. R1 defines the
  canonical payload + provider interface and ships **GitHub as the first real adapter** (no new
  credentials — reuses `GH_RELEASE_TOKEN`). Azure DevOps / Jira arrive as further adapters in R3
  behind the same interface. The dry-run `console` provider stays the default.
- **Context retrieval (Phase 1) is out of scope for R1.** No doc-querying tool in R1. R2
  covers it. This is noted as a known R1 limitation.
- **R1 delivers the full loop** — trigger, draft, and create the linked issue — rather than a
  dry-run core only.
- **Trigger = both signals:** `issues.opened` when the body mentions the agent, **and**
  `issues.labeled` with a trigger label.
- **Refinement questions are posted as a comment on the original issue**, then the run stops
  and waits for the answer. No story issue is created until the gaps are filled.

### On "tagging the Eve Agent"

GitHub has no "@mention" webhook event — a mention is not an event in itself, so it cannot be
subscribed to directly. The trigger is therefore implemented by **inspecting the issue payload**
for a trigger signal. Two independent signals are supported, both detected from the payload:

| Signal              | Event            | Detection                                                                |
|---------------------|------------------|--------------------------------------------------------------------------|
| Mention in the body | `issues.opened`  | issue body contains the configured mention string (default `@eve-agent`) |
| Trigger label       | `issues.labeled` | `issue.labels` contains the configured label (default `needs-story`)     |

This is why the webhook subscribes to the generic **`issues`** event and branches in code,
rather than reacting to a dedicated mention event that does not exist.

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
- **The root `agent/agent.ts` is env-driven, NOT unconditionally mocked.** It calls
  `resolveChatModel()` from `agent/chat-model.ts`, which returns the **live OpenRouter model
  (`deepseek/deepseek-v4-pro`, or `EVE_CHAT_MODEL`) when `OPENROUTER_API_KEY` is set**, and
  falls back to `mockModel` only when that key is absent. Consequence: the webhook-triggered
  flow runs against a real model in production, so R1's output quality depends on
  `OPENROUTER_API_KEY` being configured. (An earlier draft of this plan wrongly claimed the
  root always uses `mockModel`; that was read from a stale local `main` and is corrected here.)
- **The webhook currently handles only `pull_request` and `ping`.** `app/api/github/webhook/route.ts`
  branches on `event === "pull_request"` (line 116) and `event === "ping"`; everything else
  falls through to `200 {"ok": true, "message": "Event '<x>' received but not processed"}`.
  Adding an `issues` branch is **purely additive** — no existing behaviour changes.
- The existing PR flow already does the hard parts we reuse: HMAC `x-hub-signature-256`
  verification against a per-repo secret, repo lookup in `release-manager.config.json`, and
  firing an Eve session via `POST /eve/v1/session` with a composed `message`.
- **Token scope risk (unverified):** `GH_RELEASE_TOKEN` is presently used only for GitHub
  _contents_ read/write (`releasenotes.md`). Creating issues and comments requires
  **`issues: write`**. I cannot verify the PAT's scopes from here — if it lacks them the write
  fails with 403 and a PAT with `issues: write` must be minted. See Risk 9.
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

  it("has all three tools in its tools directory", () => {
    const tools = fs.readdirSync(path.join(dir, "tools"));
    expect(tools).toContain("draft_user_story.ts");
    expect(tools).toContain("publish_story.ts");
    expect(tools).toContain("comment_questions.ts");
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

`instructions.md` must cover:

- the five required sections (intent, machine-verifiable acceptance criteria, concrete
  examples, explicit MUST/SHOULD constraints, NFRs);
- the **GitHub workflow**: when invoked from an issue, call `draft_user_story` first;
- if `draft_user_story` returns `needs_clarification`, call `comment_questions` with the
  originating `owner`/`repo`/`issueNumber`, then **stop and wait** — do not create a story
  issue in that run;
- if it returns `complete`, call `publish_story` with provider `github` and the
  `sourceIssueNumber` so the new issue links back to the source;
- never invent detail to fill a gap — asking is always preferred to guessing.

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

```bash
npm run dev -- --hostname 127.0.0.1 --port 3000 &
npx eve eval --url http://127.0.0.1:3000
```

**Step: Commit**
`git commit -m "test(evals): add product-owner subagent registration eval"`

---

## Task 8 — Trigger detection (`agent/lib/story-trigger.ts`)

**Objective:** Decide, purely and testably, whether an incoming GitHub `issues` payload should
start the story workflow. Keeping this in `lib/` means the webhook and its tests share one
implementation.

**Files:**

- Create: `agent/lib/story-trigger.ts`
- Test: `tests/story-trigger.test.ts`

**Step 1: Write the failing test**

```ts
// tests/story-trigger.test.ts
import { describe, it, expect } from "vitest";
import { isStoryTrigger, TRIGGER_DEFAULTS } from "../agent/lib/story-trigger";

const basePayload = {
  action: "opened",
  issue: {
    number: 7,
    title: "Export CSV",
    body: "We need CSV export",
    labels: [],
  },
};

describe("isStoryTrigger", () => {
  it("fires on issues.opened when the body mentions the agent", () => {
    expect(
      isStoryTrigger({
        ...basePayload,
        issue: { ...basePayload.issue, body: "@eve-agent please draft this" },
      }),
    ).toBe(true);
  });

  it("does not fire on issues.opened without a mention", () => {
    expect(isStoryTrigger(basePayload)).toBe(false);
  });

  it("fires on issues.labeled with the trigger label", () => {
    expect(
      isStoryTrigger({
        action: "labeled",
        issue: { ...basePayload.issue, labels: [{ name: "needs-story" }] },
        label: { name: "needs-story" },
      }),
    ).toBe(true);
  });

  it("does not fire on issues.labeled with an unrelated label", () => {
    expect(
      isStoryTrigger({
        action: "labeled",
        issue: { ...basePayload.issue, labels: [{ name: "bug" }] },
        label: { name: "bug" },
      }),
    ).toBe(false);
  });

  it("is case-insensitive on the label", () => {
    expect(
      isStoryTrigger({
        action: "labeled",
        issue: { ...basePayload.issue, labels: [{ name: "Needs-Story" }] },
        label: { name: "Needs-Story" },
      }),
    ).toBe(true);
  });

  it("does not fire on issues.closed", () => {
    expect(
      isStoryTrigger({
        ...basePayload,
        action: "closed",
        issue: { ...basePayload.issue, body: "@eve-agent" },
      }),
    ).toBe(false);
  });

  it("does not fire on a pull_request payload", () => {
    expect(
      isStoryTrigger({ action: "opened", pull_request: { number: 1 } }),
    ).toBe(false);
  });

  it("respects env overrides for mention and label", () => {
    process.env.EVE_STORY_MENTION = "@eve-bot";
    expect(
      isStoryTrigger({
        ...basePayload,
        issue: { ...basePayload.issue, body: "@eve-bot draft this" },
      }),
    ).toBe(true);
    delete process.env.EVE_STORY_MENTION;
  });

  it("exposes defaults", () => {
    expect(TRIGGER_DEFAULTS.mention).toBe("@eve-agent");
    expect(TRIGGER_DEFAULTS.label).toBe("needs-story");
  });
});
```

**Step 2: Run to verify failure** — `npx vitest run tests/story-trigger.test.ts` → FAIL.

**Step 3: Write the minimal implementation**

```ts
// agent/lib/story-trigger.ts
export const TRIGGER_DEFAULTS = {
  mention: "@eve-agent",
  label: "needs-story",
} as const;

interface IssueLike {
  body?: string | null;
  labels?: Array<{ name?: string } | string>;
}

interface PayloadLike {
  action?: string;
  issue?: IssueLike;
  label?: { name?: string };
  pull_request?: unknown;
}

function config() {
  return {
    mention: process.env.EVE_STORY_MENTION || TRIGGER_DEFAULTS.mention,
    label: process.env.EVE_STORY_LABEL || TRIGGER_DEFAULTS.label,
  };
}

function labelNames(issue?: IssueLike): string[] {
  return (issue?.labels ?? []).map((l) =>
    typeof l === "string" ? l : (l?.name ?? ""),
  );
}

export function isStoryTrigger(payload: PayloadLike): boolean {
  if (!payload || payload.pull_request) return false;
  if (!payload.issue) return false;

  const { mention, label } = config();
  const action = payload.action;

  if (action === "opened" || action === "edited" || action === "reopened") {
    return (payload.issue.body ?? "")
      .toLowerCase()
      .includes(mention.toLowerCase());
  }

  if (action === "labeled") {
    const wanted = label.toLowerCase();
    const onIssue = labelNames(payload.issue).some(
      (n) => n.toLowerCase() === wanted,
    );
    const applied = (payload.label?.name ?? "").toLowerCase() === wanted;
    return onIssue || applied;
  }

  return false;
}
```

**Step 4: Run to verify pass** — expected 9 passed.

**Step 5: Commit**
`git commit -m "feat(story): add GitHub issue trigger detection"`

---

## Task 9 — GitHub backlog provider (`agent/lib/backlog-provider.ts`)

**Objective:** Make the canonical payload deliverable for real. GitHub is the first provider
adapter; `console` stays the default so nothing writes unless explicitly selected.

**Files:**

- Modify: `agent/lib/backlog-provider.ts`
- Test: `tests/github-provider.test.ts`

**Step 1: Write the failing test**

```ts
// tests/github-provider.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { getProvider, toCanonicalPayload } from "../agent/lib/backlog-provider";
import type { UserStory } from "../agent/lib/story-schema";

const story: UserStory = {
  id: "US-001",
  title: "Export report as CSV",
  intent: "A project manager can export the sprint report as a CSV file.",
  acceptanceCriteria: [
    { given: "12 items", when: "click Export", then: "12 rows download" },
  ],
  examples: [{ input: "click Export", output: "report.csv" }],
  constraints: ["MUST NOT block the UI thread"],
  nfrs: { performance: "p95 < 2s", security: "tenant scoped", latency: "n/a" },
  openQuestions: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GH_RELEASE_TOKEN;
});

describe("github provider", () => {
  it("renders the story as issue markdown with every section", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        number: 42,
        html_url: "https://github.com/o/r/issues/42",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    process.env.GH_RELEASE_TOKEN = "tok";

    await getProvider("github").publish(toCanonicalPayload(story));

    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body as string);
    expect(body.title).toContain("US-001");
    expect(body.body).toContain("Acceptance Criteria");
    expect(body.body).toContain("Constraints");
    expect(body.body).toContain("NFR");
  });

  it("links the created issue back to the originating issue", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        number: 42,
        html_url: "https://github.com/o/r/issues/42",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    process.env.GH_RELEASE_TOKEN = "tok";

    await getProvider("github").publish(toCanonicalPayload(story), {
      sourceIssueNumber: 7,
      owner: "o",
      repo: "r",
    });

    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body as string);
    expect(body.body).toContain("#7");
  });

  it("posts to the GitHub issues API with a bearer token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ number: 42, html_url: "https://x/42" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    process.env.GH_RELEASE_TOKEN = "tok";

    await getProvider("github").publish(toCanonicalPayload(story), {
      owner: "o",
      repo: "r",
    });

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/o/r/issues");
    expect(options.headers.authorization).toBe("Bearer tok");
  });

  it("refuses to write when the token is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    delete process.env.GH_RELEASE_TOKEN;

    const res = await getProvider("github").publish(toCanonicalPayload(story), {
      owner: "o",
      repo: "r",
    });

    expect(res.delivered).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a 403 as a permissions problem", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ message: "Resource not accessible" }),
      }),
    );
    process.env.GH_RELEASE_TOKEN = "tok";

    const res = await getProvider("github").publish(toCanonicalPayload(story), {
      owner: "o",
      repo: "r",
    });

    expect(res.delivered).toBe(false);
    expect(res.message).toMatch(/403|permission|scope/i);
  });
});
```

**Step 2: Run to verify failure** — `npx vitest run tests/github-provider.test.ts` → FAIL.

**Step 3: Write the minimal implementation** — extend `backlog-provider.ts`:

```ts
export interface PublishTarget {
  owner?: string;
  repo?: string;
  sourceIssueNumber?: number;
}

function renderIssueBody(p: CanonicalPayload, source?: number): string {
  const s = p.story;
  return [
    source ? `Derived from #${source}` : "",
    "",
    `## Intent`,
    s.intent,
    "",
    `## Acceptance Criteria`,
    ...s.acceptanceCriteria.map(
      (ac, i) =>
        `${i + 1}. **Given** ${ac.given} — **When** ${ac.when} — **Then** ${ac.then}`,
    ),
    "",
    `## Examples`,
    ...s.examples.map(
      (ex) => `- Input: \`${ex.input}\` → Output: \`${ex.output}\``,
    ),
    "",
    `## Constraints`,
    ...s.constraints.map((c) => `- ${c}`),
    "",
    `## Non-Functional Requirements`,
    `- Performance: ${s.nfrs.performance}`,
    `- Security: ${s.nfrs.security}`,
    `- Latency: ${s.nfrs.latency}`,
  ]
    .filter((l) => l !== undefined)
    .join("\n");
}

const githubProvider: BacklogProvider = {
  id: "github",
  async publish(payload, target: PublishTarget = {}) {
    const token = process.env.GH_RELEASE_TOKEN;
    const owner = target.owner || process.env.VERCEL_GIT_REPO_OWNER;
    const repo = target.repo || process.env.VERCEL_GIT_REPO_SLUG;

    if (!token) {
      return {
        delivered: false,
        mode: "dry-run",
        provider: "github",
        message: "GH_RELEASE_TOKEN is not set; nothing was created.",
      };
    }
    if (!owner || !repo) {
      return {
        delivered: false,
        mode: "dry-run",
        provider: "github",
        message:
          "Target owner/repo could not be resolved; nothing was created.",
      };
    }

    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/vnd.github+json",
        },
        body: JSON.stringify({
          title: `[${payload.story.id}] ${payload.story.title}`,
          body: renderIssueBody(payload, target.sourceIssueNumber),
          labels: ["user-story"],
        }),
      },
    );

    const data = await response.json();
    if (!response.ok) {
      return {
        delivered: false,
        mode: "live",
        provider: "github",
        message:
          response.status === 403
            ? `GitHub rejected the write with 403 — the token likely lacks 'issues: write'. ${data?.message ?? ""}`
            : `GitHub API error (${response.status}): ${data?.message ?? response.statusText}`,
      };
    }

    return {
      delivered: true,
      mode: "live",
      provider: "github",
      reference: String(data.number),
      message: `Created issue #${data.number}: ${data.html_url}`,
    };
  },
};
```

`getProvider` must now return `githubProvider` for `"github"` and accept an optional `target`
argument on `publish`.

**Step 4: Run to verify pass** — expected 5 passed.

**Step 5: Commit**
`git commit -m "feat(story): add GitHub backlog provider adapter"`

---

## Task 10 — `comment_questions` tool (refinement loop on GitHub)

**Objective:** Phase 3's "push a clarifying question back to the Product Owner". Per the user's
decision, questions are posted as a **comment on the original issue** and the run stops — no
story issue is created until the gaps are answered.

**Files:**

- Create: `agent/subagents/product-owner/tools/comment_questions.ts`
- Test: `tests/comment-questions.test.ts`

**Step 1: Write the failing test**

```ts
// tests/comment-questions.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import tool from "../agent/subagents/product-owner/tools/comment_questions";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GH_RELEASE_TOKEN;
});

describe("comment_questions", () => {
  it("posts the questions as a comment on the source issue", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: 1 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    process.env.GH_RELEASE_TOKEN = "tok";

    await tool.execute(
      {
        owner: "o",
        repo: "r",
        issueNumber: 7,
        questions: ["Who is the user?", "What is the exact output?"],
      } as any,
      {} as any,
    );

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/o/r/issues/7/comments");
    const body = JSON.parse(options.body as string);
    expect(body.body).toContain("Who is the user?");
    expect(body.body).toContain("What is the exact output?");
  });

  it("does not attempt a write when the token is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    delete process.env.GH_RELEASE_TOKEN;

    const r = await tool.execute(
      { owner: "o", repo: "r", issueNumber: 7, questions: ["q"] } as any,
      {} as any,
    );

    expect(r.posted).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a 403 as a missing issues:write scope", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({ ok: false, status: 403, json: async () => ({}) }),
    );
    process.env.GH_RELEASE_TOKEN = "tok";

    const r = await tool.execute(
      { owner: "o", repo: "r", issueNumber: 7, questions: ["q"] } as any,
      {} as any,
    );

    expect(r.posted).toBe(false);
    expect(r.error).toMatch(/403|scope|issues: write/i);
  });

  it("returns the questions so the agent can surface them", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({ ok: true, status: 201, json: async () => ({}) }),
    );
    process.env.GH_RELEASE_TOKEN = "tok";

    const r = await tool.execute(
      { owner: "o", repo: "r", issueNumber: 7, questions: ["q1"] } as any,
      {} as any,
    );

    expect(r.questions).toEqual(["q1"]);
  });
});
```

**Step 2: Run to verify failure** — `npx vitest run tests/comment-questions.test.ts` → FAIL.

**Step 3: Write the minimal implementation**

```ts
// agent/subagents/product-owner/tools/comment_questions.ts
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description:
    "Post clarifying questions as a comment on the originating GitHub issue, then stop " +
    "and wait for the Product Owner to answer. Use this when draft_user_story returns " +
    "status 'needs_clarification'. Do NOT create the story issue until the " +
    "questions have been answered.",
  inputSchema: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    issueNumber: z.number().int().positive(),
    questions: z.array(z.string().min(1)).min(1),
  }),
  async execute({ owner, repo, issueNumber, questions }) {
    const token = process.env.GH_RELEASE_TOKEN;
    if (!token) {
      return {
        posted: false,
        error: "GH_RELEASE_TOKEN is not set; could not post the questions.",
        questions,
      };
    }

    const body = [
      "Thanks — before I can turn this into an AI-ready user story I need a bit more detail.",
      "",
      ...questions.map((q, i) => `${i + 1}. ${q}`),
      "",
      "Reply here and I'll draft the story.",
    ].join("\n");

    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/vnd.github+json",
        },
        body: JSON.stringify({ body }),
      },
    );

    if (!response.ok) {
      return {
        posted: false,
        error:
          response.status === 403
            ? `GitHub returned 403 — the token likely lacks the 'issues: write' scope.`
            : `GitHub API error (${response.status})`,
        questions,
      };
    }

    return { posted: true, questions };
  },
});
```

**Step 4: Run to verify pass** — expected 4 passed.

**Step 5: Commit**
`git commit -m "feat(story): add comment_questions tool for refinement loop"`

---

## Task 11 — Webhook `issues` branch

**Objective:** Wire the trigger into the existing webhook so a tagged issue starts the
Product Owner. Purely additive — the `pull_request` path is untouched.

**Files:**

- Modify: `app/api/github/webhook/route.ts`
- Test: `tests/webhook-issues.test.ts`

**Step 1: Write the failing test**

```ts
// tests/webhook-issues.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((data: any, init?: any) => ({
      status: init?.status ?? 200,
      body: JSON.stringify(data),
    })),
  },
}));

function issueRequest(payload: any) {
  return {
    method: "POST" as const,
    headers: new Headers({
      "content-type": "application/json",
      "x-github-event": "issues",
    }),
    text: async () => JSON.stringify(payload),
    nextUrl: new URL("http://localhost:3000/api/github/webhook"),
  } as any;
}

describe("webhook - issues event", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: "accepted" }),
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("starts the Product Owner when the body mentions the agent", async () => {
    const { POST } = await import("../app/api/github/webhook/route");
    const res = await POST(
      issueRequest({
        action: "opened",
        issue: {
          number: 7,
          title: "CSV export",
          body: "@eve-agent draft this",
        },
        repository: { full_name: "ricardoblackskye/agent-eve" },
      }),
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
  });

  it("starts the Product Owner when the trigger label is applied", async () => {
    const { POST } = await import("../app/api/github/webhook/route");
    const res = await POST(
      issueRequest({
        action: "labeled",
        issue: {
          number: 7,
          title: "CSV export",
          body: "no mention",
          labels: [{ name: "needs-story" }],
        },
        label: { name: "needs-story" },
        repository: { full_name: "ricardoblackskye/agent-eve" },
      }),
    );
    expect(JSON.parse(res.body).ok).toBe(true);
  });

  it("acknowledges but does NOT trigger on an untagged issue", async () => {
    const { POST } = await import("../app/api/github/webhook/route");
    const res = await POST(
      issueRequest({
        action: "opened",
        issue: { number: 7, title: "CSV export", body: "just an idea" },
        repository: { full_name: "ricardoblackskye/agent-eve" },
      }),
    );
    const data = JSON.parse(res.body);
    expect(data.ok).toBe(true);
    expect(data.triggered).toBeFalsy();
  });

  it("still returns 'No PR data' for an empty pull_request payload (no regression)", async () => {
    const { POST } = await import("../app/api/github/webhook/route");
    const res = await POST({
      method: "POST" as const,
      headers: new Headers({
        "content-type": "application/json",
        "x-github-event": "pull_request",
      }),
      text: async () =>
        JSON.stringify({
          action: "opened",
          repository: { full_name: "test/repo" },
        }),
      nextUrl: new URL("http://localhost:3000/api/github/webhook"),
    } as any);
    expect(JSON.parse(res.body).error).toBe("No PR data");
  });
});
```

**Step 2: Run to verify failure** — `npx vitest run tests/webhook-issues.test.ts` → FAIL
(untagged issue currently returns `{ok:true, message:"Event 'issues' received but not processed"}`
without `triggered`, and no Eve session is fired).

**Step 3: Write the minimal implementation** — add an `issues` branch in
`app/api/github/webhook/route.ts` before the final fall-through:

```ts
if (event === "issues") {
  const issue = data.issue;
  if (!issue) {
    return NextResponse.json({ error: "No issue data" }, { status: 400 });
  }

  if (!isStoryTrigger(data)) {
    return NextResponse.json({
      ok: true,
      triggered: false,
      message: `Issue #${issue.number} acknowledged; no story trigger present`,
    });
  }

  const message = [
    `Draft an AI-ready user story from this GitHub issue:`,
    ``,
    `Repository: ${repoFullName}`,
    `Issue #${issue.number}: ${issue.title}`,
    `Body: ${(issue.body || "").slice(0, 2000)}`,
    ``,
    `Call draft_user_story. If it returns 'needs_clarification', call`,
    `comment_questions with owner/repo for this repository and issueNumber`,
    `${issue.number}, then stop and wait. If it returns 'complete', call`,
    `publish_story with provider 'github' and sourceIssueNumber ${issue.number}.`,
  ].join("\n");

  // ...same POST /eve/v1/session call as the pull_request branch...
}
```

The `POST /eve/v1/session` call is identical to the existing PR path, so extract it into a
shared `startEveSession(request, message)` helper used by both branches rather than
duplicating it (DRY).

**Step 4: Run to verify pass** — expected 4 passed, plus existing `webhook.eval.ts`
behaviour unchanged.

**Step 5: Commit**
`git commit -m "feat(webhook): trigger Product Owner from tagged GitHub issues"`

---

## Task 12 — Lint gate + full verification (MANDATORY before push)

**Objective:** MegaLinter (cspell + prettier) and the full suite must be green locally.

**Steps:**

1. `npx vitest run` — expect **7 → 17 files, 33 → 76 tests, all passing**
   (43 new: 8 schema + 6 refinement + 5 provider + 4 draft + 3 publish + 6 agent +
   9 trigger + 5 github + 4 comment + 4 webhook, minus overlap).
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

| File                                                        | Action                                                                            |
|-------------------------------------------------------------|-----------------------------------------------------------------------------------|
| `agent/lib/story-schema.ts`                                 | Create                                                                            |
| `agent/lib/story-refinement.ts`                             | Create                                                                            |
| `agent/lib/backlog-provider.ts`                             | Create (+ GitHub adapter in Task 9)                                               |
| `agent/lib/story-trigger.ts`                                | Create                                                                            |
| `agent/subagents/product-owner/agent.ts`                    | Create                                                                            |
| `agent/subagents/product-owner/instructions.md`             | Create                                                                            |
| `agent/subagents/product-owner/tools/draft_user_story.ts`   | Create                                                                            |
| `agent/subagents/product-owner/tools/publish_story.ts`      | Create                                                                            |
| `agent/subagents/product-owner/tools/comment_questions.ts`  | Create                                                                            |
| `app/api/github/webhook/route.ts`                           | **Modify** (additive `issues` branch + shared `startEveSession` helper)           |
| `tests/story-schema.test.ts`                                | Create                                                                            |
| `tests/story-refinement.test.ts`                            | Create                                                                            |
| `tests/backlog-provider.test.ts`                            | Create                                                                            |
| `tests/github-provider.test.ts`                             | Create                                                                            |
| `tests/story-trigger.test.ts`                               | Create                                                                            |
| `tests/draft-user-story.test.ts`                            | Create                                                                            |
| `tests/publish-story.test.ts`                               | Create                                                                            |
| `tests/comment-questions.test.ts`                           | Create                                                                            |
| `tests/webhook-issues.test.ts`                              | Create                                                                            |
| `tests/product-owner-agent.test.ts`                         | Create                                                                            |
| `evals/product-owner.eval.ts`                               | Create                                                                            |
| `README.md`                                                 | Modify — document the trigger (mention / label) and required webhook subscription |
| `.cspell.json`                                              | Modify (new project terms)                                                        |
| `.hermes/plans/2026-09-08_feat-user-story-generation-61.md` | This file                                                                         |

**Not changed in R1:** `agent/agent.ts` and `agent/chat-model.ts` (root model resolution is
already env-driven), `release-manager.config.json` (repo lookup reused as-is), any CI workflow.

---

## Validation

- **Unit:** `npx vitest run` — baseline 33 tests must stay green; ~26 new tests added.
- **Types:** `npx tsc --noEmit` — clean.
- **Build:** `npm run build` — succeeds (Eve compiles the new subagent).
- **Evals:** `npx eve eval --url http://127.0.0.1:3000` — `product-owner.eval.ts` passes
  (untagged, so it also runs in CI).
- **Lint:** cspell + prettier clean on all new/changed files **including this plan file**.
- **Manual smoke (local):** start `npm run dev`, `curl` the webhook with an `issues` payload
  containing `@eve-agent` and confirm the response is `{"ok": true, "triggered": true}`.
- **Manual smoke (real, requires deploy + token):** open a real GitHub issue that mentions the
  agent, confirm Eve creates the linked story issue; then open a deliberately vague one and
  confirm it comments questions back and does **not** create an issue.
- **Webhook subscription (manual, one-time):** the existing GitHub webhook must be extended to
  subscribe to **Issues** in addition to **Pull request**. This is a repo Settings change the
  plan documents but cannot create.

### Deployment prerequisites

| Requirement                             | Why                                                                          |
|-----------------------------------------|------------------------------------------------------------------------------|
| Webhook subscribes to **Issues**        | Without it GitHub never sends the `issues` event                             |
| `GH_RELEASE_TOKEN` with `issues: write` | Required to create the story issue and post comment questions                |
| `OPENROUTER_API_KEY`                    | Without it the root agent falls back to `mockModel` and produces canned text |
| `GH_WEBHOOK_SECRET`                     | Already used; unchanged                                                      |
| Label `needs-story` (optional)          | Only needed for the label trigger; mention trigger needs no setup            |

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
4. **R1 ships a real GitHub write** (user's decision). The `console` dry-run provider remains
   the default, so nothing is written unless `publish_story` is called with provider `github`.
   The created issue links back via a "Derived from #N" line rather than a native GitHub
   "closes" link — GitHub has no first-class parent/child issue link in the REST API.
5. **Context retrieval deferred.** Phase 1's "query system documentation before drafting" is
   R2. Until then, the agent drafts without architectural context and may propose features
   that conflict with existing boundaries.
6. **Open question for R2:** which doc set should be indexed — this repo's
   `ARCHITECTURE.md`/`README.md`/`AGENTS.md`, or an external source?
7. **Open question for R3:** which provider adapter next? The canonical payload is
   provider-neutral; Azure DevOps is the one named in the issue.
8. **Loops.** Eve creating an issue triggers no further webhook (Eve is not a GitHub user
   being mentioned), so there is no infinite-loop risk. But a PO editing the source issue to
   mention the agent again — or re-applying the trigger label — would start another run.
   Acceptable for R1; if it becomes noisy, add a `story-drafted` label guard.
9. **`GH_RELEASE_TOKEN` scope is the main delivery risk (unverified).** The token is currently
   used only for _contents_ read/write. Creating issues and comments needs **`issues: write`**.
   If the PAT lacks it, both `publish_story` and `comment_questions` return the 403 path
   designed in Tasks 9/10 — the flow degrades to "no output" rather than crashing. The user
   should confirm or re-mint the PAT before deployment.
10. **`next-env.d.ts` is modified in the working tree** (pre-existing, unrelated to this
    work). Do not commit it as part of this branch unless the user asks.

---

## Release Plan Summary

- **R1 — `feat/user-story-core-61` (this plan):** GitHub-issue trigger (mention + label),
  story schema, structuring, refinement loop, canonical payload, and **GitHub as the first real
  provider** — full loop: trigger → draft → linked issue created. Phases 2 + 3 + 4(GitHub).
- **R2 — `feat/user-story-ingestion-61`:** Phase 1 — feedback/ticket parsing (recurring
  pain-point extraction) and context retrieval.
- **R3 — `feat/user-story-backlog-61`:** Phase 4 — live platform-agnostic backlog push,
  starting with whichever provider the user picks.

Each release follows the same SDLC: plan branch → approval gate → TDD RED/GREEN → lint gate →
implementation commit → separate PR authorization.
