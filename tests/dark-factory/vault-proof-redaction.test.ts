/**
 * #581 — the vault proof must not print the secret it proves was injected.
 *
 * The defect this pins: `scripts/k8s-vault-proof/vault-proof.py` sends a placeholder
 * Authorization header, the egress sidecar substitutes the real vault secret, httpbin echoes
 * the request headers back — and the script printed that echoed body wholesale. A successful
 * run therefore wrote the real secret to stdout in cleartext, where it lands in CI workflow
 * logs, terminal scrollback and any redirected file.
 *
 * The proof is CORRECT; only its output is unsafe. The evidence needed is "the placeholder was
 * substituted", which a masked value still establishes. So the fix keeps the assertion on the
 * RAW buffer (never weaken the proof) and prints a redacted view instead.
 *
 * Guard shape follows tests/doc-drift-guards.test.ts: a pure `(source) => violations[]` function,
 * an integration test over the real script (green once fixed), and a mutation test that injects
 * synthetic drift to prove the guard is not vacuous — a guard that cannot fail is worse than none.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const SCRIPT_PATH = join(ROOT, "scripts/k8s-vault-proof/vault-proof.py");
const SCRIPT = readFileSync(SCRIPT_PATH, "utf8");

/** Source-level invariants for the proof script's step [3/4] output. */
function findLeaks(source: string): string[] {
  const violations: string[] = [];

  // A print of the raw child stdout publishes whatever the upstream echoed — including the
  // secret when substitution worked.
  const printLines = source
    .split("\n")
    .filter(
      (line) => /\bprint\s*\(/.test(line) && /completed\.stdout/.test(line),
    );

  for (const line of printLines) {
    if (!/redact\s*\(/.test(line)) {
      violations.push("prints completed.stdout without redacting the secret");
    }
    // A [:N] cut applied to the raw body can split the secret and leave a fragment that no
    // longer matches a redaction, so truncation must apply to redact()'s RESULT, never its
    // argument. Ordering is load-bearing, exactly like escaping before a delimiter.
    if (/strip\(\)\s*\[:/.test(line)) {
      violations.push(
        "truncates the raw response before redacting, which can split the secret",
      );
    }
  }

  // The proof must still be decided from the RAW buffer. Asserting on redacted text would
  // either always pass or always fail, destroying the proof's evidential value.
  if (!/in completed\.stdout/.test(source)) {
    violations.push("no longer asserts against the raw upstream response");
  }

  return violations;
}

describe("#581 vault proof output redaction", () => {
  it("the real script does not print the raw upstream response", () => {
    expect(findLeaks(SCRIPT)).toEqual([]);
  });

  it("keeps the substitution assertion on the raw buffer", () => {
    // Explicit, so a future edit that "cleans up" the proof by asserting on the masked
    // string is caught rather than silently turning the proof into a tautology.
    expect(SCRIPT).toMatch(/proven\s*=\s*[^\n]*in completed\.stdout/);
  });

  describe("the guard is not vacuous", () => {
    it("fires on a raw print", () => {
      const drifted = SCRIPT.replace(
        /print\([^\n]*completed\.stdout[^\n]*\)/,
        "print(completed.stdout.strip()[:500])",
      );
      expect(findLeaks(drifted)).toContain(
        "prints completed.stdout without redacting the secret",
      );
    });

    it("fires when truncation is applied before redaction", () => {
      // redact(completed.stdout.strip()[:500], REAL) — the [:500] cuts the secret in two, so
      // the redaction no longer matches and a fragment survives. The correct form applies
      // the slice to redact()'s result: redact(...)[:500]. Built explicitly rather than via a
      // regex so the drift states exactly which part is broken.
      const good = "print(redact(completed.stdout.strip(), REAL)[:500])";
      const bad = "print(redact(completed.stdout.strip()[:500], REAL))";
      expect(SCRIPT).toContain(good);
      const drifted = SCRIPT.replace(good, bad);
      expect(findLeaks(drifted)).toContain(
        "truncates the raw response before redacting, which can split the secret",
      );
    });

    it("fires when the assertion stops reading the raw buffer", () => {
      const drifted = SCRIPT.replace(/in completed\.stdout/g, "in masked");
      expect(findLeaks(drifted)).toContain(
        "no longer asserts against the raw upstream response",
      );
    });
  });
});

/** Locate a python interpreter; the script under test is python, so absence is a real failure. */
function pythonBin(): string {
  for (const candidate of ["python3", "python"]) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  throw new Error(
    "no python interpreter found — scripts/k8s-vault-proof/vault-proof.py cannot be executed",
  );
}

/** Runs the pure redact() from the real module and returns its reported results. */
function probeRedact(): Record<string, unknown> {
  const snippet = [
    "import importlib.util, json, sys",
    // Importing the module would otherwise write a __pycache__ directory into the source tree,
    // which .gitignore does not cover. This keeps the working copy clean on every test run.
    "sys.dont_write_bytecode = True",
    "spec = importlib.util.spec_from_file_location('vault_proof', sys.argv[1])",
    "mod = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(mod)",
    "out = {}",
    "if not hasattr(mod, 'redact'):",
    "    out['error'] = 'module defines no redact() function'",
    "else:",
    "    secret = 'SAMPLE-SECRET-abc123'",
    '    body = \'{"headers": {"Authorization": "Bearer SAMPLE-SECRET-abc123", "Host": "httpbin.org"}}\'',
    "    masked = mod.redact(body, secret)",
    "    out['masked'] = masked",
    "    out['secret_gone'] = secret not in masked",
    "    out['evidence_kept'] = 'Authorization' in masked and 'httpbin.org' in masked",
    "    out['empty_noop'] = mod.redact('abc', '') == 'abc'",
    "    out['none_noop'] = mod.redact('abc', None) == 'abc'",
    "    out['multi'] = mod.redact('Q Q', 'Q').count('<redacted>') == 2",
    "print(json.dumps(out))",
  ].join("\n");

  const stdout = execFileSync(pythonBin(), ["-c", snippet, SCRIPT_PATH], {
    encoding: "utf8",
  });
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("#581 redact() behaviour", () => {
  it("masks the secret while keeping the proof's evidence", () => {
    const result = probeRedact();
    expect(result.error).toBeUndefined();
    expect(result.secret_gone).toBe(true);
    expect(result.evidence_kept).toBe(true);
    expect(String(result.masked)).not.toContain("SAMPLE-SECRET-abc123");
  });

  it("leaves text untouched for an empty or absent secret", () => {
    // "abc".replace("", "X") inserts X at every position, so an unguarded redaction would
    // corrupt the output it is meant to protect. Both cases are asserted deliberately.
    const result = probeRedact();
    expect(result.empty_noop).toBe(true);
    expect(result.none_noop).toBe(true);
  });

  it("masks every occurrence, not just the first", () => {
    const result = probeRedact();
    expect(result.multi).toBe(true);
  });
});
