/**
 * Pure formatting helpers for the Dark Factory progress board.
 *
 * No React, no DOM, no fetching — these are unit-tested in the Node
 * environment. An absent measurement renders as an em dash, never a zero.
 */

const EM_DASH = "—";

export function formatRelativeTime(iso: string, now: number | Date): string {
  const nowMs = typeof now === "number" ? now : now.getTime();
  const thenMs = Date.parse(iso);
  if (!Number.isFinite(thenMs)) return EM_DASH;
  const diffSec = Math.max(0, Math.floor((nowMs - thenMs) / 1000));
  if (diffSec < 60) return "now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h`;
  return `${Math.floor(diffHour / 24)}d`;
}

export function formatDuration(fromIso?: string, toIso?: string): string {
  if (!fromIso || !toIso) return EM_DASH;
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return EM_DASH;
  const sec = Math.max(0, Math.floor((to - from) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${String(sec % 60).padStart(2, "0")}s`;
  const hour = Math.floor(min / 60);
  return `${hour}h ${String(min % 60).padStart(2, "0")}m`;
}

export function formatCostUsd(usd?: number): string {
  if (usd === undefined || !Number.isFinite(usd)) return EM_DASH;
  return `$${usd.toFixed(2)}`;
}

export function formatCount(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatClockTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return EM_DASH;
  return new Date(ms).toISOString().slice(11, 19);
}
