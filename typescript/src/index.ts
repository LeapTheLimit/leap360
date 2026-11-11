/**
 * leap360 — Universal AI Governance SDK  v1.5.0
 *
 * Provider support:
 *   leap.wrapOpenAI(client)      — openai
 *   leap.wrapAnthropic(client)   — @anthropic-ai/sdk           ← NEW in v1.5
 *   leap.wrapBedrock(client)     — @aws-sdk/client-bedrock-runtime  ← NEW in v1.5
 *   leap.wrapGemini(client)      — @google/generative-ai
 *   leap.wrapGoogleGenAI(client) — @google/genai (new SDK)
 *   leap.traceCall({ fn, provider, model }) — any other LLM
 *
 * Quick start:
 *   import { Leap360 } from 'leap360';
 *   const leap = new Leap360({ apiKey: 'leap360_...', projectId: 'my-app', serviceName: 'chat-bot' });
 *   const openai    = leap.wrapOpenAI(new OpenAI());
 *   const anthropic = leap.wrapAnthropic(new Anthropic());                   // NEW
 *   const bedrock   = leap.wrapBedrock(new BedrockRuntimeClient({ ... }));   // NEW
 */

export { Leap360, Leap360Client, SAFE_DEFAULT_RULES }              from './sdk.js';
export { shapeOf, redactLocally, type CaptureLevel }               from './privacy.js';
export type { Leap360Config, TracePayload, TraceCallOptions, Leap360ClientOptions } from './sdk.js';
export { loadCredentials, clearCredentials, saveCredentials }       from './auth.js';
export { CLOUD_API_URL, CREDENTIALS_PATH }                         from './config.js';
export type { Credentials }                                         from './config.js';
export { Governor, Leap360ActionBlockedError, declareTools }        from './governor.js';
export type { Mode, GovernorOptions, GateResult, DeclaredTool }     from './governor.js';
export {
  extractToolCalls, classifyAction, scanText, redactSecrets, decideAction, suggestPolicies, replayPolicy,
  extractToolDefinitions, capabilityMap, destinationsOf,
}                                                                   from './actions.js';
export type {
  ActionCategory, RiskLevel, Finding, ToolCall, ToolHints, ClassifiedAction, ActionPolicy, Verdict, PolicySuggestion,
  Capability, ActionSample, PolicyReplay,
}                                                                   from './actions.js';
