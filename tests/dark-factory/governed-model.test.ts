/**
 * #270 — the governed dynamic model (shared by the orchestrator and the subagents).
 *
 * Contract: static passthrough when no gate; a dynamic resolver that runs the gate
 * FIRST so a refusal fails the turn before the provider call.
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentStaticModelDefinition } from "eve";
import { buildGovernedDynamicModel } from "../../agent/lib/dark-factory/governed-model";

const CHAT_MODEL = { marker: "chat-model" } as unknown as AgentStaticModelDefinition;

interface Sentinel {
  kind: string;
  events: Record<string, (event: unknown, ctx: unknown) => Promise<unknown>>;
}
const asSentinel = (v: unknown): Sentinel => v as Sentinel;

describe("buildGovernedDynamicModel (#270)", () => {

  it("admits the call before resolving the model and window", async () => {
    const order: string[] = [];
    const admit = vi.fn(async () => {
      order.push("admit");
    });
    const built = buildGovernedDynamicModel({
      chatModel: CHAT_MODEL,
      contextWindowTokens: 4242,
      gate: { admit },
    });

    const selection = (await asSentinel(built).events["step.started"]({}, {})) as {
      model: unknown;
      modelContextWindowTokens: number;
    };
    order.push("resolved");

    expect(order).toEqual(["admit", "resolved"]);
    expect(selection.model).toBe(CHAT_MODEL);
    expect(selection.modelContextWindowTokens).toBe(4242);
  });

  it("settles the reservation from usage once the call completes (#443)", async () => {
    const settleFromUsage = vi.fn(async () => {});
    const model = {
      doGenerate: async () => ({ usage: { inputTokens: 10, outputTokens: 20 } }),
    };
    const built = buildGovernedDynamicModel({
      chatModel: model as never,
      contextWindowTokens: 1,
      gate: {
        admit: async () => ({ settle: async () => {}, settleFromUsage }),
      } as never,
    });

    const selection = (await asSentinel(built).events["step.started"]({}, {})) as {
      model: { doGenerate: () => Promise<unknown> };
    };
    await selection.model.doGenerate();

    expect(settleFromUsage).toHaveBeenCalledWith({ inputTokens: 10, outputTokens: 20 });
  });

  it("settles with the estimate when the call throws, and rethrows untouched (#443)", async () => {
    const settle = vi.fn(async () => {});
    const boom = new Error("provider exploded");
    const model = {
      doGenerate: async () => {
        throw boom;
      },
    };
    const built = buildGovernedDynamicModel({
      chatModel: model as never,
      contextWindowTokens: 1,
      gate: { admit: async () => ({ settle, settleFromUsage: async () => {} }) } as never,
    });

    const selection = (await asSentinel(built).events["step.started"]({}, {})) as {
      model: { doGenerate: () => Promise<unknown> };
    };

    await expect(selection.model.doGenerate()).rejects.toThrow(boom);
    expect(settle).toHaveBeenCalledWith(null);
  });

  it("settles a streamed call when the stream finishes, from the finish part usage (#443)", async () => {
    const settleFromUsage = vi.fn(async () => {});
    const parts = [
      { type: "text-delta", text: "hi" },
      { type: "finish", usage: { inputTokens: 7, outputTokens: 8 } },
    ];
    const model = {
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      }),
    };
    const built = buildGovernedDynamicModel({
      chatModel: model as never,
      contextWindowTokens: 1,
      gate: { admit: async () => ({ settle: async () => {}, settleFromUsage }) } as never,
    });

    const selection = (await asSentinel(built).events["step.started"]({}, {})) as {
      model: { doStream: () => Promise<{ stream: ReadableStream }> };
    };
    const result = await selection.model.doStream();
    const reader = result.stream.getReader();
    let partsSeen = 0;
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
      partsSeen += 1;
    }

    expect(partsSeen).toBe(2);
    expect(settleFromUsage).toHaveBeenCalledWith({ inputTokens: 7, outputTokens: 8 });
  });

  it("fails the turn BEFORE the provider call when the gate refuses", async () => {
    const admit = vi.fn(async () => {
      throw new Error("budget_exceeded: developer cap reached");
    });
    const built = buildGovernedDynamicModel({
      chatModel: CHAT_MODEL,
      contextWindowTokens: 100,
      gate: { admit },
    });

    await expect(asSentinel(built).events["step.started"]({}, {})).rejects.toThrow(/budget_exceeded/);
    expect(admit).toHaveBeenCalledTimes(1);
  });

  it("skips the gate when none is configured (resolver still returns the model)", async () => {
    const built = buildGovernedDynamicModel({ chatModel: CHAT_MODEL, contextWindowTokens: 7 });
    const selection = (await asSentinel(built).events["step.started"]({}, {})) as {
      modelContextWindowTokens: number;
    };
    expect(selection.modelContextWindowTokens).toBe(7);
  });
});
