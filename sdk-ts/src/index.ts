/**
 * @leap360/sdk — TypeScript/JavaScript SDK
 *
 * Usage:
 *   import { Leap360 } from '@leap360/sdk';
 *   const leap = new Leap360({ apiKey: '...', projectId: '...', serviceName: '...' });
 *   const openai = leap.wrapOpenAI(new OpenAI({ apiKey: '...' }));
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import * as crypto from 'node:crypto';

// ─── Types ────────────────────────────────────────────────────────────────────

export type Leap360Config = {
    /** Your Leap360 API key (from `pnpm seed` output or .env). */
    apiKey: string;
    /** Project ID to tag traces against. */
    projectId: string;
    /** Logical service name (e.g. "billing-service"). */
    serviceName: string;
    /**
     * Base URL of the local Leap360 API server.
     * Defaults to http://localhost:4000 for local-first usage.
     */
    baseUrl?: string;
    /** Suppress console warnings on failed trace posts. Default: false */
    silent?: boolean;
};

type RunContext = {
    runId: string;
    agentName: string;
};

// ─── Shared async context ─────────────────────────────────────────────────────

const runContextStorage = new AsyncLocalStorage<RunContext>();

// ─── Main class ───────────────────────────────────────────────────────────────

export class Leap360 {
    private config: Required<Omit<Leap360Config, 'silent'>> & { silent: boolean };

    constructor(config: Leap360Config) {
        this.config = {
            ...config,
            baseUrl: (config.baseUrl || 'http://localhost:4000').replace(/\/$/, ''),
            silent: config.silent ?? false,
        };
    }

    // ── Kill-switch check ─────────────────────────────────────────────────────

    /**
     * Check whether the project (and optionally a specific agent) is allowed
     * to make AI calls. Throws if suspended.
     */
    async checkKillSwitch(agentName?: string): Promise<void> {
        try {
            const params = agentName ? `?agent=${encodeURIComponent(agentName)}` : '';
            const res = await fetch(
                `${this.config.baseUrl}/v1/projects/${this.config.projectId}/killswitch/check${params}`,
                { headers: { 'x-leap360-key': this.config.apiKey } }
            );
            if (!res.ok) return; // if API unreachable, allow through
            const data: any = await res.json();
            if (!data.allowed) {
                throw new Error(
                    `[Leap360] KILL_SWITCH_ACTIVE (${data.scope}): ${data.reason}`
                );
            }
        } catch (err: any) {
            if (err.message?.startsWith('[Leap360] KILL_SWITCH_ACTIVE')) throw err;
            // Network errors don't block — degrade gracefully
            if (!this.config.silent) {
                console.warn('[Leap360] Kill-switch check failed (API unreachable) — proceeding.');
            }
        }
    }

    // ── OpenAI wrapper ────────────────────────────────────────────────────────

    /**
     * Wrap an OpenAI client instance. All `chat.completions.create` calls will
     * be traced and checked against the kill-switch automatically.
     */
    wrapOpenAI<T extends object>(client: T): T {
        const self = this;
        const originalCreate = (client as any).chat.completions.create.bind(
            (client as any).chat.completions
        );

        (client as any).chat.completions.create = async (body: any, options?: any) => {
            const runCtx = runContextStorage.getStore();

            // Kill-switch check before the call
            await self.checkKillSwitch(runCtx?.agentName);

            const startTime = Date.now();
            let response: any;
            let error: string | null = null;

            try {
                response = await originalCreate(body, options);
            } catch (err: any) {
                error = err?.message ?? String(err);
                throw err;
            } finally {
                const latencyMs = Date.now() - startTime;
                const usage = response?.usage ?? {};
                await self._postTrace({
                    runId: runCtx?.runId ?? crypto.randomUUID(),
                    agentName: runCtx?.agentName ?? null,
                    provider: 'openai',
                    model: body.model ?? 'unknown',
                    request: body,
                    response: response ?? {},
                    latencyMs,
                    usage: {
                        prompt_tokens: usage.prompt_tokens ?? 0,
                        completion_tokens: usage.completion_tokens ?? 0,
                        total_tokens: usage.total_tokens ?? 0,
                    },
                    error,
                });
            }

            return response;
        };

        return client;
    }

    // ── Anthropic wrapper ─────────────────────────────────────────────────────

    /**
     * Wrap an Anthropic client instance. `messages.create` calls will be traced.
     */
    wrapAnthropic<T extends object>(client: T): T {
        const self = this;
        const originalCreate = (client as any).messages.create.bind(
            (client as any).messages
        );

        (client as any).messages.create = async (body: any, options?: any) => {
            const runCtx = runContextStorage.getStore();
            await self.checkKillSwitch(runCtx?.agentName);

            const startTime = Date.now();
            let response: any;
            let error: string | null = null;

            try {
                response = await originalCreate(body, options);
            } catch (err: any) {
                error = err?.message ?? String(err);
                throw err;
            } finally {
                const latencyMs = Date.now() - startTime;
                const usage = response?.usage ?? {};
                await self._postTrace({
                    runId: runCtx?.runId ?? crypto.randomUUID(),
                    agentName: runCtx?.agentName ?? null,
                    provider: 'anthropic',
                    model: body.model ?? 'unknown',
                    request: body,
                    response: response ?? {},
                    latencyMs,
                    usage: {
                        prompt_tokens: usage.input_tokens ?? 0,
                        completion_tokens: usage.output_tokens ?? 0,
                        total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
                    },
                    error,
                });
            }

            return response;
        };

        return client;
    }

    // ── Gemini wrapper (google-generativeai legacy SDK) ───────────────────────

    /**
     * Wrap a `google.generativeai.GenerativeModel` instance.
     */
    wrapGemini<T extends object>(model: T): T {
        const self = this;
        const originalGenerate = (model as any).generateContent.bind(model);

        (model as any).generateContent = async (prompt: any) => {
            const runCtx = runContextStorage.getStore();
            await self.checkKillSwitch(runCtx?.agentName);

            const startTime = Date.now();
            let response: any;
            let error: string | null = null;

            try {
                response = await originalGenerate(prompt);
            } catch (err: any) {
                error = err?.message ?? String(err);
                throw err;
            } finally {
                const latencyMs = Date.now() - startTime;
                const meta = response?.response?.usageMetadata ?? {};
                await self._postTrace({
                    runId: runCtx?.runId ?? crypto.randomUUID(),
                    agentName: runCtx?.agentName ?? null,
                    provider: 'google',
                    model: (model as any).model ?? 'gemini',
                    request: { prompt },
                    response: response ?? {},
                    latencyMs,
                    usage: {
                        prompt_tokens: meta.promptTokenCount ?? 0,
                        completion_tokens: meta.candidatesTokenCount ?? 0,
                        total_tokens: meta.totalTokenCount ?? 0,
                    },
                    error,
                });
            }

            return response;
        };

        return model;
    }

    // ── Generic trace_call ────────────────────────────────────────────────────

    /**
     * Manually wrap any async function call and send the trace to Leap360.
     *
     * @example
     * await leap.traceCall({
     *   fn: () => myLLM.complete(prompt),
     *   provider: 'mistral',
     *   model: 'mistral-large-latest',
     * });
     */
    async traceCall<T>(options: {
        fn: () => Promise<T>;
        provider: string;
        model: string;
        agentName?: string;
        extractUsage?: (res: T) => {
            prompt_tokens: number;
            completion_tokens: number;
            total_tokens: number;
        };
    }): Promise<T> {
        const agentName = options.agentName ?? runContextStorage.getStore()?.agentName ?? null;
        await this.checkKillSwitch(agentName ?? undefined);

        const startTime = Date.now();
        let result: T | undefined;
        let error: string | null = null;

        try {
            result = await options.fn();
            return result;
        } catch (err: any) {
            error = err?.message ?? String(err);
            throw err;
        } finally {
            const latencyMs = Date.now() - startTime;
            const usage = result && options.extractUsage
                ? options.extractUsage(result)
                : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

            await this._postTrace({
                runId: crypto.randomUUID(),
                agentName,
                provider: options.provider,
                model: options.model,
                request: {},
                response: (result as any) ?? {},
                latencyMs,
                usage,
                error,
            });
        }
    }

    // ── Agent context runner ──────────────────────────────────────────────────

    /**
     * Run a block of code with a named agent context. All wrapped calls inside
     * the block will be tagged with this agent name.
     *
     * @example
     * const agent = leap.createAgent({ name: 'Finance-Bot' });
     * await agent.run(async () => {
     *   await openai.chat.completions.create({ ... });
     * });
     */
    createAgent(opts: { name: string }) {
        return {
            run: async <T>(fn: () => Promise<T>): Promise<T> => {
                const ctx: RunContext = {
                    runId: crypto.randomUUID(),
                    agentName: opts.name,
                };
                return runContextStorage.run(ctx, fn);
            },
        };
    }

    // ── Internal trace poster ─────────────────────────────────────────────────

    private async _postTrace(opts: {
        runId: string;
        agentName: string | null;
        provider: string;
        model: string;
        request: object;
        response: object;
        latencyMs: number;
        usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
        error: string | null;
    }): Promise<void> {
        const body = {
            project_id: this.config.projectId,
            service_name: this.config.serviceName,
            agent_name: opts.agentName,
            run_id: opts.runId,
            provider: opts.provider,
            model: opts.model,
            request: opts.request,
            response: opts.response,
            latency_ms: opts.latencyMs,
            usage: opts.usage,
            timestamp: new Date().toISOString(),
            error: opts.error,
        };

        try {
            const res = await fetch(`${this.config.baseUrl}/v1/traces`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-leap360-key': this.config.apiKey,
                },
                body: JSON.stringify(body),
            });

            if (!res.ok && !this.config.silent) {
                const text = await res.text().catch(() => '');
                console.warn(`[Leap360] Trace post failed (${res.status}): ${text}`);
            }
        } catch (err) {
            if (!this.config.silent) {
                console.warn('[Leap360] Failed to post trace (API unreachable):', err);
            }
        }
    }
}

// ─── Named export alias ───────────────────────────────────────────────────────

export { Leap360 as default };
