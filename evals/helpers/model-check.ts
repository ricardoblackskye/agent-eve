export type ModelVerdict = { ok: boolean; message: string };

export function evaluateModelCheck(_info: unknown): ModelVerdict {
  // RED STUB - deliberately always passes so the failing tests fail on their assertions
  // rather than on a missing import.
  return { ok: true, message: "stub" };
}
