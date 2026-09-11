# Fix: Preview Evals on production (#79) + Release Notes not written (#80)

> **Issues:** [#79](https://github.com/ricardoblackskye/agent-eve/issues/79) · [#80](https://github.com/ricardoblackskye/agent-eve/issues/80)
> **Branch:** `fix/evals-release-notes-79-80`
> **Base:** `origin/main` @ `eb2dee0`
> **Plan date:** 2026-09-08

**Goal:** Stop the Preview Evals workflow failing on every production merge, and make the
Release Manager actually write `releasenotes.md` when a PR merges.

**Architecture:** Two independent fixes shipped on one branch, in two commits.
#79 is a workflow-condition change in `.github/workflows/preview-evals.yml`.
#80 is a visibility + fallback change: the release-notes write path currently fails
**silently**, so the first deliverable is making the failure observable, then fixing
whichever cause the evidence names.

**Tech Stack:** GitHub Actions, Next.js route handler, Eve subagent (`release-manager`),
Vitest 4, TypeScript 7 (strict), MegaLinter (cspell/prettier).

---

## Diagnosis (evidence gathered BEFORE planning)

### #79 — root cause: CONFIRMED

The workflow triggers on every successful `deployment_status`, including production.

- Failing run `34252971255`, branch `main`, created `2026-09-08T16:45:08Z`
- A **Production** deployment for `eb2dee0` was created `2026-09-08T16:45:06Z` — 2s earlier
- The job ran against `https://agent-2f89aukja-richard-lloyds-projects.vercel.app`
- Direct probe of that URL returns:
  ```json
  {
    "protection": { "vercel_auth_enabled": true },
    "error": { "message": "Protected deployment", "code": "401" }
  }
  ```
  i.e. **Vercel's deployment protection layer**, before any application code runs.

Production is already covered by the `production-evals` job in `ci.yml`, which targets
`https://agent-eve-gold.vercel.app` directly. Excluding production here loses no coverage.

### #80 — root cause: NARROWED, final cause NOT yet confirmed

The delivery chain is **healthy**. Webhook delivery `3841603189306564608` for the PR #77 merge:

```
event=pull_request action=closed status=OK code=200
response: {"ok":true,"message":"PR #77 closed acknowledged",
           "eveApiResult":"accepted","pr":{"number":77,"merged":true}}
```

So: signature verification passed, repo lookup succeeded, and the Eve session was
**accepted**. The Release Manager _was_ invoked — it simply never wrote the file. This rules
out the three causes the issue listed as possibilities (401 / 404 / 502).

Ruled out so far:

| Suspect                                         | Status                                                                          |
|-------------------------------------------------|---------------------------------------------------------------------------------|
| `GH_WEBHOOK_SECRET` mismatch                    | ❌ ruled out — delivery returned 200                                             |
| Repo missing from `release-manager.config.json` | ❌ ruled out — `ricardoblackskye/agent-eve` present                              |
| Eve API session failure (502)                   | ❌ ruled out — `eveApiResult: "accepted"`                                        |
| Hardcoded model dead on OpenRouter              | ❌ ruled out — `nvidia/nemotron-3-ultra-550b-a55b:free` is in the live catalogue |

Still open (cannot be resolved from this host):

1. **`GH_RELEASE_TOKEN` may lack `Contents: write`.** It was provisioned for the story-generation
   work (Issues scope), so Contents may never have been granted. Sensitive Vercel values are
   masked on `vercel env pull`, so scopes cannot be probed from here.
2. **The subagent may be failing after the session is accepted** — the webhook returns `ok:true`
   once the session is queued, so any later agent/tool failure is invisible in the delivery log.

Because (1) and (2) are indistinguishable from outside, **the first deliverable is observability**.

**Key asymmetry found:** `app/api/releasenotes/route.ts:9` falls back to `GITHUB_TOKEN`:

```ts
const token = process.env.GH_RELEASE_TOKEN || process.env.GITHUB_TOKEN || "";
```

`write_release_notes.ts:32` does **not** — it requires `GH_RELEASE_TOKEN` only.

---

## Task 1 — Stop Preview Evals running against production (#79)

**Objective:** Only run the preview eval job for preview deployments.

**Files:**

- Modify: `.github/workflows/preview-evals.yml` (lines 16-18)
- Test: `tests/preview-evals-workflow.test.ts`

**Step 1: Write the failing test**

```ts
// tests/preview-evals-workflow.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const wf = readFileSync(
  resolve(process.cwd(), ".github/workflows/preview-evals.yml"),
  "utf-8",
);

describe("Preview Evals workflow (#79)", () => {
  it("still triggers on deployment_status", () => {
    expect(wf).toMatch(/on:\s*\n\s*deployment_status:/);
  });

  it("still requires a successful deployment", () => {
    expect(wf).toMatch(/deployment_status\.state\s*==\s*'success'/);
  });

  it("excludes production deployments", () => {
    // Without this, a production merge points the job at a Vercel-auth-walled
    // URL and every eval fails with 401 before reaching the app.
    expect(wf).toMatch(/deployment_status\.environment\s*!=\s*'Production'/);
  });

  it("explains why production is excluded", () => {
    // Match the word plainly; a character-class regex trips cspell.
    expect(wf).toContain("Production deployments are excluded");
  });
});
```

**Step 2: Run to verify failure**
`npx vitest run tests/preview-evals-workflow.test.ts` — expect 2 failures (no environment
guard, no explanatory comment).

**Step 3: Minimal implementation**

```yaml
jobs:
  preview-evals:
    name: Vercel Preview Evals
    # Production deployments are excluded: their target_url is behind Vercel
    # Authentication, so the evals would hit the auth wall and fail with 401
    # before reaching the app. Production is covered by the `production-evals`
    # job in ci.yml, which targets agent-eve-gold.vercel.app directly.
    if: >-
      github.event.deployment_status.state == 'success' &&
      github.event.deployment_status.environment != 'Production'
```

**Step 4: Run to verify pass** — expect 4 passed.

**Step 5: Verify the guard value against a real payload.**
`deployment_status` exposes `environment`; confirm the production value is exactly
`Production` (capital P) from a real delivery before relying on the case. If it differs,
change the literal and the test together.

**Step 6: Commit**
`git commit -m "fix(ci): exclude production deployments from Preview Evals"`

---

## Task 2 — Surface release-notes write failures (#80, observability)

**Objective:** Make the silent failure visible so the remaining cause is identifiable from
the delivery log alone.

**Files:**

- Modify: `agent/subagents/release-manager/tools/write_release_notes.ts`
- Test: `tests/write-release-notes.test.ts`

**Step 1: Write the failing test**

```ts
// tests/write-release-notes.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import tool from "../agent/subagents/release-manager/tools/write_release_notes";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GH_RELEASE_TOKEN;
});

describe("write_release_notes (#80)", () => {
  it("returns a specific error when the token is missing (not a silent no-op)", async () => {
    delete process.env.GH_RELEASE_TOKEN;
    const r = await tool.execute({ content: "x" } as any, {} as any);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/GH_RELEASE_TOKEN/);
  });

  it("distinguishes a 403 (token scope) from other API errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ message: "Resource not accessible" }),
      }),
    );
    process.env.GH_RELEASE_TOKEN = "tok";
    const r = await tool.execute({ content: "x" } as any, {} as any);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/403|scope|Contents/i);
  });

  it("falls back to GITHUB_TOKEN when GH_RELEASE_TOKEN is unset", async () => {
    // app/api/releasenotes/route.ts already does this; the write path does not.
    delete process.env.GH_RELEASE_TOKEN;
    process.env.GITHUB_TOKEN = "gh-tok";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ content: { sha: "abc" }, commit: { sha: "def" } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const r = await tool.execute({ content: "x" } as any, {} as any);
    expect(r.success).toBe(true);
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers.authorization).toBe("Bearer gh-tok");
    delete process.env.GITHUB_TOKEN;
  });
});
```

**Step 2: Run to verify failure** — expect 3 failures.

**Step 3: Minimal implementation** — in `write_release_notes.ts`:

- Read `process.env.GH_RELEASE_TOKEN || process.env.GITHUB_TOKEN` (matching the read route).
- On `403`, return an error naming the **Contents: write** scope explicitly.
- Include the HTTP status in every error string.

**Step 4: Run to verify pass** — expect 3 passed.

**Step 5: Commit**
`git commit -m "fix(release-notes): surface write failures and allow GITHUB_TOKEN fallback"`

---

## Task 3 — Re-run the diagnostic and fix the confirmed cause (#80)

**Objective:** With observability in place, re-deliver a real PR merge and act on what it reports.

**Steps:**

1. Merge the branch (or redeliver an existing `pull_request` `closed` delivery from
   **Settings → Webhooks → Recent Deliveries**) and read the response body.
2. Branch on the result:

| Observed                 | Cause                             | Fix                                                                 |
|--------------------------|-----------------------------------|---------------------------------------------------------------------|
| `403` mentioning scope   | Token lacks `Contents: write`     | Re-mint the PAT with Contents **and** Issues; update `.env.example` |
| `200` but no file change | Subagent failing after acceptance | Inspect agent logs; add the failure to the webhook response         |
| `200` and file written   | Already fixed by Task 2           | Close #80 with evidence                                             |

3. If the token needs re-minting, document the exact scopes in `.env.example` and the README.

**Note:** I cannot verify token scopes or read Vercel runtime logs from this host. If step 1-2
requires the Vercel dashboard, I will report that as a blocker rather than guess.

---

## Task 4 — Lint gate + full verification (MANDATORY before push)

1. `npx vitest run` — expect **59 → 66 tests, all passing** (4 new + 3 new).
2. `npx tsc --noEmit` — clean.
3. `npm run build` — succeeds.
4. `npx -y cspell@8 --config .cspell.json` on all new/changed files including this plan.
5. `npx -y prettier@3 --write` on all new/changed files, then re-run tests.

**Commit**
`git commit -m "fix(lint): satisfy cspell and prettier for #79/#80"`

---

## Files Likely to Change

| File                                                           | Action                                              |
|----------------------------------------------------------------|-----------------------------------------------------|
| `.github/workflows/preview-evals.yml`                          | Modify (add production guard + comment)             |
| `tests/preview-evals-workflow.test.ts`                         | Create                                              |
| `agent/subagents/release-manager/tools/write_release_notes.ts` | Modify (fallback + explicit 403)                    |
| `tests/write-release-notes.test.ts`                            | Create                                              |
| `.env.example`                                                 | Possibly modify (document Contents + Issues scopes) |
| `README.md`                                                    | Possibly modify (same)                              |
| `.cspell.json`                                                 | Possibly modify (new terms)                         |
| `.hermes/plans/2026-09-08_fix-evals-release-notes-79-80.md`    | This file                                           |

**Not changed:** `app/api/github/webhook/route.ts` (delivery chain proven healthy — no change
justified), `release-manager.config.json` (repo already registered), CI workflow jobs.

---

## Validation

- **Unit:** `npx vitest run` — no regressions from the 59-test baseline.
- **Types / build:** `tsc --noEmit` clean, `npm run build` succeeds.
- **Lint:** cspell + prettier clean on every touched file, including this plan.
- **#79 end-to-end:** after merge, a production deployment must **not** trigger
  `Preview Evals`; the next preview deployment must still run it and pass.
- **#80 end-to-end:** a merged PR appends an entry to `releasenotes.md`; a misconfigured
  token produces a visible error instead of silence.

---

## Risks / Open Questions

1. **`deployment_status.environment` exact value is unverified.** The guard assumes
   `Production` (capital P). Task 1 Step 5 verifies this against a real payload; if it is
   `production`, the literal and its test change together.
2. **#80's final cause is not yet confirmed.** Task 2 makes it observable; Task 3 fixes
   whatever it reports. If it needs Vercel dashboard access I cannot get, I will say so
   rather than guess.
3. **Adding a `GITHUB_TOKEN` fallback could mask a missing `GH_RELEASE_TOKEN`.** On Vercel
   `GITHUB_TOKEN` is generally absent, so this mainly helps GitHub-Actions contexts. Scope it
   as a fallback only, never a replacement.
4. **The webhook returns `ok:true` once the session is queued**, so agent-side failures remain
   invisible in the delivery log even after Task 2. Truly fixing that means awaiting the
   subagent or surfacing a callback — deliberately out of scope here; note it as follow-up.
5. **`next-env.d.ts` is modified in the working tree** (pre-existing, unrelated). Do not
   commit it unless asked.

---

## Release Plan

Single release — both fixes are small and independent:

1. Task 1 — Preview Evals guard (#79)
2. Task 2 — release-notes observability (#80)
3. Task 3 — fix the confirmed cause (#80)
4. Task 4 — lint gate and push

SDLC: plan pushed for approval → TDD RED/GREEN per task → lint gate → implementation
commits → **separate** PR authorization.
