# Agent

## Overview
Root agent package implementing the Dark Factory orchestrator agent using the Eve framework. Configures the agent model, integrates the dynamic LLM call policy, binds the pre-call cost gate, and establishes runtime identity via authored instructions.

## Interface
- `definition` (default export) [agent.ts] - Compiled eve agent definition configured with static or dynamic governed model.
- `resolveChatModel(opts?: { unreachable?: boolean; fallback?: string; modelId?: string }): ChatModel` [chat-model.ts:resolveChatModel]
- `resolveChatModelWithId(opts?: { unreachable?: boolean; fallback?: string; modelId?: string }): ResolvedChatModel` [chat-model.ts:resolveChatModelWithId]
- `resolveModelId(opts: { primary?: string; fallback?: string; unreachable?: boolean; envOverride?: string }): string` [model-config.ts:resolveModelId]
- `buildOrchestratorModel(input: OrchestratorBuildInput): OrchestratorModel` [orchestrator-model.ts:buildOrchestratorModel]
- `buildDynamicOrchestratorModel(input: OrchestratorBuildInput): DynamicModel` [orchestrator-model.ts:buildDynamicOrchestratorModel]
- `createOrchestratorGate(input: OrchestratorGateInput): OrchestratorGate | null` [orchestrator-gate.ts:createOrchestratorGate]
- `toEveReasoning(level: ThinkingLevel): EveReasoningLevel` [orchestrator-model.ts:toEveReasoning]
- `DEFAULT_MODEL_ID = 'deepseek/deepseek-v4.1-flash'` [model-config.ts:DEFAULT_MODEL_ID]
- `FALLBACK_MODEL_ID = 'deepseek/deepseek-v4-pro'` [model-config.ts:FALLBACK_MODEL_ID]
- `ORCHESTRATOR_CONTEXT_WINDOW_TOKENS = 1_048_576` [orchestrator-model.ts:ORCHESTRATOR_CONTEXT_WINDOW_TOKENS]
- `lib/dark-factory`: Core Dark Factory subsystem implementing sandboxed development, testing, cost budgeting, and autonomous self-improvement. Note: Markdown contract files are omitted from `agent/lib/` because the Eve compiler treats all files in `lib/` as authored code modules.

## Invariants
- [agent.ts:definition] Opt-in policy: when neither LLM policy nor cost gate is configured, agent evaluates byte-identical static model without dynamic wrapper.
- [orchestrator-model.ts:buildOrchestratorModel] With a dynamic model, modelContextWindowTokens must be emitted per call from step.started event handler rather than as a static sibling of defineAgent.
- [model-config.ts:resolveModelId] Never quietly fall back to the previous model unless an unreachable condition occurs AND a fallback model is explicitly requested.
- [chat-model.ts:buildChatModel] When OPENROUTER_API_KEY is unset, automatically falls back to deterministic in-memory mockModel so local dev/evals succeed without credentials.
- [orchestrator-gate.ts:createOrchestratorGate] Pre-call gate reserves against orchestrator category; any budget refusal immediately throws to abort the turn before invoking LLM provider.

## Side Effects
- [chat-model.ts:openrouter] Initiates outbound HTTPS requests to `https://openrouter.ai/api/v1` when OPENROUTER_API_KEY is provided.
- [orchestrator-gate.ts:createOrchestratorGate] Interacts with cost governor store (SQLite or PostgreSQL) to record and reserve token budget allocations.

## Verification
- Run: `npm test`
