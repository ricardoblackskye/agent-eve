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
