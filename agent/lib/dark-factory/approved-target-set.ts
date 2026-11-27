/**
 * Dark Factory — is what the run WROTE inside what was APPROVED? (#763 R2)
 *
 * The approved plan's `targetFiles` is a contract: the set of files a run writes must be a **subset** of it. One live
 * escape proved it was not enforced — a fix cycle wrote a file outside its plan's approved set (a CI workflow) and
 * nothing objected — which is why "I approved the plan you showed me" did not mean much. The fix cycle is the path
 * that escaped in practice, and it is the path this check does not need to know about to catch.
 *
 * Provider- and repo-agnostic by construction: it asks only whether a path is in the approved set. No vendor, no
 * repository, no framework and no surface kind appears here, which is an acceptance criterion of the issue — and the
 * reason this takes paths and a plan rather than anything repository-shaped.
 *
 * Direction of safety: a plan that approved NOTHING authorizes nothing, so an empty or missing target list reports
 * every written path rather than none. The caller refuses on that; it must never widen the set to accommodate a write.
 */

/**
 * Paths are compared after normalizing separators and a leading `./`.
 *
 * A false positive here would refuse legitimate runs, and a guard that cries wolf is one that gets worked around
 * rather than respected — so the cheap normalizations are done, and the ones that are not are stated below.
 */
function normalizePath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

/**
 * The authored paths that are NOT in the approved plan's target set.
 *
 * An empty result means the run stayed inside the contract. Each outside path is reported once, in the order it was
 * first seen, so a caller naming them does not repeat itself.
 *
 * **Not normalized: case.**

 * A path differing only by case is reported as outside the set. That is the conservative direction for a contract —
 * it refuses rather than permits — and it is a stated limit rather than a silent one, the same boundary recorded for
 * the existence rule in #770.
 */
export function pathsOutsideApprovedSet(
  authored: readonly string[],
  plan: { targetFiles?: ReadonlyArray<{ path?: string }> | null },
): string[] {
  const approved = new Set(
    (plan.targetFiles ?? [])
      .map((target) => normalizePath(target?.path ?? ""))
      .filter((path) => path.length > 0),
  );

  const outside = new Set<string>();
  for (const path of authored) {
    const normalized = normalizePath(path);
    if (normalized.length === 0) continue;
    if (!approved.has(normalized)) outside.add(path.trim());
  }
  return [...outside];
}
