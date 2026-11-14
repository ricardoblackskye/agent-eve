/**
 * #651 — the identity used to detect a no-op self-correction.
 *
 * The loop compares the artefact identity of consecutive FAILING iterations, so the identity must be
 * EXACTLY equal for byte-identical work and different for any real change — otherwise the detection is
 * either blind (never fires) or noisy (fires on a genuine fix cycle). It is a digest, never the content
 * itself, so nothing sensitive can leak if it is logged or stored.
 */
import { describe, it, expect } from "vitest";
import { artefactIdentity } from "../../agent/lib/dark-factory/developer-agent";

describe("#651 artefactIdentity", () => {
  it("is equal for byte-identical work, regardless of key order", () => {
    expect(artefactIdentity({ "a.ts": "one", "b.ts": "two" })).toBe(
      artefactIdentity({ "b.ts": "two", "a.ts": "one" }),
    );
  });

  it("differs when a file's content changes", () => {
    expect(artefactIdentity({ "a.ts": "one" })).not.toBe(artefactIdentity({ "a.ts": "ONE" }));
  });

  it("differs when a file is added or removed", () => {
    expect(artefactIdentity({ "a.ts": "one" })).not.toBe(
      artefactIdentity({ "a.ts": "one", "b.ts": "x" }),
    );
    expect(artefactIdentity({ "a.ts": "one" })).not.toBe(artefactIdentity({}));
  });

  it("cannot confuse a path/content boundary for a real change", () => {
    // A naive join without a delimiter would make these two DIFFERENT maps share an identity.
    expect(artefactIdentity({ "ab": "c" })).not.toBe(artefactIdentity({ "a": "bc" }));
  });

  it("is a stable, opaque digest, not the content itself", () => {
    const id = artefactIdentity({ "a.ts": "top-secret-value" });

    expect(id).not.toContain("top-secret-value");
    expect(id).toMatch(/^[a-f0-9]{64}$/);
    expect(id).toBe(artefactIdentity({ "a.ts": "top-secret-value" }));
  });
});
