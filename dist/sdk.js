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
import { AsyncLocalStorage } from 'node:async_hooks';
import * as crypto from 'node:crypto';
import { loadCredentials } from './auth.js';
import { CLOUD_API_URL } from './config.js';
const runContextStorage = new AsyncLocalStorage();
// ─── Shared send logic ────────────────────────────────────────────────────
function buildTraceBody(opts) {
    return {
        project_id: opts.projectId,
        service_name: opts.serviceName,
        agent_name: opts.agentName ?? null,
        run_id: opts.runId ?? crypto.randomUUID(),
        provider: opts.provider,
        model: opts.model,
        request: opts.request ?? {},
        response: opts.response ?? null,
        latency_ms: opts.latencyMs,
        usage: opts.usage,
        timestamp: opts.timestamp,
        error: opts.error,
    };
}
async function postTrace(url, apiKey, body, silent) {
    try {
        const res = await fetch(`${url.replace(/\/$/, '')}/v1/traces`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-leap360-key': apiKey,
            },
            body: JSON.stringify(body),
        });
        if (!res.ok && !silent) {
            const text = await res.text();
            console.warn(`[Leap360] Trace rejected (${res.status}): ${text}`);
        }
    }
    catch (err) {
        if (!silent) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[Leap360] Failed to send trace: ${msg}`);
        }
    }
}
// ═══════════════════════════════════════════════════════════════════════════
// CLASS 1: Leap360 — auto-wrap style (matches GitHub reference SDK)
// ═══════════════════════════════════════════════════════════════════════════
export class Leap360 {
    config;
    wrappedOpenAIClient = null;
    constructor(config) {
        this.config = {
            ...config,
            baseUrl: config.baseUrl || CLOUD_API_URL,
        };
    }
    // ── OpenAI auto-wrap ────────────────────────────────────────────────────
    /**
     * Wraps an OpenAI client so every `chat.completions.create` call is
     * automatically traced and sent to Leap360.
     *
     * @example
     * import OpenAI from 'openai';
     * const openai = leap.wrapOpenAI(new OpenAI());
     * const res = await openai.chat.completions.create({ model: 'gpt-4o', ... });
     */
    wrapOpenAI(client) {
        const self = this;
        const originalCreate = client.chat.completions.create.bind(client.chat.completions);
        client.chat.completions.create = async (body, options) => {
            const startTime = Date.now();
            const runCtx = runContextStorage.getStore();
            let response = null;
            let error = null;
            try {
                response = await originalCreate(body, options);
            }
            catch (err) {
                error = err;
                throw err;
            }
            finally {
                const latencyMs = Date.now() - startTime;
                const model = (response?.model ?? body?.model ?? 'unknown');
                const usage = response?.usage;
                const traceBody = buildTraceBody({
                    projectId: self.config.projectId,
                    serviceName: self.config.serviceName,
                    agentName: runCtx?.agentName ?? null,
                    runId: runCtx?.runId,
                    provider: 'openai',
                    model,
                    request: typeof body === 'object' ? body : { content: body },
                    response: response ?? undefined,
                    latencyMs,
                    usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                    timestamp: new Date(startTime).toISOString(),
                    error: error ? (error instanceof Error ? error.message : String(error)) : null,
                });
                postTrace(self.config.baseUrl, self.config.apiKey, traceBody, false)
                    .catch(e => console.error('[Leap360]', e));
            }
            return response;
        };
        this.wrappedOpenAIClient = client;
        return client;
    }
    // ── Google Gemini auto-wrap ─────────────────────────────────────────────
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
    wrapGemini(client) {
        const self = this;
        const c = client;
        const originalGetModel = c.getGenerativeModel.bind(c);
        c.getGenerativeModel = (opts, ...args) => {
            const model = originalGetModel(opts, ...args);
            const modelName = (opts?.model ?? 'gemini');
            // Wrap generateContent
            const origGenContent = model.generateContent.bind(model);
            model.generateContent = async (...callArgs) => {
                const startTime = Date.now();
                const runCtx = runContextStorage.getStore();
                let response = null;
                let error = null;
                try {
                    response = await origGenContent(...callArgs);
                }
                catch (err) {
                    error = err;
                    throw err;
                }
                finally {
                    const latencyMs = Date.now() - startTime;
                    const usageMetadata = response?.response?.usageMetadata;
                    const usage = usageMetadata
                        ? { prompt_tokens: usageMetadata['promptTokenCount'] ?? 0, completion_tokens: usageMetadata['candidatesTokenCount'] ?? 0, total_tokens: usageMetadata['totalTokenCount'] ?? 0 }
                        : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
                    const traceBody = buildTraceBody({
                        projectId: self.config.projectId,
                        serviceName: self.config.serviceName,
                        agentName: runCtx?.agentName ?? null,
                        runId: runCtx?.runId,
                        provider: 'google',
                        model: modelName,
                        request: { prompt: callArgs[0] },
                        response: response ?? undefined,
                        latencyMs,
                        usage,
                        timestamp: new Date(startTime).toISOString(),
                        error: error ? (error instanceof Error ? error.message : String(error)) : null,
                    });
                    postTrace(self.config.baseUrl, self.config.apiKey, traceBody, false)
                        .catch(e => console.error('[Leap360]', e));
                }
                return response;
            };
            // Wrap generateContentStream (fire-and-forget trace after stream ends)
            const origStream = model.generateContentStream.bind(model);
            model.generateContentStream = async (...callArgs) => {
                const startTime = Date.now();
                const runCtx = runContextStorage.getStore();
                let error = null;
                let result = null;
                try {
                    result = await origStream(...callArgs);
                }
                catch (err) {
                    error = err;
                    throw err;
                }
                finally {
                    const latencyMs = Date.now() - startTime;
                    const traceBody = buildTraceBody({
                        projectId: self.config.projectId,
                        serviceName: self.config.serviceName,
                        agentName: runCtx?.agentName ?? null,
                        runId: runCtx?.runId,
                        provider: 'google',
                        model: modelName,
                        request: { prompt: callArgs[0] },
                        response: null,
                        latencyMs,
                        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                        timestamp: new Date(startTime).toISOString(),
                        error: error ? (error instanceof Error ? error.message : String(error)) : null,
                    });
                    postTrace(self.config.baseUrl, self.config.apiKey, traceBody, false)
                        .catch(e => console.error('[Leap360]', e));
                }
                return result;
            };
            return model;
        };
        return client;
    }
    // ── createAgent ─────────────────────────────────────────────────────────
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
    createAgent(opts) {
        return {
            run: async (fn) => {
                const runId = crypto.randomUUID();
                return runContextStorage.run({ runId, agentName: opts.name }, async () => {
                    return fn(this.wrappedOpenAIClient);
                });
            },
        };
    }
}
// ═══════════════════════════════════════════════════════════════════════════
// CLASS 2: Leap360Client — manual trace style (CLI-auth based)
// ═══════════════════════════════════════════════════════════════════════════
export class Leap360Client {
    apiKey;
    apiUrl;
    silent;
    projectId;
    constructor(options = {}) {
        this.apiUrl = options.apiUrl || CLOUD_API_URL;
        this.silent = options.silent ?? true;
        this.projectId = options.projectId || 'default';
        if (options.apiKey) {
            this.apiKey = options.apiKey;
        }
        else if (process.env['LEAP360_API_KEY']) {
            this.apiKey = process.env['LEAP360_API_KEY'];
        }
        else {
            const creds = loadCredentials();
            if (!creds) {
                const msg = '[Leap360] Not authenticated. Run `leap360 login` or set LEAP360_API_KEY.';
                if (!this.silent)
                    throw new Error(msg);
                console.warn(msg);
                this.apiKey = '';
            }
            else {
                this.apiKey = creds.apiKey;
            }
        }
    }
    /**
     * Wrap any async LLM call — automatically records latency, errors, and usage.
     * Returns the original result of `options.fn()` unchanged.
     */
    async traceCall(options) {
        const start = Date.now();
        let result;
        let error = null;
        try {
            result = await options.fn();
        }
        catch (err) {
            error = err instanceof Error ? err.message : String(err);
            await this.sendTrace({
                agentName: options.agentName,
                serviceName: options.serviceName || 'default',
                runId: options.runId,
                provider: options.provider,
                model: options.model,
                request: options.metadata ?? {},
                latencyMs: Date.now() - start,
                error,
            });
            throw err;
        }
        await this.sendTrace({
            agentName: options.agentName,
            serviceName: options.serviceName || 'default',
            runId: options.runId,
            provider: options.provider,
            model: options.model,
            request: options.extractRequest?.(result) ?? options.metadata ?? {},
            response: options.extractResponse?.(result) ?? {},
            latencyMs: Date.now() - start,
            usage: options.extractUsage?.(result),
            error: null,
        });
        return result;
    }
    /** Send a fully-built trace payload to the Leap360 Cloud API */
    async sendTrace(payload) {
        if (!this.apiKey)
            return;
        const body = buildTraceBody({
            projectId: this.projectId,
            serviceName: payload.serviceName ?? 'default',
            agentName: payload.agentName ?? null,
            runId: payload.runId,
            provider: payload.provider,
            model: payload.model,
            request: payload.request ?? {},
            response: payload.response ?? null,
            latencyMs: payload.latencyMs ?? 0,
            usage: payload.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            timestamp: payload.timestamp ?? new Date().toISOString(),
            error: payload.error ?? null,
        });
        await postTrace(this.apiUrl, this.apiKey, body, this.silent);
    }
}
//# sourceMappingURL=sdk.js.map