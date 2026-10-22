export type ReplyVerdict = { ok: boolean; message: string };

export function evaluateSmokeReply(_reply: unknown): ReplyVerdict {
  // RED STUB - always passes, so the failing cases fail on their assertions.
  return { ok: true, message: "stub" };
}
