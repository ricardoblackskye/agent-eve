import { describe, expect, it, vi } from "vitest";
import type { AgentStaticModelDefinition } from "eve";
import {
  buildOrchestratorModel,
  ORCHESTRATOR_CONTEXT_WINDOW_TOKENS,
  toEveReasoning,
} from "../agent/orchestrator-model";

/** A stand-in for the AI SDK LanguageModel returned by resolveChatModel(). */
const CHAT_MODEL = {
  marker: "chat-model",
} as unknown as AgentStaticModelDefinition;

/** The runtime shape of a `defineDynamic(...)` result. */
interface Sentinel {
  kind: string;
  events: Record<string, (event: unknown, ctx: unknown) => Promise<unknown>>;
}

function asSentinel(value: unknown): Sentinel {
  return value as Sentinel;
}

describe("toEveReasoning", () => {
  it("maps every policy level onto eve's provider-agnostic reasoning", () => {
    expect(toEveReasoning("off")).toBe("none");
    expect(toEveReasoning("low")).toBe("low");
    expect(toEveReasoning("medium")).toBe("medium");
    expect(toEveReasoning("high")).toBe("high");
  });
});

describe("buildOrchestratorModel", () => {
  it("returns the static model unchanged when nothing is configured", () => {
    const built = buildOrchestratorModel({ env: {}, chatModel: CHAT_MODEL });
    expect(built).toBe(CHAT_MODEL);
  });

  it("returns a dynamic resolver once a policy is configured", () => {
    const built = buildOrchestratorModel({
      env: { DF_LLM_THINKING_LEVEL: "high" },
      chatModel: CHAT_MODEL,
    });

    expect(asSentinel(built).kind).toBe("eve:dynamic");
    expect(typeof asSentinel(built).events["step.started"]).toBe("function");
  });

  it("returns a dynamic resolver when only a cost gate is configured", () => {
    const built = buildOrchestratorModel({
      env: {},
      chatModel: CHAT_MODEL,
      gate: { admit: async () => {} },
    });

    expect(asSentinel(built).kind).toBe("eve:dynamic");
  });

  it("resolves the model and the context window from the handler", async () => {
    const built = buildOrchestratorModel({
      env: { DF_LLM_THINKING_LEVEL: "medium" },
      chatModel: CHAT_MODEL,
    });

    const selection = (await asSentinel(built).events["step.started"](
      {},
      {},
    )) as { model: unknown; modelContextWindowTokens: number };

    expect(selection.model).toBe(CHAT_MODEL);
    // With a dynamic model this must come from the handler, not a sibling.
    expect(selection.modelContextWindowTokens).toBe(
      ORCHESTRATOR_CONTEXT_WINDOW_TOKENS,
    );
  });

  it("fails the turn BEFORE the provider call when the gate refuses", async () => {
    const admit = vi.fn(async () => {
      throw new Error("budget_exceeded: orchestrator cap reached");
    });

    const built = buildOrchestratorModel({
      env: { DF_LLM_THINKING_LEVEL: "low" },
      chatModel: CHAT_MODEL,
      gate: { admit },
    });

    await expect(
      asSentinel(built).events["step.started"]({}, {}),
    ).rejects.toThrow(/budget_exceeded/);
    expect(admit).toHaveBeenCalledTimes(1);
  });

  it("admits the call before returning the model", async () => {
    const order: string[] = [];
    const admit = vi.fn(async () => {
      order.push("admit");
    });

    const built = buildOrchestratorModel({
      env: { DF_LLM_MAX_STEPS: "5" },
      chatModel: CHAT_MODEL,
      gate: { admit },
    });

    await asSentinel(built).events["step.started"]({}, {});
    order.push("resolved");

    expect(order).toEqual(["admit", "resolved"]);
  });

  it("fails closed on a malformed policy rather than starting the turn", () => {
    expect(() =>
      buildOrchestratorModel({
        env: { DF_LLM_MAX_STEPS: "many" },
        chatModel: CHAT_MODEL,
      }),
    ).toThrow();
  });
});
