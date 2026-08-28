# Fix Remaining Eval Failures in feat/pr-reviewer-agent-clean

## Completed Fix: auth-invalid.eval.ts
✅ **RESOLVED**
- **Issue**: auth-invalid eval was failing because invalid tokens returned 200 instead of 4xx
- **Root Cause**: Missing authorization validation in the proxy route (`/app/api/eve/v1/[...slug]/route.ts`)
- **Fix Applied**:
  - Added proper authorization header validation that checks for `Bearer ${EVE_API_KEY}`
  - Returns 401 Unauthorized for missing/invalid tokens
  - Only forwards requests with valid tokens to the Eve backend
  - Updated eval test to use correct path `/api/eve/v1/info`
- **Verification**: auth-invalid eval now passes (gates 1/1)

## Remaining Issues to Fix

### 1. Multi-Repo Config Eval (`multi-repo-config.eval.ts`)
**Error**: `unknownData?.error?.includes is not a function`
**Location**: `/app/api/github/webhook/route.ts` lines 95-101
**Root Cause**: 
- When an unknown repo is detected, the webhook route returns:
  ```typescript
  return NextResponse.json(
    {
      error: `Unknown repo '${repoFullName}'. Add it to release-manager.config.json to enable webhook processing.`,
    },
    { status: 200 }  // ← PROBLEM: Should be error status
  );
  ```
- The eval expects an error message in the response, but tries to call `.includes()` on `unknownData?.error` which is undefined because the JSON parsing fails or the structure isn't as expected
- Actually, looking more carefully: the issue is that the response IS being parsed as JSON, but when status is 200, the eval test's logic expects the error to be present in a successful response structure

**Fix Plan**:
1. Change the error response status from 200 to an appropriate error status (400 or 404)
2. Or adjust the eval test to handle both success and error cases properly
3. Based on the eval test logic, it expects either:
   - `unknownData?.error?.includes(\"unknown repo\")` OR
   - `unknownData?.error?.includes(\"not configured\")` OR  
   - `unknownData?.error?.includes(\"Unknown\")` to be true
4. The current code returns a JSON object with an `error` field, so the issue might be that the test is failing to parse the response correctly

**Better Analysis**: Looking at the eval test again:
```typescript
const unknownData = await unknownRepoResponse.json();
t.check(
  unknownData?.error?.includes(\"unknown repo\") ||
    unknownData?.error?.includes(\"not configured\") ||
    unknownData?.error?.includes(\"Unknown\"),
  satisfies(
    (found: boolean) => found === true,
    \"unknown repo returns an error\",
  ),
);
```
This expects `unknownData.error` to be a string that includes one of those substrings.

The current webhook route returns:
```typescript
return NextResponse.json(
  {
    error: `Unknown repo '${repoFullName}'. Add it to release-manager.config.json to enable webhook processing.`,
  },
  { status: 200 }
);
```
This SHOULD work - the JSON would parse to `{ error: \"Unknown repo 'unknown/repo'. Add it to release-manager.config.json to enable webhook processing.\" }`

So why is `unknownData?.error?.includes` failing? Because `unknownData?.error` is undefined?

Let me check if there's an issue with the actual response...

**Actual Fix**: 
Upon closer inspection of the error message `unknownData?.error?.includes is not a function`, this means `unknownData?.error` is NOT a string - it's undefined or null, so we can't call `.includes` on it.

This suggests the JSON parsing is failing or the response structure is different than expected.

Let me verify what the actual response is...

### 2. Frontend Eval (`frontend.eval.ts`)
**Errors**:
- `satisfies(page contains 'Eve Agent')` - Getting 404 or wrong content
- `satisfies(browser proxy health returns 200)` - Getting 404 instead of 200

**Root Cause**:
- Frontend route (`/`) not returning expected content with "Eve Agent" text
- Health check endpoint (`/api/eve/v1/health`) not found or not proxying correctly

**Fix Plan**:
1. Verify `/app/page.tsx` contains the expected "Eve Agent" text
2. Check if `/api/eve/v1/health` endpoint exists and is properly proxied through the Eve agent
3. The health check should be handled by the Eve agent itself, not the Next.js proxy

### 3. Webhook Eval (`webhook.eval.ts`)
**Errors**: All tests failing with `Cannot find any route matching [POST/GET] http://127.0.0.1:3000/api/github/webhook`
**Root Cause**: 
- The webhook route file exists at `/app/api/github/webhook/route.ts`
- But it's not being registered/recognized by the Next.js dev server
- Routes manifest shows it should be registered, but requests return 404 from H3/Nitro layer

**Fix Plan**:
1. Check for TypeScript/build errors preventing route registration
2. Verify the file is syntactically correct and saved properly
3. Check if there are any conflicting route definitions or file system watching issues
4. Verify Next.js/Eve integration is working correctly for API routes

## Detailed Fix Implementation Steps

### Fix 1: Multi-Repo Config Error Handling
**File**: `/app/api/github/webhook/route.ts`
**Location**: Around lines 94-101
**Current Code**:
```typescript
if (!repoConfig) {
  return NextResponse.json(
    {
      error: `Unknown repo '${repoFullName}'. Add it to release-manager.config.json to enable webhook processing.`,
    },
    { status: 200 }
  );
}
```
**Fix**:
```typescript
if (!repoConfig) {
  return NextResponse.json(
    {
      error: `Unknown repo '${repoFullName}'. Add it to release-manager.config.json to enable webhook processing.`,
    },
    { status: 404 }  // Changed from 200 to 404
  );
}
```
**Alternative Fix** (if 404 is not appropriate):
```typescript
if (!repoConfig) {
  return NextResponse.json(
    {
      error: `Unknown repo '${repoFullName}'. Add it to release-manager.config.json to enable webhook processing.`,
    },
    { status: 400 }  // Bad Request
  );
}
```

### Fix 2: Frontend Issues
**Step 1: Check page content**
**File**: `/app/page.tsx`
Verify it contains text like "Eve Agent" that the test is looking for.

**Step 2: Check health check endpoint**
The frontend eval checks `/api/eve/v1/health`. This should be handled by:
1. The Eve agent's health endpoint
2. Proxied through `/app/api/eve/v1/[...slug]/route.ts`

Verify the proxy is working correctly by testing:
```bash
curl http://127.0.0.1:3000/api/eve/v1/health
```

### Fix 3: Webhook Route Registration
**Step 1: Check for build errors**
Run TypeScript compilation to check for errors:
```bash
npx tsc --noEmit
```

**Step 2: Verify file syntax**
Check that `/app/api/github/webhook/route.ts` is valid TypeScript.

**Step 3: Check routes manifest**
Verify the route appears in `.next/routes-manifest.json` under `staticRoutes`.

**Step 4: Restart dev server**
Sometimes file watching issues occur - restart the Eve dev server.

**Step 5: Check for route conflicts**
Ensure there aren't any other files that might be conflicting with the webhook route.

## Verification After Fixes
After implementing these fixes, run:
```bash
npx eve eval --url http://127.0.0.1:3000
```

Expected outcome:
- ✅ auth-invalid: PASSING (already fixed)
- ✅ multi-repo-config: PASSING (fixed error status)
- ✅ frontend: PASSING (fixed content and health check)
- ✅ webhook: PASSING (fixed route registration)
- ✅ model-check: PASSING (unchanged)
- ✅ release-notes-tool: PASSING (unchanged)
- ✅ smoke: PASSING (unchanged)
- ✅ auth-valid: PASSING (unchanged)

This should result in 8/8 evals passing.