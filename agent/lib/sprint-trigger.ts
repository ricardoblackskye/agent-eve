export const SPRINT_REPORT_LABEL = "generate-sprint-report";

export interface SprintTriggerPayload {
  action: string;
  label?: { name: string };
  pull_request?: unknown;
}

/**
 * Decide whether a GitHub issue event should kick off sprint-metrics report
 * generation. Fires only when the issue is LABELED with the sprint-report label
 * (case-insensitive). Never fires for pull_request events or terminal
 * (`closed` / `deleted`) issue actions.
 */
export function isSprintReportTrigger(payload: SprintTriggerPayload): boolean {
  if (payload.pull_request) return false;
  if (payload.action === "closed" || payload.action === "deleted") return false;
  if (payload.action !== "labeled") return false;
  const label = (payload.label?.name || "").toLowerCase();
  return label === SPRINT_REPORT_LABEL.toLowerCase();
}
