# Proxy Protection Bypass Header Implementation Plan

> **Goal:** Add `x-vercel-protection-bypass` header to the server-side proxy so preview deployments work with Vercel Deployment Protection enabled.

**Issue:** #15

**Problem:** The preview deployment has Vercel Deployment Protection enabled. The browser loads its page via cookie, but the server-side proxy's `fetch()` back to `/eve/v1/*` carries no browser cookie, so Vercel Edge auth blocks it with `401 "Protected deployment"`.

**Fix:** Vercel supports a `x-vercel-protection-bypass` header that skips the auth wall when sent with a valid bypass secret. The proxy route will read `VERCEL_PROTECTION_BYPASS` from the environment and add the header to its internal `fetch()` call.

**Technical Strategy:**

- Single-line addition to `app/api/eve/v1/[...slug]/route.ts` — add the header when the env var exists
- Add `VERCEL_PROTECTION_BYPASS` to `.env.example` (documentation only, no secret committed)
- Install vitest as a lightweight unit test framework for testing the route handler behavior
- Write a unit test that verifies the bypass header is sent when the env var is set
- No MegaLinter in this project — Phase 1.5 skipped

**Testing Blueprint:**

- Unit test (vitest): verify `x-vercel-protection-bypass` header appears in fetch when env var set
- Unit test (vitest): verify the header is absent when env var is unset (regression)
- No new Playwright E2E tests needed — the E2E already covers the full chat round-trip and will exercise the bypass in preview once deployed

---

## Edge Cases Identified

| #   | Scenario                                                 | Expected Behavior                                                          | Test Case                                          |
| --- | -------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------- |
| 1   | `VERCEL_PROTECTION_BYPASS` is set — bypass header sent   | Header `x-vercel-protection-bypass: <secret>` appears in the fetch request | `test_includes_bypass_header_when_env_set`         |
| 2   | `VERCEL_PROTECTION_BYPASS` is not set — no bypass header | Fetch request has no `x-vercel-protection-bypass` header                   | `test_omits_bypass_header_when_env_unset`          |
| 3   | Bypass secret is empty string — no bypass header         | Same as unset — empty string treated as absent                             | `test_omits_bypass_header_when_env_empty`          |
| 4   | Existing headers preserved alongside bypass header       | Authorization, content-type, accept headers still present                  | Covered by test 1 (check both new and old headers) |

## Repo History

No prior commits reference `x-vercel-protection-bypass`. The proxy route was created in PR #2 and has not been modified since.

---

## Tasks

### Task 1: Install vitest and set up test infrastructure

**Objective:** Add vitest as a devDependency and create a vitest config + test helper

**Files:**

- Modify: `package.json` (add vitest to devDependencies)
- Create: `vitest.config.ts`
- Modify: `tsconfig.json` (include `tests/` in includes or add a separate tsconfig)
- Create: `tests/proxy-route.test.ts` (test file)

**Step 1: Install vitest**

```bash
npm install -D vitest
```

**Step 2: Create vitest.config.ts**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
  },
});
```

**Step 3: Update tsconfig.json to include `tests/`**

Add `"tests/**/*.ts"` to the `include` array.

**Step 4: Verify vitest runs (no tests yet)**

```bash
npx vitest run
```

Expected: `No test files found, exiting with code 0`

**Step 5: Commit**

```bash
git add package.json vitest.config.ts tsconfig.json
git commit -m "chore: add vitest test framework"
```

---

### Task 2: Write failing test for the bypass header

**Objective:** Write a unit test that asserts the `x-vercel-protection-bypass` header is included in the proxy's fetch call when `VERCEL_PROTECTION_BYPASS` is set. It will fail RED because the route handler doesn't add the header yet.

**Files:**

- Create: `tests/proxy-route.test.ts`

**Step 1: Analyze the route handler to understand what to mock**

The route handler (`app/api/eve/v1/[...slug]/route.ts`):

- Uses `NextRequest` from `next/server`
- Builds a `headers` Record that includes `authorization`, `content-type`, `accept`
- Calls `fetch(targetUrl, { method, headers, body })`
- Returns `NextResponse.json()` or `new Response()` for streams

To test, we need to:

1. Mock `fetch` to capture what URL/headers it was called with
2. Mock `NextRequest` minimally (just the parts the handler uses)
3. Mock `NextResponse.json()` (or return a real response from our mock fetch)
4. Set/clear `VERCEL_PROTECTION_BYPASS` env var

**Step 2: Write the test file**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock NextRequest — we'll create it from the URL path
const requestFromPath = (path: string): any => {
  const url = new URL(path, "http://localhost:3000");
  return {
    nextUrl: url,
    method: "GET",
    headers: new Headers({ "content-type": "application/json" }),
  };
};

describe("proxy route bypass header", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.restoreAllMocks();
  });

  it("includes x-vercel-protection-bypass header when VERCEL_PROTECTION_BYPASS is set", async () => {
    process.env.VERCEL_PROTECTION_BYPASS = "my-bypass-secret";

    // Track what fetch was called with
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("{}", {
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    // Dynamic import after setting env (module reads env at call time)
    const { handler } = await vi.importActual<any>(
      "../app/api/eve/v1/[...slug]/route.ts",
    );
    const request = requestFromPath("/api/eve/v1/health");

    // Call the handler via whichever export it uses (GET, POST, etc.)
    // The file exports `handler` as GET, POST, etc.
    await handler(request);

    // Verify fetch was called with the bypass header
    const fetchCall = fetchMock.mock.calls[0];
    expect(fetchCall).toBeDefined();
    const [, options] = fetchCall;
    expect(options.headers).toHaveProperty(
      "x-vercel-protection-bypass",
      "my-bypass-secret",
    );
  });

  it("omits x-vercel-protection-bypass header when env var is not set", async () => {
    delete process.env.VERCEL_PROTECTION_BYPASS;

    const fetchMock = vi.fn().mockResolvedValue(
      new Response("{}", {
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { handler } = await vi.importActual<any>(
      "../app/api/eve/v1/[...slug]/route.ts",
    );
    const request = requestFromPath("/api/eve/v1/health");

    await handler(request);

    const fetchCall = fetchMock.mock.calls[0];
    expect(fetchCall).toBeDefined();
    const [, options] = fetchCall;
    expect(options.headers).not.toHaveProperty("x-vercel-protection-bypass");
  });

  it("omits bypass header when VERCEL_PROTECTION_BYPASS is empty string", async () => {
    process.env.VERCEL_PROTECTION_BYPASS = "";

    const fetchMock = vi.fn().mockResolvedValue(
      new Response("{}", {
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { handler } = await vi.importActual<any>(
      "../app/api/eve/v1/[...slug]/route.ts",
    );
    const request = requestFromPath("/api/eve/v1/health");

    await handler(request);

    const fetchCall = fetchMock.mock.calls[0];
    expect(fetchCall).toBeDefined();
    const [, options] = fetchCall;
    expect(options.headers).not.toHaveProperty("x-vercel-protection-bypass");
  });
});
```

**Step 3: Run tests to verify they fail RED**

```bash
npx vitest run
```

Expected: All 3 tests FAIL (the handler doesn't add the header yet)

**Step 4: Commit**

```bash
git add tests/proxy-route.test.ts
git commit -m "test: add failing tests for proxy bypass header"
```

---

### Task 3: Wait for user approval (Phase 3 gate)

After Task 2, stop and report to user that all 3 tests are RED. Wait for explicit approval before implementing.

---

### Task 4: Implement the bypass header in the proxy route

**Objective:** Add the single line that sets `x-vercel-protection-bypass` from the env var in the proxy's fetch call.

**Files:**

- Modify: `app/api/eve/v1/[...slug]/route.ts`
- Modify: `.env.example` (document the new env var)

**Step 1: Add the bypass header to the route handler**

In `app/api/eve/v1/[...slug]/route.ts`, after the line:

```ts
const API_KEY = process.env.EVE_API_KEY;
```

The `headers` object is built before the fetch call. Add:

```ts
const bypass = process.env.VERCEL_PROTECTION_BYPASS;
if (bypass) headers["x-vercel-protection-bypass"] = bypass;
```

**Step 2: Document the env var in `.env.example`**

Add:

```
# Vercel protection bypass secret for preview deployments
VERCEL_PROTECTION_BYPASS=
```

**Step 3: Run tests to verify GREEN**

```bash
npx vitest run
```

Expected: All 3 tests PASS

**Step 4: Run typecheck**

```bash
npm run typecheck
```

Expected: No errors

**Step 5: Run full E2E tests to check regressions**

```bash
npm run test:e2e
```

Expected: Playwright tests pass

**Step 6: Commit**

```bash
git add app/api/eve/v1/[...slug]/route.ts .env.example
git commit -m "fix: add Vercel protection bypass header to proxy route"
```

---

### Task 5: Update CI workflow for the new secret

**Objective:** Ensure the `VERCEL_PROTECTION_BYPASS` secret is available in CI environments that need it.

**Files:**

- Modify: `.github/workflows/ci.yml` (add VERCEL_PROTECTION_BYPASS to Playwright E2E job)

**Step-by-step:**

1. In the `e2e` job, add `VERCEL_PROTECTION_BYPASS: ${{ secrets.VERCEL_PROTECTION_BYPASS }}` to the `env` block for the browser test step.

2. Run typecheck to ensure no formatting errors:

```bash
npm run typecheck
```

3. Commit:

```bash
git add .github/workflows/ci.yml
git commit -m "ci: pass VERCEL_PROTECTION_BYPASS secret to Playwright E2E"
```

---

### Task 6: Final verification

**Objective:** Run all checks one final time to confirm everything is green.

**Steps:**

1. `npx vitest run` — all unit tests pass
2. `npm run typecheck` — no TypeScript errors
3. `npm run build` — Next.js builds successfully
4. `git log --oneline` — confirm all commits are present

**Note for the user:** After merging and deploying, they must:

1. Generate a protection bypass secret in Vercel Dashboard
2. Set `VERCEL_PROTECTION_BYPASS` in Vercel project environment variables
3. Set `VERCEL_PROTECTION_BYPASS` in GitHub Actions secrets

---

## Files Changed Summary

| File                                | Action                                     |
| ----------------------------------- | ------------------------------------------ |
| `package.json`                      | Modify — add vitest devDependency          |
| `vitest.config.ts`                  | Create — vitest configuration              |
| `tsconfig.json`                     | Modify — add `tests/` to include array     |
| `tests/proxy-route.test.ts`         | Create — unit tests for bypass header      |
| `app/api/eve/v1/[...slug]/route.ts` | Modify — add bypass header logic           |
| `.env.example`                      | Modify — document VERCEL_PROTECTION_BYPASS |
| `.github/workflows/ci.yml`          | Modify — pass secret to Playwright E2E job |
