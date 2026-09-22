/**
 * Decide whether a GitHub `pull_request` event should invoke the Release
 * Manager to generate release notes.
 *
 * Fires ONLY when the pull request was MERGED: a `closed` action carrying
 * `merged: true`. GitHub sends `pull_request.closed` for both merged and
 * unmerged closes, so `merged` — not `closed` alone — is the signal that the
 * change actually landed on the base branch, which is what release notes
 * describe.
 *
 * Every other action (`opened`, `synchronize`, `reopened`, `labeled`, `edited`,
 * or a non-merged `closed`) returns false and must be acknowledged WITHOUT an
 * Eve call. This mirrors the pure-detector shape of `story-trigger.ts` / the
 * sprint and dark-factory triggers.
 */
export interface ReleaseTriggerPayload {
  action: string;
  merged?: boolean;
}

export function isReleaseNotesTrigger(payload: ReleaseTriggerPayload): boolean {
  return payload.action === "closed" && payload.merged === true;
}
