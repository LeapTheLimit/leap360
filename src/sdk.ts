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

// ─── Shared Types ──────────────────────────────────────────────────────────

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
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
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
  extractUsage?: (result: T) => { prompt_tokens: number; completion_tokens: number; total_tokens: number };
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

// ─── Config for auto-wrap Leap360 class ───────────────────────────────────

export type Leap360Config = {
  apiKey: string;
  projectId: string;
  serviceName: string;
  /** Override the base URL (defaults to the deployed cloud API) */
  baseUrl?: string;
};

// ─── Internal run context (for createAgent) ────────────────────────────────

type RunContext = {
  runId: string;
  agentName: string;
};

const runContextStorage = new AsyncLocalStorage<RunContext>();

// ─── Shared send logic ────────────────────────────────────────────────────

function buildTraceBody(
  opts: {
    projectId: string;
    serviceName: string;
    agentName?: string | null;
    runId?: string;
    provider: string;
    model: string;
    request?: Record<string, unknown>;
    response?: Record<string, unknown> | null;
    latencyMs: number;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    timestamp: string;
    error: string | null;
  }
) {
  return {
    project_id:   opts.projectId,
    service_name: opts.serviceName,
    agent_name:   opts.agentName ?? null,
    run_id:       opts.runId ?? crypto.randomUUID(),
    provider:     opts.provider,
    model:        opts.model,
    request:      opts.request  ?? {},
    response:     opts.response ?? null,
    latency_ms:   opts.latencyMs,
    usage:        opts.usage,
    timestamp:    opts.timestamp,
    error:        opts.error,
  };
}

async function postTrace(url: string, apiKey: string, body: Record<string, unknown>, silent: boolean) {
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/v1/traces`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'x-leap360-key': apiKey,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok && !silent) {
      const text = await res.text();
      console.warn(`[Leap360] Trace rejected (${res.status}): ${text}`);
    }
  } catch (err: unknown) {
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
  private config: Required<Leap360Config>;
  private wrappedOpenAIClient: unknown = null;

  constructor(config: Leap360Config) {
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
  wrapOpenAI<OpenAIClient>(client: OpenAIClient): OpenAIClient {
    const self = this;
    const originalCreate = (client as Record<string, unknown> & { chat: { completions: { create: (...a: unknown[]) => unknown } } }).chat.completions.create.bind(
      (client as Record<string, unknown> & { chat: { completions: unknown } }).chat.completions
    );

    (client as Record<string, unknown> & { chat: { completions: { create: unknown } } }).chat.completions.create = async (body: Record<string, unknown>, options?: unknown) => {
      const startTime = Date.now();
      const runCtx    = runContextStorage.getStore();

      let response: Record<string, unknown> | null = null;
      let error: unknown = null;

      try {
        response = await (originalCreate as (b: unknown, o: unknown) => Promise<Record<string, unknown>>)(body, options);
      } catch (err) {
        error = err;
        throw err;
      } finally {
        const latencyMs = Date.now() - startTime;
        const model = (response?.model ?? body?.model ?? 'unknown') as string;
        const usage = response?.usage as { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;

        const traceBody = buildTraceBody({
          projectId:   self.config.projectId,
          serviceName: self.config.serviceName,
          agentName:   runCtx?.agentName ?? null,
          runId:       runCtx?.runId,
          provider:    'openai',
          model,
          request:     typeof body === 'object' ? body : { content: body },
          response:    response ?? undefined,
          latencyMs,
          usage:       usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          timestamp:   new Date(startTime).toISOString(),
          error:       error ? (error instanceof Error ? error.message : String(error)) : null,
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
  wrapGemini<GeminiClient>(client: GeminiClient): GeminiClient {
    const self = this;
    const c = client as Record<string, unknown> & {
      getGenerativeModel: (opts: Record<string, unknown>, ...args: unknown[]) => Record<string, unknown>;
    };
    const originalGetModel = c.getGenerativeModel.bind(c);

    c.getGenerativeModel = (opts: Record<string, unknown>, ...args: unknown[]) => {
      const model = originalGetModel(opts, ...args) as Record<string, unknown> & {
        generateContent: (...a: unknown[]) => Promise<Record<string, unknown>>;
        generateContentStream: (...a: unknown[]) => Promise<Record<string, unknown>>;
      };
      const modelName = (opts?.model ?? 'gemini') as string;

      // Wrap generateContent
      const origGenContent = model.generateContent.bind(model);
      model.generateContent = async (...callArgs: unknown[]) => {
        const startTime = Date.now();
        const runCtx    = runContextStorage.getStore();
        let response: Record<string, unknown> | null = null;
        let error: unknown = null;
        try {
          response = await origGenContent(...callArgs);
        } catch (err) {
          error = err;
          throw err;
        } finally {
          const latencyMs = Date.now() - startTime;
          const usageMetadata = (response as Record<string, unknown> & { response?: Record<string, unknown> })?.response?.usageMetadata as Record<string, number> | undefined;
          const usage = usageMetadata
            ? { prompt_tokens: usageMetadata['promptTokenCount'] ?? 0, completion_tokens: usageMetadata['candidatesTokenCount'] ?? 0, total_tokens: usageMetadata['totalTokenCount'] ?? 0 }
            : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

          const traceBody = buildTraceBody({
            projectId:   self.config.projectId,
            serviceName: self.config.serviceName,
            agentName:   runCtx?.agentName ?? null,
            runId:       runCtx?.runId,
            provider:    'google',
            model:       modelName,
            request:     { prompt: callArgs[0] },
            response:    response ?? undefined,
            latencyMs,
            usage,
            timestamp:   new Date(startTime).toISOString(),
            error:       error ? (error instanceof Error ? error.message : String(error)) : null,
          });
          postTrace(self.config.baseUrl, self.config.apiKey, traceBody, false)
            .catch(e => console.error('[Leap360]', e));
        }
        return response!;
      };

      // Wrap generateContentStream (fire-and-forget trace after stream ends)
      const origStream = model.generateContentStream.bind(model);
      model.generateContentStream = async (...callArgs: unknown[]) => {
        const startTime = Date.now();
        const runCtx    = runContextStorage.getStore();
        let error: unknown = null;
        let result: Record<string, unknown> | null = null;
        try {
          result = await origStream(...callArgs);
        } catch (err) {
          error = err;
          throw err;
        } finally {
          const latencyMs = Date.now() - startTime;
          const traceBody = buildTraceBody({
            projectId:   self.config.projectId,
            serviceName: self.config.serviceName,
            agentName:   runCtx?.agentName ?? null,
            runId:       runCtx?.runId,
            provider:    'google',
            model:       modelName,
            request:     { prompt: callArgs[0] },
            response:    null,
            latencyMs,
            usage:       { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            timestamp:   new Date(startTime).toISOString(),
            error:       error ? (error instanceof Error ? error.message : String(error)) : null,
          });
          postTrace(self.config.baseUrl, self.config.apiKey, traceBody, false)
            .catch(e => console.error('[Leap360]', e));
        }
        return result!;
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
  createAgent(opts: { name: string }) {
    return {
      run: async <T>(fn: (client: unknown) => Promise<T>): Promise<T> => {
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
  private apiKey:    string;
  private apiUrl:    string;
  private silent:    boolean;
  private projectId: string;

  constructor(options: Leap360ClientOptions = {}) {
    this.apiUrl    = options.apiUrl    || CLOUD_API_URL;
    this.silent    = options.silent    ?? true;
    this.projectId = options.projectId || 'default';

    if (options.apiKey) {
      this.apiKey = options.apiKey;
    } else if (process.env['LEAP360_API_KEY']) {
      this.apiKey = process.env['LEAP360_API_KEY'];
    } else {
      const creds = loadCredentials();
      if (!creds) {
        const msg = '[Leap360] Not authenticated. Run `leap360 login` or set LEAP360_API_KEY.';
        if (!this.silent) throw new Error(msg);
        console.warn(msg);
        this.apiKey = '';
      } else {
        this.apiKey = creds.apiKey;
      }
    }
  }

  /**
   * Wrap any async LLM call — automatically records latency, errors, and usage.
   * Returns the original result of `options.fn()` unchanged.
   */
  async traceCall<T>(options: TraceCallOptions<T>): Promise<T> {
    const start = Date.now();
    let result!: T;
    let error: string | null = null;

    try {
      result = await options.fn();
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : String(err);
      await this.sendTrace({
        agentName:   options.agentName,
        serviceName: options.serviceName || 'default',
        runId:       options.runId,
        provider:    options.provider,
        model:       options.model,
        request:     options.metadata ?? {},
        latencyMs:   Date.now() - start,
        error,
      });
      throw err;
    }

    await this.sendTrace({
      agentName:   options.agentName,
      serviceName: options.serviceName || 'default',
      runId:       options.runId,
      provider:    options.provider,
      model:       options.model,
      request:     options.extractRequest?.(result) ?? options.metadata ?? {},
      response:    options.extractResponse?.(result) ?? {},
      latencyMs:   Date.now() - start,
      usage:       options.extractUsage?.(result),
      error:       null,
    });

    return result;
  }

  /** Send a fully-built trace payload to the Leap360 Cloud API */
  async sendTrace(payload: TracePayload): Promise<void> {
    if (!this.apiKey) return;

    const body = buildTraceBody({
      projectId:   this.projectId,
      serviceName: payload.serviceName ?? 'default',
      agentName:   payload.agentName   ?? null,
      runId:       payload.runId,
      provider:    payload.provider,
      model:       payload.model,
      request:     payload.request  ?? {},
      response:    payload.response ?? null,
      latencyMs:   payload.latencyMs ?? 0,
      usage:       payload.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      timestamp:   payload.timestamp ?? new Date().toISOString(),
      error:       payload.error ?? null,
    });

    await postTrace(this.apiUrl, this.apiKey, body, this.silent);
  }
}
