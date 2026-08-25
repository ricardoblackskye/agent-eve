# #24 — Multi-Repo Configuration Support

**Issue:** #24
**Branch:** `feat/multi-repo-config`

## Goal

The webhook handler currently only handles agent-eve. Add a config file that maps repos → secrets/tokens so the same handler can serve multiple repos.

## Files

| File | Action | What it does |
|------|--------|-------------|
| `release-manager.config.json` | **Create** | Repo mapping config with env var references |
| `app/api/github/webhook/route.ts` | **Modify** | Read config, validate per-repo signature, pass owner/repo |
| `agent/subagents/release-manager/tools/read_current_notes.ts` | **Modify** | Accept optional `owner`/`repo` input params |
| `agent/subagents/release-manager/tools/write_release_notes.ts` | **Modify** | Accept optional `owner`/`repo` input params |
| `evals/multi-repo-config.eval.ts` | **Create** | Production eval for config file and webhook routing |

## Implementation

### 1. Config File

```json
{
  "repos": {
    "ricardoblackskye/agent-eve": {
      "webhook_secret_env": "GH_WEBHOOK_SECRET",
      "token_env": "GH_RELEASE_TOKEN",
      "release_notes_path": "releasenotes.md"
    }
  },
  "defaults": {
    "webhook_secret_env": "GH_WEBHOOK_SECRET",
    "token_env": "GH_RELEASE_TOKEN",
    "release_notes_path": "releasenotes.md"
  }
}
```

### 2. Webhook Updates

- Read config from `release-manager.config.json` at request time
- Look up the repo from `data.repository.full_name`
- If not found, use `defaults` or return an error
- Validate HMAC with the correct per-repo secret
- Pass owner/repo in the Eve API message

### 3. Tool Updates

Both tools accept optional `owner` and `repo` input parameters. If provided, use those. If not, fall back to `VERCEL_GIT_REPO_OWNER`/`VERCEL_GIT_REPO_SLUG` env vars.

## Verification

```bash
npm run typecheck
npm run build
npx eve eval --strict
# Test config is valid JSON
python3 -c "import json; json.load(open('release-manager.config.json'))"
```