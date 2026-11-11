/**
 * leap360 — Universal AI Governance SDK
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ✅ RECOMMENDED: Manual trace — works with ANY LLM, ANY SDK, ANY language
 * ─────────────────────────────────────────────────────────────────────────
 *
 *   import { Leap360Client } from 'leap360';
 *
 *   const leap = new Leap360Client({
 *     apiKey: process.env.LEAP360_API_KEY,
 *     projectId: 'my-project',
 *   });
 *
 *   // Works with OpenAI, Gemini, Anthropic, Mistral, or any LLM:
 *   const result = await leap.traceCall({
 *     agentName: 'my-agent',
 *     provider: 'google',   // or 'openai', 'anthropic', 'mistral', etc.
 *     model: 'gemini-2.0-flash',
 *     fn: () => model.generateContent('Hello!'),
 *   });
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ⚡ AUTO-WRAP: Zero-code tracing for supported SDKs
 * ─────────────────────────────────────────────────────────────────────────
 *
 * SDK Compatibility Matrix:
 * ┌───────────────────────────────────┬──────────────────────────────┬────────────┐
 * │ Your LLM SDK                      │ Method                       │ Status     │
 * ├───────────────────────────────────┼──────────────────────────────┼────────────┤
 * │ openai                            │ Leap360.autoInit()           │ ✅ Auto    │
 * │ @google/generative-ai             │ Leap360.autoInit()           │ ✅ Auto    │
 * │ @google/genai (new SDK)           │ leap.wrapGoogleGenAI()       │ ✅ Wrap    │
 * │ @anthropic-ai/sdk                 │ leap.wrapAnthropic()         │ ✅ Wrap    │
 * │ @aws-sdk/client-bedrock-runtime   │ leap.wrapBedrock()           │ ✅ Wrap    │
 * │ mistralai                         │ leap.traceCall()             │ ⚠️ Manual  │
 * │ Any other LLM                     │ leap.traceCall()             │ ✅ Manual  │
 * └───────────────────────────────────┴──────────────────────────────┴────────────┘
 *
 * Auto-wrap example (OpenAI or @google/generative-ai):
 *   Leap360.autoInit({ apiKey, projectId, serviceName });
 *   const openai = new OpenAI(); // ← all calls auto-traced
 *
 * Wrap example (@google/genai new SDK):
 *   import { GoogleGenAI } from '@google/genai';
 *   const leap = new Leap360({ apiKey, projectId, serviceName });
 *   const ai = leap.wrapGoogleGenAI(new GoogleGenAI({ apiKey: GEMINI_KEY }));
 *   await ai.models.generateContent({ model: 'gemini-2.0-flash', contents: 'Hello!' });
 */

// Universal imports/fallbacks
import { loadCredentials } from './auth.js';
import { CLOUD_API_URL } from './config.js';
import { Governor, declareTools, type Mode } from './governor.js';
import { classifyAction, extractToolCalls, extractToolDefinitions, redactSecrets, toPlain, type ActionCategory, type ActionPolicy, type RiskLevel, type ToolHints } from './actions.js';
import { argsFingerprint, redactLocally, resolveCapture, shapeOf, summarize, type CaptureLevel } from './privacy.js';

/**
 * Browser-safe AsyncLocalStorage fallback
 */
class BrowserAsyncLocalStorage<T> {
  private store: T | null = null;
  getStore() { return this.store; }
  run(store: T, fn: () => any) {
    this.store = store;
    const result = fn();
    this.store = null;
    return result;
  }
}

// Dynamically load AsyncLocalStorage if in Node, otherwise use fallback
let storage: any = new BrowserAsyncLocalStorage();

// Attempt to load Node.js-specific storage if available
if (typeof process !== 'undefined' && process.versions?.node) {
  import('node:async_hooks').then(m => {
    storage = new m.AsyncLocalStorage();
  }).catch(() => {
    // Fallback already set
  });
}

const getRunContextStorage = () => storage;

// Universal crypto
const _crypto: any = typeof crypto !== 'undefined' ? crypto : (typeof (globalThis as any).window !== 'undefined' ? (globalThis as any).window.crypto : {
  randomUUID: () => `${Date.now()}-${Math.random()}`
});

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
  /** What sendTrace sends: 'metadata' (default), 'redacted' or 'full'. See Leap360Config.capture. */
  capture?: CaptureLevel;
}

// ─── Config for auto-wrap Leap360 class ───────────────────────────────────

export type Leap360Config = {
  apiKey: string;
  projectId: string;
  serviceName: string;
  /** Override the base URL (defaults to the deployed cloud API) */
  baseUrl?: string;
  /**
   * 'shadow' observes and never blocks or slows a call; 'enforce' applies policies.
   * Leave unset to follow the mode set in the Leap360 console.
   */
  mode?: Mode;
  /** In enforce mode, block tool calls at or above this risk when Leap360 is unreachable. Default 'critical'. */
  failClosedAt?: RiskLevel;
  /** How long a tool call held for approval waits for a person to decide. Default 0 (fail at once). */
  approvalWaitMs?: number;
  /** 'local' (default): allowed tool calls are decided in-process from cached policies. 'server': every call asks the API. */
  decisions?: 'local' | 'server';
  /**
   * What leaves your process (issue #50). Also set by LEAP360_CAPTURE.
   *   'metadata' (default): model name, token counts, timings, the tools offered and the tool calls the model asked
   *     for (name, argument keys and types, classified risk). No prompts, replies, argument values or results.
   *     Message rules ("what agents say") need text, so they do not run at this level.
   *   'redacted': prompts, replies and arguments with credentials and personal details masked in your process.
   *   'full': everything, with credentials masked. For debugging.
   */
  capture?: CaptureLevel;
};

// ─── Internal run context (for createAgent) ────────────────────────────────

type RunContext = {
  runId: string;
  agentName: string;
};

// Duplicate declaration removed

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
    run_id:       opts.runId ?? _crypto.randomUUID(),
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

let warnedUnknownKey = false;

/** The safe defaults the console adds at onboarding (src/console/safeDefaults.ts): keep the two lists the same */
export const SAFE_DEFAULT_RULES: { name: string; action: 'block' | 'ask_admin'; severity: string; match: { categories: ActionCategory[] } }[] = [
  { name: 'Block destructive actions', action: 'block', severity: 'critical', match: { categories: ['db.destructive', 'infra.destroy', 'k8s.delete', 'fs.delete'] } },
  { name: 'Hold payments and refunds', action: 'ask_admin', severity: 'high', match: { categories: ['payment'] } },
  { name: 'Hold permission and secret changes', action: 'ask_admin', severity: 'high', match: { categories: ['iam.change', 'secrets.read'] } },
  { name: 'Hold deploys and releases', action: 'ask_admin', severity: 'high', match: { categories: ['deploy', 'release.publish', 'infra.apply'] } },
];

/**
 * The trace at the capture level (issue #50). At 'metadata' no prompt or reply text leaves the process: the request
 * becomes a count of messages and the tools offered, and the reply becomes the tool calls the model asked for, each
 * classified here from its real arguments and sent as keys, types and risk.
 */
export function traceAtCapture(body: Record<string, unknown>, level: CaptureLevel): Record<string, unknown> {
  if (level === 'full') return { ...body, capture: level, request: redactSecrets(body['request']), response: redactSecrets(body['response']) };
  if (level === 'redacted') return { ...body, capture: level, request: redactLocally(body['request']), response: redactLocally(body['response']), error: redactLocally(body['error']) };
  const req = body['request'] as any;
  const tools = extractToolDefinitions(req).map((t) => ({ type: 'function', name: t.name, ...(t.description ? { description: t.description } : {}) }));
  const messages = Array.isArray(req?.messages) ? req.messages.length : Array.isArray(req?.contents) ? req.contents.length : undefined;
  const calls = body['response'] ? extractToolCalls(toPlain(body['response'])) : [];
  return {
    ...body,
    capture: 'metadata',
    request: { captured: 'metadata', ...(messages !== undefined ? { messages } : {}), ...(tools.length ? { tools } : {}) },
    response: calls.length
      ? { captured: 'metadata', tool_calls: calls.slice(0, 50).map((c) => { const a = classifyAction(c); return { name: c.name, args: shapeOf(a.args), classified: summarize(a) }; }) }
      : (body['response'] ? { captured: 'metadata' } : null),
    error: typeof body['error'] === 'string' ? redactLocally(body['error'] as string).slice(0, 300) : body['error'] ?? null,
  };
}

async function postTrace(url: string, apiKey: string, rawBody: Record<string, unknown>, silent: boolean, capture: CaptureLevel = 'metadata') {
  const body = traceAtCapture(rawBody, capture);
  // Each tool call the model asked for gets a salted fingerprint of its real arguments, so an approval lets that
  // exact call run on retry and nothing else
  const metaCalls = capture === 'metadata' ? (body['response'] as any)?.tool_calls : null;
  if (Array.isArray(metaCalls)) {
    const real = extractToolCalls(toPlain(rawBody['response']));
    await Promise.all(metaCalls.map(async (c: any, i: number) => { c.args_key = await argsFingerprint(apiKey, c.name, real[i]?.args ?? {}); }));
  }
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/v1/traces`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify(body),
    });
    
    if (res.status === 403) {
      try {
        const data = await res.json() as any;
        if (data.code === 'GOVERNANCE_HALT' || data.code === 'AGENT_HALT' || data.code === 'POLICY_VIOLATION_BLOCKED') {
          return data; // Signal to halt
        }
      } catch (jsonError) {
        // If we can't parse JSON, just return a generic halt
        console.warn('[Leap360] Could not parse 403 response:', jsonError);
        return { code: 'AGENT_HALT', message: 'Stopped by your team in Leap360. Do not retry.' };
      }
    }

    // The reply carries the project's mode, so callers can follow the console without polling
    if (res.ok) {
      try { return await res.json() as any; } catch { return undefined; }
    }

    // An unknown key is a setup mistake, not a transient error: say so once, even in silent mode
    if (res.status === 401) {
      if (!warnedUnknownKey) {
        warnedUnknownKey = true;
        const data = await res.json().catch(() => ({})) as { error?: string };
        console.warn(`[Leap360] ${data.error || 'The API key was not accepted.'} Traces are not being recorded.`);
      }
      return undefined;
    }

    if (!res.ok && !silent) {
      // Don't try to read body if we already read it for 403
      if (res.status !== 403) {
        try {
          const text = await res.text();
          console.warn(`[Leap360] Trace rejected (${res.status}): ${text}`);
        } catch (readError) {
          console.warn(`[Leap360] Trace rejected (${res.status}) and could not read body`);
        }
      }
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
  private config: Required<Omit<Leap360Config, 'mode' | 'failClosedAt' | 'approvalWaitMs' | 'decisions' | 'capture'>> & Pick<Leap360Config, 'mode' | 'failClosedAt' | 'approvalWaitMs' | 'decisions'>;
  /** What leaves this process: 'metadata' (default), 'redacted' or 'full' (issue #50) */
  readonly capture: CaptureLevel;
  private wrappedOpenAIClient: unknown = null;
  /** Mode last reported by the server */
  private serverMode: Mode | undefined;
  private governors = new Map<string, Governor>();
  private static instance: Leap360 | null = null;
  static isHalted = false; // public for SDK-internal module cross-ref
  private static haltCheckedAt = 0;
  private static haltCheck: Promise<boolean> | null = null;

  /**
   * Re-confirms a kill switch with the server, at most once a second. Without it the flag stayed set until the
   * 15 s poller (autoInit only) noticed a Resume, and forever for apps that never call autoInit.
   */
  static recheckHalt(): Promise<boolean> {
    const inst = Leap360.instance;
    if (!inst || Date.now() - Leap360.haltCheckedAt < 1000) return Promise.resolve(Leap360.isHalted);
    if (!Leap360.haltCheck) {
      Leap360.haltCheck = inst.fetchHalt().finally(() => { Leap360.haltCheck = null; Leap360.haltCheckedAt = Date.now(); });
    }
    return Leap360.haltCheck;
  }

  private async fetchHalt(): Promise<boolean> {
    try {
      const base = this.config.baseUrl.replace(/\/$/, '');
      const opts = { headers: { 'x-api-key': this.config.apiKey }, signal: AbortSignal.timeout(1500) };
      const [p, a] = await Promise.all([
        fetch(`${base}/v1/projects/${this.config.projectId}/status`, opts),
        fetch(`${base}/v1/projects/${this.config.projectId}/agents/${encodeURIComponent(this.config.serviceName)}/status?caller=sdk`, opts),
      ]);
      if (p.ok && a.ok) {
        const [pj, aj] = await Promise.all([p.json() as Promise<any>, a.json() as Promise<any>]);
        const halted = pj?.status === 'SUSPENDED' || aj?.status === 'SUSPENDED';
        if (Leap360.isHalted && !halted) console.log('[Leap360] 🟢 Resumed: AI calls are allowed again.');
        Leap360.isHalted = halted;
      }
    } catch { /* unreachable: keep the last known state */ }
    return Leap360.isHalted;
  }

  constructor(config: Leap360Config) {
    this.config = {
      ...config,
      baseUrl: config.baseUrl || CLOUD_API_URL,
    };
    this.capture = resolveCapture(config.capture);
    Leap360.instance = this;
  }

  /**
   * Initializes Leap360 globally. All subsequent OpenAI or @google/generative-ai
   * clients created will be automatically traced.
   *
   * ⚠️  Compatibility note:
   *   - openai SDK              → ✅ auto-traced
   *   - @google/generative-ai   → ✅ auto-traced
   *   - @google/genai (new SDK) → use leap.wrapGoogleGenAI(client) instead
   *   - @anthropic-ai/sdk       → use leap.traceCall() instead
   *   - Any other LLM           → use leap.traceCall() instead
   */
  static autoInit(config: Leap360Config) {
    const inst = new Leap360(config);
    inst.patchGlobalPrototypes();
    inst.startPollingStatus();
    // Startup confirmation — so developers know tracing is active
    console.log(`[Leap360] ✅ Tracing active — project: ${config.projectId}, service: ${config.serviceName}`);
    return inst;
  }

  /**
   * Polls the Cloud API periodically to check if the project OR this specific
   * agent/service has been suspended by the Kill Switch.
   * This blocks LLM calls BEFORE they happen (pre-flight check).
   */
  private startPollingStatus() {
    const poll = async () => {
      try {
        const base = this.config.baseUrl.replace(/\/$/, '');

        // 1. Check global project kill switch
        const projectUrl = `${base}/v1/projects/${this.config.projectId}/status`;
        const projectRes = await fetch(projectUrl, { headers: { 'x-api-key': this.config.apiKey } });
        if (projectRes.ok) {
          const data = await projectRes.json() as { status: string; mode?: Mode };
          if (data.mode === 'shadow' || data.mode === 'enforce') this.serverMode = data.mode;
          const wasHalted = Leap360.isHalted;
          Leap360.isHalted = data.status === 'SUSPENDED';
          if (Leap360.isHalted && !wasHalted) {
            console.error('[Leap360] 🛡️  CRITICAL: PROJECT SUSPENDED. All AI calls are blocked.');
          } else if (!Leap360.isHalted && wasHalted) {
            console.log('[Leap360] 🟢 Project resumed. Agents are back online.');
          }
        }

        // 2. Check per-agent / per-service kill switch
        // The agent name is serviceName (set by autoInit) or a custom agentName
        const agentId = encodeURIComponent(this.config.serviceName);
        const agentUrl = `${base}/v1/projects/${this.config.projectId}/agents/${agentId}/status`;
        const agentRes = await fetch(agentUrl, { headers: { 'x-api-key': this.config.apiKey } });
        if (agentRes.ok) {
          const agentData = await agentRes.json() as { status: string };
          const wasHalted = Leap360.isHalted;
          const agentSuspended = agentData.status === 'SUSPENDED';
          if (agentSuspended && !wasHalted) {
            Leap360.isHalted = true;
            console.error(`[Leap360] 🛡️  AGENT SUSPENDED: "${this.config.serviceName}" has been halted. AI calls are blocked.`);
          } else if (!agentSuspended && wasHalted && agentData.status === 'ACTIVE') {
            // Only resume if the project is also not suspended
            Leap360.isHalted = false;
            console.log(`[Leap360] 🟢 Agent "${this.config.serviceName}" resumed.`);
          }
        }
      } catch (err: any) {
        console.warn(`[Leap360] Status poller error: ${err.message}`);
      }
    };

    poll(); // immediate first check
    setInterval(poll, 15_000); // Check every 15 seconds (was 30s)
  }


  /**
   * Patches common AI library prototypes to ensure all instances 
   * are automatically traced without manual wrapping.
   * Supports both CommonJS (require) and ESM environments.
   *
   * Supported by autoInit:
   *   ✅ openai
   *   ✅ @google/generative-ai
   *   ❌ @google/genai (new SDK) — use wrapGoogleGenAI() instead
   *   ❌ @anthropic-ai/sdk — use traceCall() instead
   */
  private patchGlobalPrototypes() {
    let patchedCount = 0;

    // --- Strategy 1: Direct prototype patch if class is on globalThis ---
    const tryPatchFromGlobal = () => {
      const OpenAI = (globalThis as any).OpenAI;
      if (OpenAI?.prototype) { this.wrapOpenAIPrototype(OpenAI); patchedCount++; }

      const GAI = (globalThis as any).GoogleGenerativeAI;
      if (GAI?.prototype) { this.wrapGooglePrototype(GAI); patchedCount++; }
    };
    tryPatchFromGlobal();

    // --- Strategy 2: Dynamic import (ESM) — patch after module loads ---
    // Wrap @google/generative-ai via dynamic import
    import('@google/generative-ai').then((mod: any) => {
      const GAI = mod.GoogleGenerativeAI;
      if (GAI?.prototype) { this.wrapGooglePrototype(GAI); patchedCount++; }
    }).catch(() => { /* package not installed */ });

    // Wrap openai via dynamic import (optional peer dep - ignore TS errors)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    (async () => {
      try {
        // Use Function to avoid TypeScript resolving the module at compile time
        const mod = await (new Function("s", "return import(s)"))('openai');
        const OpenAI = mod.default || mod.OpenAI;
        if (OpenAI?.prototype) { this.wrapOpenAIPrototype(OpenAI); patchedCount++; }
      } catch { /* openai not installed */ }
    })();

    // Also auto-patch Anthropic if available
    (async () => {
      try {
        const mod = await (new Function('s', 'return import(s)'))('@anthropic-ai/sdk');
        const Anthropic = mod.default || mod.Anthropic;
        if (Anthropic?.prototype?.messages) {
          this.wrapAnthropicPrototype(Anthropic);
          patchedCount++;
        }
      } catch { /* anthropic not installed */ }
    })();

    // Warn after a short delay if nothing was patched — helps catch silent failures
    setTimeout(() => {
      if (patchedCount === 0) {
        console.warn(
          '\n[Leap360] ⚠️  autoInit() did not find a supported LLM SDK to auto-wrap.\n' +
          '\n' +
          '  autoInit() auto-traces: openai, @google/generative-ai, @anthropic-ai/sdk\n' +
          '\n' +
          '  If you are using a different SDK, choose the matching method:\n' +
          '\n' +
          '  ┌─────────────────────────────────────────┬──────────────────────────────────────┐\n' +
          '  │ Your SDK                                │ Use this instead                     │\n' +
          '  ├─────────────────────────────────────────┼──────────────────────────────────────┤\n' +
          '  │ @google/genai (new SDK, v1+)            │ leap.wrapGoogleGenAI(client)          │\n' +
          '  │ @aws-sdk/client-bedrock-runtime         │ leap.wrapBedrock(client)              │\n' +
          '  │ @anthropic-ai/sdk                       │ leap.wrapAnthropic(client)            │\n' +
          '  │ Mistral, Groq, Cohere, or any other LLM │ leap.traceCall({ fn, provider, model })│\n' +
          '  └─────────────────────────────────────────┴──────────────────────────────────────┘\n' +
          '\n' +
          '  ✅ traceCall() works with EVERY LLM — it is always the safe fallback.\n' +
          '\n' +
          '  Example (Gemini new SDK):\n' +
          '    import { Leap360Client } from \'leap360\';\n' +
          '    import { GoogleGenAI } from \'@google/genai\';\n' +
          '    const leap = new Leap360Client({ apiKey, projectId });\n' +
          '    const ai = new GoogleGenAI({ apiKey: GEMINI_KEY });\n' +
          '    const result = await leap.traceCall({\n' +
          '      provider: \'google\', model: \'gemini-2.0-flash\',\n' +
          '      fn: () => ai.models.generateContent({ model: \'gemini-2.0-flash\', contents: \'Hello!\' }),\n' +
          '    });\n' +
          '\n' +
          '  Docs: https://www.npmjs.com/package/leap360\n'
        );
      } else {
        console.log(
          `[Leap360] ✅ Tracing active — project: ${(this as any).config?.projectId ?? 'unknown'}, service: ${(this as any).config?.serviceName ?? 'unknown'} (${patchedCount} SDK(s) wrapped)`
        );
      }
    }, 3000);
  }

  private wrapOpenAIPrototype(OpenAIClass: any) {
    const self = this;
    const originalCreate = OpenAIClass.Chat?.Completions?.prototype?.create;
    if (originalCreate && !originalCreate.__leapWrapped) {
      OpenAIClass.Chat.Completions.prototype.create = async function(body: any, options: any) {
        return self.traceOpenAICall(this, originalCreate.bind(this), body, options);
      };
      OpenAIClass.Chat.Completions.prototype.create.__leapWrapped = true;
    }
  }

  private wrapAnthropicPrototype(AnthropicClass: any) {
    const self = this;
    // Anthropic SDK: instance.messages.create — patched on the prototype
    const MessagesClass = AnthropicClass?.Messages;
    if (!MessagesClass?.prototype?.create) return;
    const originalCreate = MessagesClass.prototype.create;
    if (originalCreate?.__leapWrapped) return;

    MessagesClass.prototype.create = async function(params: any, options: any) {
      if (Leap360.isHalted && await Leap360.recheckHalt()) {
        throw new Error('[Leap360] 🛡️  GOVERNANCE_HALT: Project is SUSPENDED. AI calls are blocked.');
      }
      const startTime = Date.now();
      const runCtx = getRunContextStorage().getStore();
      let response: any = null;
      let error: any = null;

      try {
        response = await originalCreate.call(this, params, options);
      } catch (err) {
        error = err;
        throw err;
      }

      // Anthropic: input_tokens / output_tokens
      const usageRaw = response?.usage ?? {};
      const inp = (usageRaw.input_tokens ?? 0) as number;
      const out = (usageRaw.output_tokens ?? 0) as number;
      const usage = { prompt_tokens: inp, completion_tokens: out, total_tokens: inp + out };
      const model = (response?.model ?? params?.model ?? 'claude') as string;

      const traceBody = buildTraceBody({
        projectId:   self.config.projectId,
        serviceName: self.config.serviceName,
        agentName:   runCtx?.agentName ?? self.config.serviceName,
        runId:       runCtx?.runId,
        provider:    'anthropic',
        model,
        request:     { messages: params?.messages, system: params?.system },
        response,
        latencyMs:   Date.now() - startTime,
        usage,
        timestamp:   new Date(startTime).toISOString(),
        error:       error ? (error instanceof Error ? error.message : String(error)) : null,
      });

      postTrace(self.config.baseUrl, self.config.apiKey, traceBody, false, self.capture)
        .then(res => {
          if (res && (res as any).code === 'GOVERNANCE_HALT') {
            Leap360.isHalted = true;
            console.error('[Leap360] ❗ CRITICAL: PROJECT SUSPENDED.');
          }
        })
        .catch(() => {});

      return response;
    };
    MessagesClass.prototype.create.__leapWrapped = true;
  }

  private wrapGooglePrototype(GAIClass: any) {
    const self = this;
    const originalGetModel = GAIClass.prototype.getGenerativeModel;
    if (originalGetModel && !originalGetModel.__leapWrapped) {
      GAIClass.prototype.getGenerativeModel = function(opts: any, ...args: any[]) {
        const model = originalGetModel.apply(this, [opts, ...args]);
        return self.wrapGeminiModel(model, opts?.model || 'gemini');
      };
      GAIClass.prototype.getGenerativeModel.__leapWrapped = true;
    }
  }

  private async traceOpenAICall(client: any, originalCreate: Function, body: any, options: any) {
    if (Leap360.isHalted && await Leap360.recheckHalt()) {
      throw new Error('[Leap360] GOVERNANCE_HALT: AI interactions are suspended for this project.');
    }

    const startTime = Date.now();
    const runCtx    = getRunContextStorage().getStore();
    let response: any = null;
    let error: any = null;

    // For streams, perform pre-flight check before calling the model
    if (body?.stream) {
      try {
        const blockResult = await this.sendTraceAndCheckBlock('openai', body, null, null, startTime, runCtx);
        if (blockResult?.blocked) {
          throw new Error(`[Leap360] 🛡️ PRE_FLIGHT_BLOCKED: ${blockResult.message}`);
        }
      } catch (err: any) {
        if (err.message?.includes('PRE_FLIGHT_BLOCKED')) throw err;
        console.warn('[Leap360] Pre-flight check failed:', err.message);
      }

      try {
        response = await originalCreate(body, options);
      } catch (err) {
        error = err;
        throw err;
      }
      this.sendAutoTrace('openai', body, response, error, startTime, runCtx);
      return response;
    }

    try {
      response = await originalCreate(body, options);
    } catch (err) {
      error = err;
      throw err;
    }

    // Synchronous trace with policy blocking check
    try {
      const blockResult = await this.sendTraceAndCheckBlock('openai', body, response, error, startTime, runCtx);
      if (blockResult?.blocked) {
        throw new Error(`[Leap360] 🛡️ POLICY_BLOCKED: ${blockResult.message}`);
      }
    } catch (traceErr: any) {
      if (!traceErr.message?.includes('POLICY_BLOCKED')) {
        console.warn('[Leap360] Trace failed:', traceErr.message);
      } else {
        throw traceErr;
      }
    }
    
    return response;
  }

  private wrapGeminiModel(model: any, modelName: string) {
    const self = this;
    const origGen = model.generateContent.bind(model);
    // Also wrap generateContentStream
    if (typeof model.generateContentStream === 'function') {
      const origStream = model.generateContentStream.bind(model);
      model.generateContentStream = async (...args: any[]) => {
        if (Leap360.isHalted && await Leap360.recheckHalt()) {
          throw new Error('[Leap360] 🛡️ GOVERNANCE_HALT: Project is SUSPENDED. AI calls are blocked.');
        }
        const startTime = Date.now();
        const runCtx = getRunContextStorage().getStore();
        
        // Pre-flight check for streams
        try {
          const blockResult = await self.sendTraceAndCheckBlock('google', { prompt: args[0] }, null, null, startTime, runCtx, modelName);
          if (blockResult?.blocked) {
            throw new Error(`[Leap360] 🛡️ PRE_FLIGHT_BLOCKED: ${blockResult.message}`);
          }
        } catch (err: any) {
          if (err.message?.includes('PRE_FLIGHT_BLOCKED')) throw err;
          console.warn('[Leap360] Pre-flight check failed:', err.message);
        }

        let res: any = null; let err: any = null;
        try { res = await origStream(...args); } catch (e) { err = e; throw e; }
        finally { self.sendAutoTrace('google', { prompt: args[0] }, res, err, startTime, runCtx, modelName); }
        return res;
      };
    }

    model.generateContent = async (...args: any[]) => {
      if (Leap360.isHalted && await Leap360.recheckHalt()) {
        throw new Error('[Leap360] 🛡️ GOVERNANCE_HALT: Project is SUSPENDED. AI calls are blocked.');
      }
      const startTime = Date.now();
      const runCtx = getRunContextStorage().getStore();
      let res: any = null;
      let err: any = null;
      try {
        res = await origGen(...args);
      } catch (e) {
        err = e;
        throw e;
      }
      
      // Synchronous trace with policy blocking check
      try {
        const blockResult = await self.sendTraceAndCheckBlock('google', { prompt: args[0] }, res, null, startTime, runCtx, modelName);
        if (blockResult?.blocked) {
          throw new Error(`[Leap360] 🛡️ POLICY_BLOCKED: ${blockResult.message}`);
        }
      } catch (traceErr: any) {
        // If trace failed but not a policy block, just log and continue
        if (!traceErr.message?.includes('POLICY_BLOCKED')) {
          console.warn('[Leap360] Trace failed:', traceErr.message);
        } else {
          throw traceErr; // Re-throw policy block
        }
      }
      
      return res;
    };
    return model;
  }

  private sendAutoTrace(provider: string, request: any, response: any, error: any, startTime: number, runCtx: any, modelName?: string) {
    const latencyMs = Date.now() - startTime;
    const model = modelName || response?.model || request?.model || 'unknown';
    
    // Extract usage if possible
    let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    if (provider === 'openai' && response?.usage) {
      usage = response.usage;
    } else if (provider === 'google' && response?.response?.usageMetadata) {
      const um = response.response.usageMetadata;
      usage = { 
        prompt_tokens: um.promptTokenCount || 0, 
        completion_tokens: um.candidatesTokenCount || 0, 
        total_tokens: um.totalTokenCount || 0 
      };
    }

    const traceBody = buildTraceBody({
      projectId:   this.config.projectId,
      serviceName: this.config.serviceName,
      // Use explicit agentName from createAgent context, or fall back to serviceName
      // so per-agent suspend works for autoInit users who never call createAgent
      agentName:   runCtx?.agentName ?? this.config.serviceName,
      runId:       runCtx?.runId,
      provider,
      model,
      request,
      response,
      latencyMs,
      usage,
      timestamp:   new Date(startTime).toISOString(),
      error:       error ? (error instanceof Error ? error.message : String(error)) : null,
    });

    postTrace(this.config.baseUrl, this.config.apiKey, traceBody, false, this.capture)
      .then(res => {
        if (res && (res as any).code === 'GOVERNANCE_HALT') {
          Leap360.isHalted = true;
          console.error('[Leap360] ! CRITICAL: PROJECT SUSPENDED. KILL SWITCH ENGAGED.');
        }
      })
      .catch(e => {});
  }

  /**
   * Synchronous trace with policy blocking check.
   * Returns block info if the response violates policies.
   */
  private async sendTraceAndCheckBlock(
    provider: string, 
    request: any, 
    response: any, 
    error: any, 
    startTime: number, 
    runCtx: any, 
    modelName?: string,
    usageOverride?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
  ): Promise<{ blocked: boolean; message?: string; violation?: any } | null> {
    const latencyMs = Date.now() - startTime;
    const model = modelName || response?.model || request?.model || 'unknown';
    
    let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    if (usageOverride) {
      usage = usageOverride;
    } else if (provider === 'openai' && response?.usage) {
      usage = response.usage;
    } else if (provider === 'google' && response?.response?.usageMetadata) {
      const um = response.response.usageMetadata;
      usage = { 
        prompt_tokens: um.promptTokenCount || 0, 
        completion_tokens: um.candidatesTokenCount || 0, 
        total_tokens: um.totalTokenCount || 0 
      };
    }

    const traceBody = buildTraceBody({
      projectId:   this.config.projectId,
      serviceName: this.config.serviceName,
      // Use explicit agentName from createAgent context, or fall back to serviceName
      agentName:   runCtx?.agentName ?? this.config.serviceName,
      runId:       runCtx?.runId,
      provider,
      model,
      request,
      response,
      latencyMs,
      usage,
      timestamp:   new Date(startTime).toISOString(),
      error:       error ? (error instanceof Error ? error.message : String(error)) : null,
    });

    // Shadow mode: report in the background and never block or slow the call. The kill switch still
    // applies: a halt in the reply stops the next call, and the status poller catches it within 15 s.
    if (this.isShadow()) {
      postTrace(this.config.baseUrl, this.config.apiKey, traceBody, false, this.capture)
        .then((res: any) => {
          this.learnMode(res);
          if (res?.code === 'GOVERNANCE_HALT' || res?.code === 'AGENT_HALT') {
            Leap360.isHalted = true;
            console.error(`[Leap360] 🛡️ ${res.code}: ${res.message ?? 'Stopped by your team in Leap360. Do not retry.'}`);
          }
        })
        .catch(() => {});
      return { blocked: false };
    }

    try {
      const res = await postTrace(this.config.baseUrl, this.config.apiKey, traceBody, false, this.capture);
      this.learnMode(res);
      
      // Check for kill switch
      if (res && (res as any).code === 'GOVERNANCE_HALT') {
        Leap360.isHalted = true;
        console.error('[Leap360] ! CRITICAL: PROJECT SUSPENDED. KILL SWITCH ENGAGED.');
        return { blocked: true, message: 'Stopped by your team in Leap360 (Stop all is on). Do not retry.' };
      }
      
      // Check for policy violation block
      if (res && (res as any).code === 'POLICY_VIOLATION_BLOCKED') {
        const violation = (res as any).violation;
        const serverMessage = (res as any).message || `Blocked by policy "${violation.policyName}": ${violation.reasoning}`;
        console.error(`[Leap360] 🛡️ POLICY BLOCKED: ${violation.policyName} - ${violation.reasoning}`);
        return { 
          blocked: true, 
          message: serverMessage,
          violation
        };
      }
      
      // Check for per-agent halt
      if (res && (res as any).code === 'AGENT_HALT') {
        const serverMessage = (res as any).message || 'Stopped by your team in Leap360. Do not retry.';
        console.error(`[Leap360] 🛡️ AGENT SUSPENDED: ${serverMessage}`);
        return { blocked: true, message: serverMessage };
      }
      
      return { blocked: false };
    } catch (e: any) {
      // Network or other errors - don't block on trace failures
      console.warn('[Leap360] Trace check failed:', e.message);
      return { blocked: false };
    }
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
      if (Leap360.isHalted && await Leap360.recheckHalt()) {
        throw new Error('[Leap360] 🛡️  GOVERNANCE_HALT: Project is SUSPENDED. AI calls are blocked.');
      }
      const startTime = Date.now();
      const runCtx    = getRunContextStorage().getStore();

      let response: Record<string, unknown> | null = null;
      let error: unknown = null;

      // Handle streaming separately with pre-flight check
      if (body?.stream) {
        try {
          const blockResult = await self.sendTraceAndCheckBlock('openai', body, null, null, startTime, runCtx, (body?.model as string) || 'unknown');
          if (blockResult?.blocked) {
            throw new Error(`[Leap360] 🛡️ PRE_FLIGHT_BLOCKED: ${blockResult.message}`);
          }
        } catch (err: any) {
          if (err.message?.includes('PRE_FLIGHT_BLOCKED')) throw err;
          console.warn('[Leap360] Pre-flight check failed:', err.message);
        }
        
        try {
          response = await (originalCreate as (b: unknown, o: unknown) => Promise<Record<string, unknown>>)(body, options);
        } catch (err) {
          error = err;
          throw err;
        }
        self.sendAutoTrace('openai', body, response, error, startTime, runCtx);
        return response;
      }

      try {
        response = await (originalCreate as (b: unknown, o: unknown) => Promise<Record<string, unknown>>)(body, options);
      } catch (err) {
        error = err;
        throw err;
      }
      
      // Synchronous trace with policy blocking check
      try {
        const latencyMs = Date.now() - startTime;
        const model = (response?.model ?? body?.model ?? 'unknown') as string;
        const usage = response?.usage as { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;

        const blockResult = await self.sendTraceAndCheckBlock(
          'openai',
          typeof body === 'object' ? body : { content: body },
          response,
          null,
          startTime,
          runCtx,
          model
        );
        
        if (blockResult?.blocked) {
          throw new Error(`[Leap360] 🛡️ POLICY_BLOCKED: ${blockResult.message}`);
        }
      } catch (traceErr: any) {
        if (traceErr.message?.includes('POLICY_BLOCKED')) {
          throw traceErr;
        }
        console.warn('[Leap360] Trace failed:', traceErr.message);
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
        if (Leap360.isHalted && await Leap360.recheckHalt()) {
          throw new Error('[Leap360] 🛡️  GOVERNANCE_HALT: Project is SUSPENDED. AI calls are blocked.');
        }
        const startTime = Date.now();
        const runCtx    = getRunContextStorage().getStore();
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
          postTrace(self.config.baseUrl, self.config.apiKey, traceBody, false, self.capture)
            .catch(e => console.error('[Leap360]', e));
        }
        return response!;
      };

      // Wrap generateContentStream (fire-and-forget trace after stream ends)
      const origStream = model.generateContentStream.bind(model);
      model.generateContentStream = async (...callArgs: unknown[]) => {
        if (Leap360.isHalted && await Leap360.recheckHalt()) {
          throw new Error('[Leap360] 🛡️  GOVERNANCE_HALT: Project is SUSPENDED. AI calls are blocked.');
        }
        const startTime = Date.now();
        const runCtx    = getRunContextStorage().getStore();
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
          postTrace(self.config.baseUrl, self.config.apiKey, traceBody, false, self.capture)
            .catch(e => console.error('[Leap360]', e));
        }
        return result!;
      };

      return model;
    };

    return client;
  }

  // ── Google GenAI (new SDK: @google/genai) auto-wrap ──────────────────────

  /**
   * Wraps the new `@google/genai` GoogleGenAI client so every
   * `models.generateContent` / `models.generateContentStream` call is traced.
   *
   * Use this when you are on the NEW @google/genai package (not @google/generative-ai).
   *
   * @example
   * import { GoogleGenAI } from '@google/genai';
   * const leap = new Leap360({ apiKey, projectId, serviceName });
   * const ai = leap.wrapGoogleGenAI(new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }));
   *
   * const response = await ai.models.generateContent({
   *   model: 'gemini-2.0-flash',
   *   contents: 'Explain AI governance.',
   * });
   *
   * ⚠️  The new SDK uses camelCase (generateContent), not snake_case (generate_content).
   *     Both variants are supported by this wrapper.
   */
  wrapGoogleGenAI<GenAIClient>(client: GenAIClient): GenAIClient {
    const self = this;
    const c = client as Record<string, unknown> & {
      models: Record<string, unknown>;
    };

    if (!c.models || typeof c.models !== 'object') {
      console.warn('[Leap360] wrapGoogleGenAI: client.models is undefined. Ensure you are passing a GoogleGenAI instance.');
      return client;
    }

    // Support both camelCase (new @google/genai) and snake_case (older variants)
    const generateFnName: string | null =
      typeof (c.models as any).generateContent === 'function' ? 'generateContent' :
      typeof (c.models as any).generate_content === 'function' ? 'generate_content' :
      null;

    const streamFnName: string | null =
      typeof (c.models as any).generateContentStream === 'function' ? 'generateContentStream' :
      typeof (c.models as any).generate_content_stream === 'function' ? 'generate_content_stream' :
      null;

    if (!generateFnName) {
      console.warn(
        '[Leap360] wrapGoogleGenAI: could not find generateContent or generate_content on client.models.\n' +
        '          Ensure you are passing a GoogleGenAI instance from @google/genai.\n' +
        '          Falling back to untraced client.'
      );
      return client;
    }

    // Wrap generateContent / generate_content
    const originalGenerate = (c.models as any)[generateFnName].bind(c.models);
    (c.models as any)[generateFnName] = async (params: Record<string, unknown>) => {
      if (Leap360.isHalted && await Leap360.recheckHalt()) {
        throw new Error('[Leap360] 🛡️  GOVERNANCE_HALT: Project is SUSPENDED. AI calls are blocked.');
      }
      const startTime = Date.now();
      const runCtx = getRunContextStorage().getStore();
      const modelName = (params?.model ?? 'gemini') as string;

      let response: Record<string, unknown> | null = null;
      let error: unknown = null;

      try {
        response = await originalGenerate(params);
      } catch (err) {
        error = err;
        throw err;
      }

      // Synchronous trace with policy blocking check
      try {
        const blockResult = await self.sendTraceAndCheckBlock(
          'google',
          { contents: params.contents ?? params.prompt ?? params },
          response,
          error,
          startTime,
          runCtx,
          modelName
        );
        if (blockResult?.blocked) {
          throw new Error(`[Leap360] 🛡️ POLICY_BLOCKED: ${blockResult.message}`);
        }
      } catch (traceErr: any) {
        if (traceErr.message?.includes('POLICY_BLOCKED')) throw traceErr;
        console.warn('[Leap360] Trace failed:', traceErr.message);
      }

      return response;
    };

    // Wrap generateContentStream / generate_content_stream if present
    if (streamFnName) {
      const originalStream = (c.models as any)[streamFnName].bind(c.models);
      (c.models as any)[streamFnName] = async (params: Record<string, unknown>) => {
        if (Leap360.isHalted && await Leap360.recheckHalt()) {
          throw new Error('[Leap360] 🛡️  GOVERNANCE_HALT: Project is SUSPENDED. AI calls are blocked.');
        }
        const startTime = Date.now();
        const runCtx = getRunContextStorage().getStore();
        const modelName = (params?.model ?? 'gemini') as string;
        let error: unknown = null;
        let result: Record<string, unknown> | null = null;
        try {
          result = await originalStream(params);
        } catch (err) {
          error = err;
          throw err;
        } finally {
          const latencyMs = Date.now() - startTime;
          const traceBody = buildTraceBody({
            projectId: self.config.projectId,
            serviceName: self.config.serviceName,
            agentName: runCtx?.agentName ?? self.config.serviceName,
            runId: runCtx?.runId,
            provider: 'google',
            model: modelName,
            request: { contents: params.contents ?? params.prompt ?? params },
            response: null,
            latencyMs,
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            timestamp: new Date(startTime).toISOString(),
            error: error ? (error instanceof Error ? error.message : String(error)) : null,
          });
          postTrace(self.config.baseUrl, self.config.apiKey, traceBody, false, self.capture)
            .catch(e => console.error('[Leap360]', e));
        }
        return result!;
      };
    }

    return client;
  }

  // ── Anthropic auto-wrap ─────────────────────────────────────────────────

  /**
   * Wraps an `@anthropic-ai/sdk` Anthropic client so every
   * `messages.create` call is automatically traced.
   *
   * ⚠️  Anthropic uses `input_tokens` / `output_tokens` (not `prompt_tokens` / `completion_tokens`).
   *     This wrapper handles the mapping automatically.
   *
   * @example
   * import Anthropic from '@anthropic-ai/sdk';
   * const leap = new Leap360({ apiKey, projectId, serviceName });
   * const anthropic = leap.wrapAnthropic(new Anthropic());
   * const msg = await anthropic.messages.create({
   *   model: 'claude-3-5-sonnet-20241022',
   *   max_tokens: 1024,
   *   messages: [{ role: 'user', content: 'Hello!' }],
   * });
   */
  wrapAnthropic<AnthropicClient>(client: AnthropicClient): AnthropicClient {
    const self = this;
    const c = client as Record<string, unknown> & {
      messages: { create: (...args: unknown[]) => Promise<Record<string, unknown>> };
    };

    if (!c.messages || typeof (c.messages as any).create !== 'function') {
      console.warn('[Leap360] wrapAnthropic: client.messages.create not found. Ensure you pass an Anthropic instance.');
      return client;
    }

    const originalCreate = (c.messages as any).create.bind(c.messages);
    (c.messages as any).create = async (params: Record<string, unknown>, options?: unknown) => {
      if (Leap360.isHalted && await Leap360.recheckHalt()) {
        throw new Error('[Leap360] 🛡️  GOVERNANCE_HALT: Project is SUSPENDED. AI calls are blocked.');
      }
      const startTime = Date.now();
      const runCtx = getRunContextStorage().getStore();
      let response: Record<string, unknown> | null = null;
      let error: unknown = null;

      try {
        response = await originalCreate(params, options);
      } catch (err) {
        error = err;
        throw err;
      }

      // Anthropic uses input_tokens / output_tokens — map to Leap360's prompt_tokens / completion_tokens
      const usageRaw = (response as any)?.usage ?? {};
      const inputTokens  = (usageRaw.input_tokens  ?? 0) as number;
      const outputTokens = (usageRaw.output_tokens ?? 0) as number;
      const usage = {
        prompt_tokens:     inputTokens,
        completion_tokens: outputTokens,
        total_tokens:      inputTokens + outputTokens,
      };

      const model = ((response as any)?.model ?? params?.model ?? 'claude') as string;

      try {
        // One trace per call, with Anthropic's token fields mapped
        const blockResult = await self.sendTraceAndCheckBlock(
          'anthropic',
          { messages: params.messages, system: params.system, tools: params.tools },
          response,
          error,
          startTime,
          runCtx,
          model,
          usage
        );

        if (blockResult?.blocked) {
          throw new Error(`[Leap360] 🛡️ POLICY_BLOCKED: ${blockResult.message}`);
        }
      } catch (traceErr: any) {
        if (traceErr.message?.includes('POLICY_BLOCKED')) throw traceErr;
        console.warn('[Leap360] Trace failed:', traceErr.message);
      }

      return response!;
    };

    return client;
  }

  // ── AWS Bedrock auto-wrap ───────────────────────────────────────────────

  /**
   * Wraps an AWS SDK v3 `BedrockRuntimeClient` so every `converse` and
   * `invokeModel` command is automatically traced.
   *
   * Works with any Bedrock-hosted model:
   *   anthropic.claude-*, amazon.titan-*, meta.llama*, mistral.*, cohere.*
   *
   * @example
   * import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
   * const leap = new Leap360({ apiKey, projectId, serviceName });
   * const bedrock = leap.wrapBedrock(new BedrockRuntimeClient({ region: 'us-east-1' }));
   * const res = await bedrock.send(new ConverseCommand({
   *   modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
   *   messages: [{ role: 'user', content: [{ text: 'Hello!' }] }],
   * }));
   */
  wrapBedrock<BedrockClient>(client: BedrockClient): BedrockClient {
    const self = this;
    const c = client as Record<string, unknown> & {
      send: (command: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };

    if (typeof c.send !== 'function') {
      console.warn('[Leap360] wrapBedrock: client.send not found. Ensure you pass a BedrockRuntimeClient.');
      return client;
    }

    const originalSend = c.send.bind(c);
    c.send = async (command: Record<string, unknown>) => {
      if (Leap360.isHalted && await Leap360.recheckHalt()) {
        throw new Error('[Leap360] 🛡️  GOVERNANCE_HALT: Project is SUSPENDED. AI calls are blocked.');
      }
      const startTime = Date.now();
      const runCtx = getRunContextStorage().getStore();
      let response: Record<string, unknown> | null = null;
      let error: unknown = null;

      try {
        response = await originalSend(command);
      } catch (err) {
        error = err;
        throw err;
      }

      // Extract model ID from the command input (AWS SDK v3 pattern)
      const cmdInput = (command as any).input ?? command;
      const modelId = (cmdInput.modelId ?? cmdInput.ModelId ?? 'unknown-bedrock-model') as string;
      const commandName = (command as any).constructor?.name ?? '';

      // Extract usage — Bedrock Converse API
      let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      if (response) {
        const u = (response as any).usage ?? {};
        const inp = (u.inputTokens ?? 0) as number;
        const out = (u.outputTokens ?? 0) as number;
        if (inp || out) {
          usage = { prompt_tokens: inp, completion_tokens: out, total_tokens: inp + out };
        }
        // Anthropic on Bedrock via invokeModel — response body is a Buffer/string
        const body = (response as any).body;
        if (body && !inp && !out) {
          try {
            const parsed = JSON.parse(
              typeof body === 'string' ? body : Buffer.from(body).toString('utf8')
            );
            const u2 = parsed.usage ?? {};
            const inp2 = (u2.input_tokens ?? 0) as number;
            const out2 = (u2.output_tokens ?? 0) as number;
            if (inp2 || out2) {
              usage = { prompt_tokens: inp2, completion_tokens: out2, total_tokens: inp2 + out2 };
            }
          } catch { /* ignore */ }
        }
      }

      // Waits for the policy check in enforce mode so a blocked tool call never reaches the app;
      // in shadow mode this returns at once.
      try {
        const blockResult = await self.sendTraceAndCheckBlock(
          'bedrock',
          { messages: cmdInput.messages ?? cmdInput.body ?? {}, command: commandName, toolConfig: cmdInput.toolConfig },
          response,
          error,
          startTime,
          runCtx,
          modelId,
          usage
        );
        if (blockResult?.blocked) {
          throw new Error(`[Leap360] 🛡️ POLICY_BLOCKED: ${blockResult.message}`);
        }
      } catch (traceErr: any) {
        if (traceErr.message?.includes('POLICY_BLOCKED')) throw traceErr;
        console.warn('[Leap360] Trace failed:', traceErr.message);
      }

      return response!;
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
        const runId = _crypto.randomUUID() as string;
        return getRunContextStorage().run({ runId, agentName: opts.name }, async () => {
          return fn(this.wrappedOpenAIClient);
        });
      },
    };
  }

  // ── Shadow mode and tool governance ─────────────────────────────────────

  private learnMode(res: any) {
    if (res?.mode === 'shadow' || res?.mode === 'enforce') this.serverMode = res.mode;
  }

  /** True when calls are observed but never blocked or slowed */
  isShadow(): boolean {
    if (this.config.mode) return this.config.mode === 'shadow';
    return this.serverMode === 'shadow';
  }

  private governorFor(agentName: string): Governor {
    let g = this.governors.get(agentName);
    if (!g) {
      g = new Governor({
        apiKey: this.config.apiKey,
        baseUrl: this.config.baseUrl,
        agentName,
        mode: this.config.mode,
        failClosedAt: this.config.failClosedAt,
        approvalWaitMs: this.config.approvalWaitMs,
        decisions: this.config.decisions,
        capture: this.capture,
        log: (m) => console.warn(m),
      });
      this.governors.set(agentName, g);
    }
    return g;
  }

  /**
   * Puts a function your agent can call (a "tool") behind Leap360. Every call is classified
   * (shell, Kubernetes delete, payment, …), checked for secrets and production targets, and recorded
   * with its outcome.
   *
   * - Shadow mode: the tool always runs; Leap360 records what would have happened.
   * - Enforce mode: a call the policies block throws Leap360ActionBlockedError and never runs.
   *
   * @example
   * const deleteNamespace = leap.wrapTool('delete_namespace', async ({ name }) => k8s.deleteNamespace(name));
   * // hand deleteNamespace to your agent framework instead of the raw function
   */
  wrapTool<A extends unknown[], R>(
    name: string,
    fn: (...args: A) => R | Promise<R>,
    opts: { agentName?: string; argNames?: string[]; hints?: ToolHints } = {},
  ): (...args: A) => Promise<Awaited<R>> {
    if (typeof name !== 'string' || !name.trim() || name.length > 200) {
      throw new TypeError(`[Leap360] wrapTool: the tool name must be 1 to 200 characters (got ${typeof name === 'string' ? `${name.length} characters` : typeof name})`);
    }
    if (typeof fn !== 'function') throw new TypeError(`[Leap360] wrapTool("${name}"): the second argument must be the function to run`);
    const self = this;
    // Wrapping a tool is the agent declaring it can call it: recorded for the capability map, used or not
    try { declareTools({ apiKey: this.config.apiKey, baseUrl: this.config.baseUrl, agentName: opts.agentName ?? this.config.serviceName }, [{ name, hints: opts.hints }], 'sdk'); } catch { /* never break wrapping */ }
    const wrapped = async function (this: unknown, ...args: A): Promise<Awaited<R>> {
      if (Leap360.isHalted && await Leap360.recheckHalt()) {
        throw new Error(`[Leap360] 🛡️ GOVERNANCE_HALT: Stopped by your team in Leap360 (Stop all is on). "${name}" did not run. Do not retry.`);
      }
      const agentName = opts.agentName ?? getRunContextStorage().getStore()?.agentName ?? self.config.serviceName;
      // A single object argument is the usual tool shape; positional arguments are named arg0, arg1, … unless argNames is given
      const argObj: Record<string, unknown> =
        args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])
          ? (args[0] as Record<string, unknown>)
          : Object.fromEntries(args.map((v, i) => [opts.argNames?.[i] ?? `arg${i}`, v]));
      return self.governorFor(agentName).run({ name, args: argObj }, 'sdk', () => fn.apply(this, args), opts.hints) as Promise<Awaited<R>>;
    };
    return wrapped;
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
  /** What sendTrace sends (issue #50) */
  readonly capture:  CaptureLevel;

  constructor(options: Leap360ClientOptions = {}) {
    this.capture   = resolveCapture(options.capture);
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

    await postTrace(this.apiUrl, this.apiKey, body, this.silent, this.capture);
  }

  // ─── Reading the project, the kill switch, policies and shadow mode ────────
  // Every method resolves to the API's JSON. Errors resolve too, never reject: the object carries `error`, `code` and
  // `httpStatus` (0 when the API can't be reached), so a suspended agent reads as { code: 'AGENT_HALT', httpStatus: 403 }.
  // An API key can tighten governance but never loosen it: resuming an agent, switching to shadow mode, approving and
  // changing or deleting a policy need a person signed in to the console, and resolve to { code: 'PERSON_REQUIRED' }.

  private async request<T = any>(method: string, path: string, body?: unknown, query?: Record<string, string | number | undefined>): Promise<T> {
    if (!this.apiKey) return { error: 'No API key. Pass apiKey or set LEAP360_API_KEY.', code: 'NO_API_KEY', httpStatus: 0 } as T;
    const qs = new URLSearchParams(Object.entries(query ?? {}).filter(([, v]) => v !== undefined).map(([k, v]): [string, string] => [k, String(v)])).toString();
    let res: Response;
    try {
      res = await fetch(`${this.apiUrl.replace(/\/$/, '')}${path}${qs ? `?${qs}` : ''}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'x-api-key': this.apiKey },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err: any) {
      return { error: err?.message ?? String(err), code: 'UNREACHABLE', httpStatus: 0 } as T;
    }
    const data: any = await res.json().catch(() => (res.ok ? {} : { error: `HTTP ${res.status}` }));
    if (res.ok) return data as T;
    const out = data && typeof data === 'object' && !Array.isArray(data) ? data : { error: data };
    return { error: `HTTP ${res.status}`, ...out, httpStatus: res.status } as T;
  }

  private project(...parts: (string | number)[]) {
    // The API scopes every project route to the API key; the id in the path is only a label
    return ['/v1/projects', encodeURIComponent(this.projectId), ...parts.map((p) => encodeURIComponent(String(p)))].join('/');
  }

  getTraces(opts: { limit?: number; offset?: number } = {}) { return this.request('GET', this.project('traces'), undefined, { limit: opts.limit ?? 50, offset: opts.offset ?? 0 }); }
  getStats() { return this.request('GET', this.project('stats')); }
  getModels() { return this.request('GET', this.project('models')); }
  getAudit() { return this.request('GET', this.project('audit')); }

  getAgents() { return this.request('GET', this.project('agents')); }
  getAgentStatus(agentId: string) { return this.request('GET', this.project('agents', agentId, 'status')); }
  /** Stops one agent. Always allowed with an API key */
  suspendAgent(agentId: string) { return this.request('POST', this.project('agents', agentId, 'status'), { status: 'SUSPENDED' }); }
  /** Restarts a stopped agent: needs a signed-in person */
  resumeAgent(agentId: string) { return this.request('POST', this.project('agents', agentId, 'status'), { status: 'ACTIVE' }); }
  getProjectStatus() { return this.request('GET', this.project('status')); }
  /** 'SUSPENDED' stops every agent; 'ACTIVE' (needs a signed-in person) lifts it */
  setProjectStatus(status: 'ACTIVE' | 'SUSPENDED') { return this.request('POST', this.project('status'), { status }); }

  getPolicies() { return this.request('GET', this.project('policies')); }
  createPolicy(policy: Record<string, unknown>) { return this.request('POST', this.project('policies'), policy); }

  // ── Tool rules ("what agents do"), the same rules the console's New rule form makes (issue #51) ──
  /** Every tool rule (kind 'action') on the project */
  async listToolRules(): Promise<any> {
    const r = await this.getPolicies();
    return Array.isArray(r?.policies) ? { policies: r.policies.filter((p: any) => p?.kind === 'action') } : r;
  }
  /**
   * Adds a tool rule. `action`: 'block', 'ask_admin' (Hold for a person) or 'warn'. `match` needs at least one of
   * categories, tools (globs), minRisk, findings or argPattern. Adding a rule is always allowed with an API key.
   */
  createToolRule(rule: { name: string; action: 'block' | 'ask_admin' | 'warn'; match: ActionPolicy['match']; severity?: string; assignedAgents?: string[] }) {
    return this.createPolicy({ kind: 'action', severity: rule.action === 'block' ? 'critical' : 'high', ...rule });
  }
  /** Removes a rule. This loosens governance, so it needs a signed-in person (an API key alone gets 403). */
  deletePolicy(policyId: string) { return this.request('DELETE', this.project('policies', policyId)); }
  /**
   * Adds the safe defaults onboarding adds: block destructive actions; hold payments and refunds, permission and
   * secret changes, and deploys. Rules that already exist (same name) are skipped.
   */
  async addSafeDefaults(): Promise<{ added: string[]; skipped: string[]; errors: string[] }> {
    const existing = await this.listToolRules();
    const names = new Set<string>((existing?.policies ?? []).map((p: any) => p?.name));
    const out = { added: [] as string[], skipped: [] as string[], errors: [] as string[] };
    for (const rule of SAFE_DEFAULT_RULES) {
      if (names.has(rule.name)) { out.skipped.push(rule.name); continue; }
      const r: any = await this.createToolRule(rule);
      if (r?.error) out.errors.push(`${rule.name}: ${r.error}`); else out.added.push(rule.name);
    }
    return out;
  }
  getViolations() { return this.request('GET', this.project('violations')); }
  getApprovals() { return this.request('GET', this.project('approvals')); }
  /** Needs a signed-in person */
  decideApproval(traceId: string, decision: 'approved' | 'rejected' | 'APPROVED' | 'REJECTED', note?: string) {
    return this.request('POST', this.project('approvals', traceId, 'decision'), { decision: decision.toUpperCase(), adminNote: note ?? null });
  }

  /** The project status, including `mode`: 'shadow' or 'enforce' */
  getMode() { return this.request('GET', this.project('mode')); }
  /** 'enforce' is always allowed; 'shadow' (optionally for `days`, 1 to 30) needs a signed-in person */
  setMode(mode: Mode, days?: number) { return this.request('POST', this.project('mode'), { mode, ...(days ? { days } : {}) }); }
  /** What policies would have blocked, per-agent activity and capabilities, and suggested policies */
  getShadowReport() { return this.request('GET', this.project('shadow')); }
  /** Recorded tool calls, newest first. `since` is an ISO time (default: the last 7 days) */
  getActions(opts: { limit?: number; since?: string } = {}) { return this.request('GET', this.project('actions'), undefined, { limit: opts.limit ?? 100, since: opts.since }); }
  /** Reports uploaded by `leap360 scan --report` */
  getScans() { return this.request('GET', this.project('scans')); }
}
