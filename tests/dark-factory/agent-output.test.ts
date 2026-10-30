import { describe, it, expect } from "vitest";
import {
  resolveAgentOutputRecorder,
  UnknownAgentProfileError,
  type CapturedAgentOutput,
} from "../../agent/lib/dark-factory/agent-output";

describe("Agent output recorder contract (#558)", () => {
  it("resolves the recorder registered for the architect profile", () => {
    const recorder = resolveAgentOutputRecorder("architect");
    expect(recorder.profile).toBe("architect");
  });

  it("raises a typed error for an unregistered profile", () => {
    // Assert a VALID resolution first: without it, a throwing stub satisfies
    // the rejection case vacuously and the guard proves nothing.
    expect(resolveAgentOutputRecorder("architect").profile).toBe("architect");
    expect(() => resolveAgentOutputRecorder("nobody")).toThrow(
      UnknownAgentProfileError,
    );
  });

  it("maps a decision-question onto a blocked worker.question event", () => {
    const recorder = resolveAgentOutputRecorder("architect");
    const item: CapturedAgentOutput = {
      profile: "architect",
      type: "decision-question",
      text: "Should the migration run before the schema change?",
    };

    // worker.question is validated to carry status "blocked" (run-history.ts),
    // so the mapping must produce it rather than leaving it to the caller.
    expect(recorder.toEvent(item, "2026-10-30T10:00:00.000Z")).toEqual({
      type: "worker.question",
      stage: "worker",
      status: "blocked",
    });
  });

  it("maps a milestone onto a worker.progress event", () => {
    const recorder = resolveAgentOutputRecorder("architect");
    const item: CapturedAgentOutput = {
      profile: "architect",
      type: "milestone",
      text: "plan posted to the issue",
    };

    expect(recorder.toEvent(item, "2026-10-30T10:00:00.000Z")).toEqual({
      type: "worker.progress",
      stage: "worker",
    });
  });

  it("carries the comment reference through the mapping", () => {
    const recorder = resolveAgentOutputRecorder("architect");
    const item: CapturedAgentOutput = {
      profile: "architect",
      type: "decision-question",
      text: "Which database should the fixture target?",
      commentReference: "https://github.com/example/repo/issues/1#issuecomment-2",
    };

    expect(
      recorder.toEvent(item, "2026-10-30T10:00:00.000Z").commentReference,
    ).toBe("https://github.com/example/repo/issues/1#issuecomment-2");
  });
});
