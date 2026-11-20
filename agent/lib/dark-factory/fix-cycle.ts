/**
 * #718 - the Definition of Done's fix cycle.
 *
 * The DoD's whole fix/disposition path is gated on `DefinitionOfDoneDeps.attemptFixes`
 * (`definition-of-done.ts:965`). The seam was declared and exercised by nine test cases, but the
 * composition root never supplied it, so on every production run the loop could only re-read the
 * same finding until its round budget was spent: a green pull request was recorded `failed`
 * (measured on WebFeedPOC#246, run a37cc0c6).
 *
 * This module supplies it. It is deliberately small and port-injected - no sandbox, no model and no
 * network appear here - so the disposition RULES can be tested on their own, apart from the machinery
 * that re-authors code.
 *
 * The rules it enforces, each pinned by a test:
 *
 * - a pass that authored nothing may not claim a fix, and a fix that was not pushed is not a fix;
 * - a workspace that cannot be opened, or a push that fails, yields NO dispositions and never a
 *   throw - the DoD turns a throw into "the fix attempt failed unexpectedly", which reports a
 *   defect in this module as a defect in the run;
 * - an `error`-severity finding is never returned as `accepted`, because the DoD refuses that
 *   anyway (`definition-of-done.ts:540`) - doing it here means the refusal is explicit and early;
 * - an acceptance always carries a reason, because the DoD blocks on one that does not
 *   (`definition-of-done.ts:507`);
 * - one pass attempts a bounded number of findings.
 *
 * Verification is not this module's job: the DoD re-runs `runChecks` every round, so a finding that
 * is genuinely fixed stops reappearing and one that is not comes straight back.
 */
import type {
  FindingDisposition,
  ReviewFinding,
} from "./definition-of-done";

/** The handle one fix pass works in. Opaque here - only the ports know what it really is. */
export interface FixWorkspace {
  /** The branch the fix is authored on. */
  branch: string;
}

/** A finding the pass deliberately did not fix, with the reason the DoD will publish. */
export interface FixRefusal {
  findingId: string;
  /** Required: the DoD refuses an acceptance whose explanation is empty. */
  explanation: string;
}

/** What one authoring pass produced. */
export interface FixAuthorResult {
  /** Files the pass changed. EMPTY means nothing was authored, so nothing is claimed as fixed. */
  changedFiles: readonly string[];
  /** Findings the pass deliberately did not fix. */
  refusals?: readonly FixRefusal[];
}

/**
 * Everything the fix cycle needs, injected so the rules can be tested without any machinery.
 *
 * Generic over the handle because the module itself reads only `branch` - the adapter that owns the
 * sandbox needs to carry the provider and its tools through the same three calls, and widening the
 * handle here is how the ports stay honest about what they hand back.
 */
export interface FixCyclePorts<W extends FixWorkspace = FixWorkspace> {
  /** Checks out the pull request's head branch. */
  openWorkspace: () => Promise<
    { ok: true; workspace: W } | { ok: false; error: string }
  >;
  /** Re-authors the affected files for these findings. */
  author: (
    workspace: W,
    findings: readonly ReviewFinding[],
  ) => Promise<FixAuthorResult>;
  /** Commits and pushes what the pass authored. */
  push: (
    workspace: W,
    findings: readonly ReviewFinding[],
  ) => Promise<{ ok: boolean; error?: string }>;
  /**
   * Releases the workspace. Called on EVERY path, including the ones that return early and the ones
   * that throw: the adapter holds a real sandbox open across author and push, so a pass that skipped
   * this would leak one sandbox per failure until the driver gave up.
   */
  closeWorkspace?: (workspace: W) => Promise<void>;
  /** A ceiling on how many findings ONE pass will attempt. Defaults to 10. */
  maxFindings?: number;
  log?: (label: string, value: unknown) => void;
}

/** The shape `DefinitionOfDoneDeps.attemptFixes` expects. */
export type AttemptFixes = (
  findings: readonly ReviewFinding[],
) => Promise<FindingDisposition[]>;

/** The default ceiling on findings attempted per pass. */
export const DEFAULT_MAX_FINDINGS = 10;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createFixCycle<W extends FixWorkspace = FixWorkspace>(
  ports: FixCyclePorts<W>,
): AttemptFixes {
  const log = ports.log ?? (() => {});
  const maxFindings = Math.max(0, ports.maxFindings ?? DEFAULT_MAX_FINDINGS);

  return async (findings) => {
    // One pass attempts a bounded number of findings. The ceiling is not about cost alone: it keeps
    // the failure legible. A pass that tried fifty findings and reported nothing would be
    // indistinguishable from one that tried none.
    const attempted = findings.slice(0, maxFindings);
    if (attempted.length < findings.length) {
      log(
        "Fix cycle",
        `attempting ${attempted.length} of ${findings.length} findings`,
      );
    }
    if (attempted.length === 0) return [];

    const opened = await ports.openWorkspace();
    if (!opened.ok) {
      log("Fix cycle", `no workspace, so nothing was attempted: ${opened.error}`);
      return [];
    }

    try {
      return await runPass(opened.workspace, attempted);
    } finally {
      try {
        await ports.closeWorkspace?.(opened.workspace);
      } catch (error) {
        log("Fix cycle", `the workspace could not be closed: ${describe(error)}`);
      }
    }
  };

  async function runPass(
    workspace: W,
    attempted: readonly ReviewFinding[],
  ): Promise<FindingDisposition[]> {
    let authored: FixAuthorResult;
    try {
      authored = await ports.author(workspace, attempted);
    } catch (error) {
      log("Fix cycle", `the authoring pass failed: ${describe(error)}`);
      return [];
    }

    // A refusal is itself a disposition, so a refused finding must never ALSO be resolved: accepting
    // a finding and claiming to have fixed it are contradictory answers to the same question.
    const refusedIds = new Set((authored.refusals ?? []).map((r) => r.findingId));
    const dispositions: FindingDisposition[] = [];

    if (authored.changedFiles.length > 0) {
      let pushed: { ok: boolean; error?: string };
      try {
        pushed = await ports.push(workspace, attempted);
      } catch (error) {
        pushed = { ok: false, error: describe(error) };
      }
      if (pushed.ok) {
        for (const target of attempted) {
          if (refusedIds.has(target.id)) continue;
          dispositions.push({ findingId: target.id, status: "resolved" });
        }
      } else {
        // A fix that was not pushed is not a fix. Claiming otherwise would tell the ledger the
        // finding was addressed while the pull request still carries the code the check rejected.
        log("Fix cycle", `the fix was not pushed: ${pushed.error ?? "unknown error"}`);
      }
    }

    for (const refusal of authored.refusals ?? []) {
      const target = attempted.find((candidate) => candidate.id === refusal.findingId);
      if (!target) continue;
      // The DoD refuses an `error`-severity acceptance outright (`definition-of-done.ts:540`).
      // Refusing it here makes the refusal early and explicit instead of a block several layers away.
      if (target.severity === "error") {
        log(
          "Fix cycle",
          `not accepting an error-severity finding: ${refusal.findingId}`,
        );
        continue;
      }
      const explanation = refusal.explanation.trim();
      // The DoD blocks on an acceptance with no reason (`definition-of-done.ts:507`), so this must
      // not manufacture one - an unexplained acceptance is the rubber stamp the loop exists to stop.
      if (explanation.length === 0) {
        log("Fix cycle", `dropping an acceptance with no reason: ${refusal.findingId}`);
        continue;
      }
      dispositions.push({
        findingId: refusal.findingId,
        status: "accepted",
        explanation,
      });
    }

    return dispositions;
  }
}
