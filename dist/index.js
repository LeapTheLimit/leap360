/**
 * leap360-sdk — public API
 *
 * ── Auto-wrap style (recommended) ──────────────────────────────────────────
 *   import { Leap360 } from 'leap360-sdk';
 *
 *   const leap = new Leap360({ apiKey: 'lp360_...', projectId: 'my-app', serviceName: 'chat-bot' });
 *   const openai = leap.wrapOpenAI(new OpenAI());          // OpenAI auto-traced
 *   const genAI  = leap.wrapGemini(new GoogleGenerativeAI(key)); // Gemini auto-traced
 *
 *   const agent = leap.createAgent({ name: 'Support Bot' });
 *   await agent.run(async (client) => {
 *     await client.chat.completions.create({ ... });
 *   });
 *
 * ── Manual style (max flexibility) ─────────────────────────────────────────
 *   import { Leap360Client } from 'leap360-sdk';
 *   const leap = new Leap360Client();  // reads from ~/.leap360/config.json
 *
 *   const result = await leap.traceCall({
 *     agentName: 'My Bot',
 *     provider: 'openai',
 *     model: 'gpt-4o',
 *     fn: () => myLLMCall(prompt),
 *   });
 */
export { Leap360, Leap360Client } from './sdk.js';
export { loadCredentials, clearCredentials, saveCredentials } from './auth.js';
export { CLOUD_API_URL, CREDENTIALS_PATH } from './config.js';
//# sourceMappingURL=index.js.map