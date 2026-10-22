/**
 * Verdict for the `model-check` eval (#440).
 *
 * `/eve/v1/info` reports one of two model shapes (see AgentInfoResultSchema):
 *   - static:   { id: string, routing: { kind: "gateway" | "external" } }
 *   - governed: { routing: { kind: "dynamic" } }  - and `id` MUST be absent.
 *
 * `agent/agent.ts` selects the governed branch whenever the LLM call policy or the cost
 * gate is configured, so an absent id is correct behaviour rather than a fault. The eval
 * used to read `.id` and call `.includes` on it, which threw
 * "Cannot read properties of undefined (reading 'includes')" instead of reporting anything.
 */
export type ModelVerdict = { ok: boolean; message: string };

/** `routing.kind` for the governed branch; "governed" is a gloss, this is the wire value. */
const DYNAMIC_ROUTING_KIND = "dynamic";
const EXPECTED_MODEL_FRAGMENT = "deepseek";

type ModelShape = { id?: unknown; routing?: { kind?: unknown } };

function modelShapeOf(info: unknown): ModelShape | undefined {
  const record = (value: unknown) =>
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

  const agent = record(record(info)?.agent);
  const model = record(agent?.model);
  return model as ModelShape | undefined;
}

export function evaluateModelCheck(info: unknown): ModelVerdict {
  const model = modelShapeOf(info);
  const kind = typeof model?.routing?.kind === "string" ? model.routing.kind : undefined;
  const id = model?.id;

  // Governed: selected when the call policy or the cost gate is configured. The schema makes
  // `id` optional-never here, so there is genuinely nothing to compare - say so, rather than
  // reporting a pass that looks like it verified the model.
  if (kind === DYNAMIC_ROUTING_KIND) {
    return {
      ok: true,
      message:
        "model is governed (routing.kind dynamic, no static id per AgentInfoResultSchema) - " +
        "the model is chosen per step, so a configured model cannot be read from /eve/v1/info",
    };
  }

  if (typeof id === "string" && id.includes(EXPECTED_MODEL_FRAGMENT)) {
    return {
      ok: true,
      message: `model is the configured OpenRouter model (deepseek by default): ${id}`,
    };
  }

  if (typeof id === "string") {
    return {
      ok: false,
      message: `model is ${id}, expected the configured OpenRouter model (deepseek by default)`,
    };
  }

  return {
    ok: false,
    message:
      'no model reported by /eve/v1/info (agent.model.id absent and routing.kind is not "dynamic")',
  };
}
