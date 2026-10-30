import { describe, it, expect } from "vitest";
import {
  resolveAgentOutputRecorder,
  UnknownAgentProfileError,
  UnsupportedAgentOutputTypeError,
  type CapturedAgentOutput,
} from "../../agent/lib/dark-factory/agent-output";
import { MAX_COMMENT_CHARS } from "../../agent/lib/dark-factory/plan-comment";

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
    expect(recorder.toEvent(item)).toEqual({
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

    expect(recorder.toEvent(item)).toEqual({
      type: "worker.progress",
      stage: "worker",
    });
  });

  it("maps a roadblock onto its own type without forcing a blocked status", () => {
    const recorder = resolveAgentOutputRecorder("developer");
    const item: CapturedAgentOutput = {
      profile: "developer",
      type: "roadblock",
      text: "no allow-listed command applies to this change",
    };

    // A roadblock is recoverable, so it must NOT borrow worker.question's
    // blocked status (which is what the park/resume path treats as parked).
    expect(recorder.toEvent(item)).toEqual({
      type: "worker.roadblock",
      stage: "worker",
    });
  });

  it("carries the issue comment reference through the mapping", () => {
    const recorder = resolveAgentOutputRecorder("architect");
    const item: CapturedAgentOutput = {
      profile: "architect",
      type: "decision-question",
      text: "Which database should the fixture target?",
      commentReference: {
        provider: "github",
        id: 2,
        url: "https://github.com/example/repo/issues/1#issuecomment-2",
      },
    };

    expect(recorder.toEvent(item).commentReference).toEqual({
      provider: "github",
      id: 2,
      url: "https://github.com/example/repo/issues/1#issuecomment-2",
    });
  });

  it("omits the comment reference entirely when none was posted", () => {
    const recorder = resolveAgentOutputRecorder("tester");
    const item: CapturedAgentOutput = {
      profile: "tester",
      type: "milestone",
      text: "test run completed",
    };

    expect("commentReference" in recorder.toEvent(item)).toBe(false);
  });

  it("redacts an inline DF_ secret before the text leaves the recorder", () => {
    const recorder = resolveAgentOutputRecorder("developer");
    const item: CapturedAgentOutput = {
      profile: "developer",
      type: "roadblock",
      text: "the sandbox refused: DF_API_KEY=sk-live-notARealSecret was rejected",
    };

    const prepared = recorder.prepare(item);

    expect(prepared.text).toContain("[redacted DF_API_KEY]");
    expect(prepared.text).not.toContain("sk-live-notARealSecret");
  });

  it("caps an oversized item and flags it as truncated", () => {
    const recorder = resolveAgentOutputRecorder("developer");
    const item: CapturedAgentOutput = {
      profile: "developer",
      type: "roadblock",
      text: "x".repeat(MAX_COMMENT_CHARS + 5_000),
    };

    const prepared = recorder.prepare(item);

    expect(prepared.text.length).toBe(MAX_COMMENT_CHARS);
    expect(prepared.truncated).toBe(true);
  });

  it("does not flag a within-budget item as truncated", () => {
    // Control for the case above: a passing truncation assertion must not be
    // satisfiable by always reporting truncated.
    const recorder = resolveAgentOutputRecorder("developer");
    const prepared = recorder.prepare({
      profile: "developer",
      type: "milestone",
      text: "developer loop finished",
    });

    expect(prepared.truncated).toBe(false);
  });

  it("refuses a type outside the agreed set", () => {
    const recorder = resolveAgentOutputRecorder("architect");
    // Valid case first, so a throwing stub cannot satisfy this vacuously.
    expect(
      recorder.prepare({
        profile: "architect",
        type: "milestone",
        text: "planned",
      }).type,
    ).toBe("worker.progress");
    expect(() =>
      recorder.prepare({
        profile: "architect",
        type: "transcript" as never,
        text: "the whole model transcript",
      }),
    ).toThrow(UnsupportedAgentOutputTypeError);
  });

  it("carries the mapped event fields alongside the bounded text", () => {
    const recorder = resolveAgentOutputRecorder("architect");
    const prepared = recorder.prepare({
      profile: "architect",
      type: "decision-question",
      text: "Which migration order do you want?",
    });

    expect(prepared.type).toBe("worker.question");
    expect(prepared.stage).toBe("worker");
    expect(prepared.status).toBe("blocked");
  });
});
