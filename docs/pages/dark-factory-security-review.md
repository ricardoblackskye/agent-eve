# Dark Factory — security validation pass (#275)

Sub-issue of #267. **AC:** documented findings + fixes for each vector.

**Scope decision:** LOCAL confinement. The worker provider is honestly `isolated: false`
(a dry-run — nothing executes), so "sandbox escape" here means the local developer agent's
file and child-process confinement, NOT a container. Real isolation is #280 (R1).

| Vector | Finding | Control | Proven by |
|---|---|---|---|
| **Prompt injection via the issue body** | The issue title/body is attacker-controlled and reaches the architect agent, which goes on to write code | `entry.ts`: `sanitizeIdentifier` strips structural identifiers to `[A-Za-z0-9_.\-/]`, `defuse()` defuses backticks, and the brief is fenced in a ```text block labelled DATA; `architect-agent.ts` fences `<user_story>` as untrusted | `security-validation.test.ts` vector 1 — the fence holds and a hostile identifier is stripped |
| **Secret exfiltration (dev-agent env)** | **FIXED in this pass.** `developer-agent.ts` ran `execAsync(cmd, { cwd, maxBuffer })` with no `env`, so the child inherited the FULL `process.env` — push token, `DF_*`, database URLs | One shared allow-list (`child-env.ts`) applied at BOTH agents' child-process call sites | vector 2 — the filter drops secrets and keeps `PATH`; a source guard fails if the call site stops passing `env` |
| **Sandbox escape (LOCAL)** | No escape found | `developer-agent.ts`: tool allow-list, fail-closed extension allow-list, traversal + drive/UNC + null-byte rejection, symlink re-verification against the real path; `worker-env.ts`: repo allow-list BEFORE provisioning, lease-only credential, honest `isolated: false` | vector 3 — traversal, absolute, drive, UNC, disallowed extension and escaping symlink are all refused |

## Residual risk / not covered

- Real container isolation (#279/#280).
- `credentials` / `llm-policy` / `circuit-breaker` validation beyond the existing suites
  (`credentials.test.ts`, `worker-policy-env.test.ts`) — no gap found in this pass.
- The filter restricts the KEY SET only; it does not scrub values.
