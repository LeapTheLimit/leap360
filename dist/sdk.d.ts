/**
 * leap360-sdk — Leap360Client + Leap360 (auto-wrap) class
 *
 * Two usage styles:
 *
 * ── Style 1: Auto-wrap (mirrors the GitHub reference SDK) ─────────────────
 *   import { Leap360 } from 'leap360-sdk';
 *
 *   const leap = new Leap360({ apiKey: '...', projectId: 'my-app', serviceName: 'chat-bot' });
 *
 *   // Wrap OpenAI client — every call is traced automatically
 *   const openai = leap.wrapOpenAI(new OpenAI());
 *
 *   // Wrap Google Gemini client
 *   leap.wrapGemini(genAI);           // wraps genAI.getGenerativeModel(...)
 *
 *   // Group calls into a named agent run
 *   const agent = leap.createAgent({ name: 'Support Bot' });
 *   await agent.run(async (client) => {
 *     await client.chat.completions.create({ ... });
 *   });
 *
 * ── Style 2: Manual trace (maximum flexibility) ────────────────────────────
 *   import { Leap360Client } from 'leap360-sdk';
 *   const leap = new Leap360Client();        // reads from ~/.leap360/config.json
 *
 *   const result = await leap.traceCall({
 *     agentName: 'My Bot',
 *     provider: 'openai',
 *     model: 'gpt-4o',
 *     fn: () => openai.chat.completions.create({ ... }),
 *   });
 */
export interface TracePayload {
    /** Display name of your agent */
    agentName?: string;
    /** The service or app this agent belongs to */
    serviceName?: string;
    /** Group multiple calls belonging to the same run */
    runId?: string;
    /** e.g. 'openai', 'google', 'anthropic', 'mistral' */
    provider: string;
    /** e.g. 'gpt-4o', 'gemini-2.0-flash', 'claude-3-sonnet' */
    model: string;
    /** The input sent to the model — can be anything JSON-serializable */
    request?: Record<string, unknown>;
    /** The output from the model */
    response?: Record<string, unknown>;
    /** Call duration in milliseconds */
    latencyMs?: number;
    /** Token usage */
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
    /** ISO timestamp — defaults to now */
    timestamp?: string;
    /** Error message if the call failed */
    error?: string | null;
}
export interface TraceCallOptions<T> {
    agentName?: string;
    serviceName?: string;
    runId?: string;
    provider: string;
    model: string;
    /** The async function that calls your LLM — its return value is passed through */
    fn: () => Promise<T>;
    /**
     * Optional: extract token usage from the LLM response.
     */
    extractUsage?: (result: T) => {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
    extractRequest?: (result: T) => Record<string, unknown>;
    extractResponse?: (result: T) => Record<string, unknown>;
    /** Extra context you want attached to the trace */
    metadata?: Record<string, unknown>;
}
export interface Leap360ClientOptions {
    /** Override the API key (defaults to reading from ~/.leap360/config.json) */
    apiKey?: string;
    /** Override the Cloud API URL */
    apiUrl?: string;
    /** If true, won't throw when the API is unreachable — just logs a warning */
    silent?: boolean;
    /** Project label — defaults to 'default' */
    projectId?: string;
}
export type Leap360Config = {
    apiKey: string;
    projectId: string;
    serviceName: string;
    /** Override the base URL (defaults to the deployed cloud API) */
    baseUrl?: string;
};
export declare class Leap360 {
    private config;
    private wrappedOpenAIClient;
    constructor(config: Leap360Config);
    /**
     * Wraps an OpenAI client so every `chat.completions.create` call is
     * automatically traced and sent to Leap360.
     *
     * @example
     * import OpenAI from 'openai';
     * const openai = leap.wrapOpenAI(new OpenAI());
     * const res = await openai.chat.completions.create({ model: 'gpt-4o', ... });
     */
    wrapOpenAI<OpenAIClient>(client: OpenAIClient): OpenAIClient;
    /**
     * Wraps a `@google/generative-ai` GoogleGenerativeAI instance so every
     * `generateContent` / `generateContentStream` call is traced automatically.
     *
     * @example
     * import { GoogleGenerativeAI } from '@google/generative-ai';
     * const genAI = leap.wrapGemini(new GoogleGenerativeAI(apiKey));
     * const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
     * const res = await model.generateContent('Hello!');
     */
    wrapGemini<GeminiClient>(client: GeminiClient): GeminiClient;
    /**
     * Creates a named agent context. All LLM calls made inside `agent.run(...)`
     * will be tagged with the agent name and a shared run ID in Leap360.
     *
     * @example
     * const agent = leap.createAgent({ name: 'Support Bot' });
     * await agent.run(async (client) => {
     *   await client.chat.completions.create({ model: 'gpt-4o', messages: [...] });
     * });
     */
    createAgent(opts: {
        name: string;
    }): {
        run: <T>(fn: (client: unknown) => Promise<T>) => Promise<T>;
    };
}
export declare class Leap360Client {
    private apiKey;
    private apiUrl;
    private silent;
    private projectId;
    constructor(options?: Leap360ClientOptions);
    /**
     * Wrap any async LLM call — automatically records latency, errors, and usage.
     * Returns the original result of `options.fn()` unchanged.
     */
    traceCall<T>(options: TraceCallOptions<T>): Promise<T>;
    /** Send a fully-built trace payload to the Leap360 Cloud API */
    sendTrace(payload: TracePayload): Promise<void>;
}
//# sourceMappingURL=sdk.d.ts.map