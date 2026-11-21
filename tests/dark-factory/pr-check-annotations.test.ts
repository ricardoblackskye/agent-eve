/**
 * #718 - a failed check must arrive WITH its annotations.
 *
 * `checkRunFindings` can name the file a failed check annotated, but only if the fetcher put the
 * annotations there. The list endpoint returns an `annotations_url` rather than the annotations
 * themselves, so this is a second call per failing check - and if it is never made, the finding is
 * prose again and the fix cycle has nothing to act on. That is the defect shape this whole issue is
 * about: a capability that exists everywhere except where it is fed.
 */
import { describe, expect, it } from "vitest";
import { makePullRequestCheckFetcher } from "../../scripts/dark-factory-runner";

function stubFetch(routes: (url: string) => unknown) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    return { ok: true, json: async () => routes(url) } as never;
  }) as never;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

describe("#718 the check fetcher reads annotations for failing checks", () => {
  it("attaches the annotations of a FAILED check, and asks for no others", async () => {
    const stub = stubFetch((url) => {
      if (url.includes("/pulls/")) return { head: { sha: "abc123" } };
      if (url.endsWith("/annotations")) {
        return [
          { path: "tests/e2e/home.spec.ts", start_line: 42, message: "expect(received).toContain" },
        ];
      }
      return {
        check_runs: [
          {
            name: "e2e",
            status: "completed",
            conclusion: "failure",
            output: {
              annotations_count: 1,
              annotations_url: "https://api.github.com/repos/o/r/check-runs/1/annotations",
            },
          },
          { name: "test", status: "completed", conclusion: "success" },
          { name: "MegaLinter", status: "in_progress", conclusion: null },
        ],
      };
    });

    try {
      const fetcher = makePullRequestCheckFetcher({ token: "t", repo: "o/r", prNumber: 1 });
      const runs = await fetcher();

      expect(runs?.[0].annotations?.[0].path).toBe("tests/e2e/home.spec.ts");
      // One call for the pull request, one for the checks, and exactly ONE for annotations - the
      // passing and the unfinished check must not cost a request each.
      expect(stub.calls.filter((c) => c.endsWith("/annotations"))).toHaveLength(1);
    } finally {
      stub.restore();
    }
  });

  it("still returns the checks when an annotations call fails", async () => {
    // Best-effort: losing the detail must not lose the verdict, or a failed check would vanish from
    // the findings entirely - a worse outcome than a finding without a file.
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("/pulls/")) {
        return { ok: true, json: async () => ({ head: { sha: "abc123" } }) } as never;
      }
      if (url.endsWith("/annotations")) {
        return { ok: false, json: async () => ({}) } as never;
      }
      return {
        ok: true,
        json: async () => ({
          check_runs: [
            {
              name: "e2e",
              status: "completed",
              conclusion: "failure",
              output: { annotations_count: 1, annotations_url: "https://api.github.com/x/annotations" },
            },
          ],
        }),
      } as never;
    }) as never;

    try {
      const fetcher = makePullRequestCheckFetcher({ token: "t", repo: "o/r", prNumber: 1 });
      const runs = await fetcher();
      expect(runs?.[0].name).toBe("e2e");
      expect(runs?.[0].conclusion).toBe("failure");
      expect(runs?.[0].annotations).toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });
});
