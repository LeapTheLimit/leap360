/**
 * leap360 — governor
 *
 * The gate every agent action passes through, shared by leap.wrapTool() and the MCP proxy.
 *
 *   shadow   the action always runs. It is classified locally (well under 1 ms) and reported in the
 *            background, so the agent never waits on Leap360 for policy. The server records what WOULD have happened.
 *   enforce  the server decides before the action runs.
 *
 * Enforce mode decides locally by default (`decisions: 'local'`): the project's action policies are cached for
 * `policyTtlMs` (5 s), so a call the policies allow runs at once and is recorded in the background. Only a call the
 * policies would block or hold goes to the server, which stays authoritative (approvals, key-bound stops).
 * In production this took a governed call from ~430 ms (a network round trip each time) to well under a millisecond.
 *
 * The kill switch applies in both modes: the status is cached for at most `statusTtlMs` (default 1 s), so a Stop
 * lands within that time and a Resume is picked up just as fast, without restarting the agent.
 *
 * When Leap360 cannot decide (unreachable, timed out, or an API without action support), actions at or above
 * `failClosedAt` are blocked and the rest run. When the API refuses the request (4xx), the action is blocked:
 * a request the API will not check must never run unchecked.
 */

import {
  classifyAction, decideAction, riskRank, redactSensitive, scanText, toPlain,
  type ActionPolicy, type ActionSource, type ClassifiedAction, type Finding, type RiskLevel, type ToolCall, type ToolHints, type Verdict,
} from './actions.js';
import { CLOUD_API_URL } from './config.js';
import { argPatternMatches, argsFingerprint, findingWithoutValue, redactLocally, resolveCapture, shapeOf, summarize, type CaptureLevel } from './privacy.js';

export type Mode = 'shadow' | 'enforce';

export interface GovernorOptions {
  apiKey: string;
  baseUrl?: string;
  agentName: string;
  /** Force a mode locally. Leave unset to follow the mode set in the Leap360 console. */
  mode?: Mode;
  /** In enforce mode, block actions at or above this risk when Leap360 cannot decide. Default 'critical'. */
  failClosedAt?: RiskLevel;
  /** How long enforce mode waits for a decision. Default 2000 ms. */
  timeoutMs?: number;
  /** How long a kill-switch status may be reused. Default 1000 ms. */
  statusTtlMs?: number;
  /**
   * 'local' (default): enforce mode decides allowed calls in-process from cached policies and asks the server only
   * for calls a policy would block or hold. 'server': ask the server for every call.
   */
  decisions?: 'local' | 'server';
  /** How long the cached action policies are reused. Default 5000 ms: a new policy applies within 5 seconds. */
  policyTtlMs?: number;
  /**
   * When a policy holds an action for approval, wait this long for a person to decide before giving up.
   * Default 0: fail at once with APPROVAL_REQUIRED (an approval then lets the same call run for 15 minutes).
   */
  approvalWaitMs?: number;
  /** Poll the kill switch and mode in the background. Default true. */
  poll?: boolean;
  /** Where diagnostics go. The MCP proxy must keep stdout clean, so the default is stderr. */
  log?: (msg: string) => void;
  /**
   * What leaves this process (issue #50). 'metadata' (default): tool name, argument keys and types and the
   * classified action, never argument values or results. 'redacted': values with personal details masked here.
   * 'full': everything, credentials still masked. Also set by LEAP360_CAPTURE.
   */
  capture?: CaptureLevel;
}

export interface GateResult {
  allowed: boolean;
  /** Use this to report the outcome with record() */
  actionId: string;
  mode: Mode;
  /** What actually happens */
  verdict: Verdict;
  /** What the policies say. Differs from verdict in shadow mode. */
  wouldBe: Verdict;
  action: ClassifiedAction;
  message?: string;
  policy?: { policyId?: string; name: string };
  /** Set when the decision was made without the server */
  offline?: boolean;
}

export class Leap360ActionBlockedError extends Error {
  readonly code: string;
  readonly gate: GateResult;
  constructor(gate: GateResult, code = 'ACTION_BLOCKED') {
    super(`[Leap360] 🛡️ ${code}: ${gate.message ?? `"${gate.action.name}" was blocked`}`);
    this.name = 'Leap360ActionBlockedError';
    this.code = code;
    this.gate = gate;
  }
}

const uuid = (): string =>
  (globalThis.crypto as any)?.randomUUID?.() ?? `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;

/** Sortable and unique per project: the server uses it as the sort key */
export const newActionId = (): string => `${new Date().toISOString()}~${uuid()}`;

const MAX_RESULT_PREVIEW = 500;
const MAX_SCAN_RESULT = 200_000;

/** The text of a tool result, for scanning and previews (MCP content blocks are flattened to their text) */
export function resultText(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'string') return v;
  const content = (v as any)?.content;
  if (Array.isArray(content) && content.every((c: any) => c && typeof c === 'object')) {
    const t = content.filter((c: any) => c.type === 'text' && typeof c.text === 'string').map((c: any) => c.text).join('\n');
    if (t) return t;
  }
  return JSON.stringify(toPlain(v));
}

function preview(text: string | undefined): string | undefined {
  if (text == null) return undefined;
  return redactSensitive(text.length > MAX_RESULT_PREVIEW ? `${text.slice(0, MAX_RESULT_PREVIEW)}…` : text);
}

const maskFor = (level: CaptureLevel, s: string | undefined) => (s !== undefined && level === 'redacted' ? redactLocally(s) : s);

/** Why the governor could not get a decision from the server */
class NoDecision extends Error {
  constructor(readonly kind: 'offline' | 'unsupported' | 'unauthorized' | 'refused', message: string) { super(message); }
}

interface Status { halted: { code: string; message: string } | null; at: number }
interface Policies { list: ActionPolicy[]; at: number; ok: boolean }

const WOULD_BE: Record<Verdict, string> = { allow: 'allowed', warn: 'warned', review: 'held', block: 'blocked' };

export interface DeclaredTool { name: string; description?: string; hints?: ToolHints }

/** Every tool this process has declared, and those waiting to be sent, per API key and agent */
const declared = new Set<string>();
const declareQueues = new Map<string, { target: { apiKey: string; baseUrl: string; agentName: string }; tools: Record<string, unknown>[] }>();
let declareTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Tells Leap360 which tools an agent can reach, whether or not it ever calls them, so the console can map its
 * capabilities and point out risky ones a shadow window never saw. Batched, once per tool, never throws.
 * Separate from Governor so declaring a tool never caches a kill-switch status before the first call.
 */
export function declareTools(target: { apiKey: string; baseUrl?: string; agentName: string }, tools: DeclaredTool[], source: ActionSource, server?: string): void {
  if (!target.apiKey) return;
  const baseUrl = (target.baseUrl || CLOUD_API_URL).replace(/\/$/, '');
  const qk = `${baseUrl}\u0000${target.apiKey}\u0000${target.agentName}`;
  for (const t of tools) {
    if (typeof t?.name !== 'string' || !t.name || t.name.length > 200) continue;
    const key = `${qk}\u0000${source}\u0000${server ?? ''}\u0000${t.name}`;
    if (declared.has(key)) continue;
    declared.add(key);
    const q = declareQueues.get(qk) ?? { target: { apiKey: target.apiKey, baseUrl, agentName: target.agentName }, tools: [] };
    q.tools.push({
      tool: t.name, source,
      ...(server ? { server } : {}),
      ...(typeof t.description === 'string' && t.description ? { description: t.description.slice(0, 200) } : {}),
      ...(t.hints ? { hints: t.hints } : {}),
    });
    declareQueues.set(qk, q);
  }
  if (!declareQueues.size || declareTimer) return;
  declareTimer = setTimeout(() => {
    declareTimer = null;
    const queues = [...declareQueues.values()];
    declareQueues.clear();
    for (const { target: o, tools: all } of queues) {
      for (let i = 0; i < all.length; i += 200) {
        // An API without /v1/capabilities answers 404: the map is a nice-to-have, never an error
        fetch(`${o.baseUrl}/v1/capabilities`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': o.apiKey },
          body: JSON.stringify({ agent_name: o.agentName, tools: all.slice(i, i + 200) }),
          signal: AbortSignal.timeout(10_000),
        }).catch(() => {});
      }
    }
  }, 250);
}

export class Governor {
  private readonly o: Required<Omit<GovernorOptions, 'mode'>> & { mode?: Mode };
  /** Mode last reported by the server; undefined until it answers */
  private serverMode: Mode | undefined;
  private status: Status = { halted: null, at: 0 };
  private statusInFlight: Promise<Status> | null = null;
  private policies: Policies = { list: [], at: 0, ok: false };
  private policiesInFlight: Promise<Policies> | null = null;
  /** The "before" report of each action still in flight, so its "after" report never overtakes it */
  private pendingPre = new Map<string, Promise<unknown>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private warned = new Set<string>();

  constructor(opts: GovernorOptions) {
    // Defaults go after the spread: callers pass options that are present but undefined
    this.o = {
      ...opts,
      baseUrl: (opts.baseUrl || CLOUD_API_URL).replace(/\/$/, ''),
      failClosedAt: opts.failClosedAt ?? 'critical',
      timeoutMs: opts.timeoutMs ?? 2000,
      statusTtlMs: opts.statusTtlMs ?? 1000,
      decisions: opts.decisions ?? 'local',
      policyTtlMs: opts.policyTtlMs ?? 5000,
      approvalWaitMs: opts.approvalWaitMs ?? 0,
      poll: opts.poll ?? true,
      log: opts.log ?? ((m) => console.error(m)),
      capture: resolveCapture(opts.capture),
    };
    if (this.o.poll) this.startPolling();
  }

  /** The mode in effect right now */
  get mode(): Mode {
    return this.o.mode ?? this.serverMode ?? 'enforce';
  }

  get agentName(): string { return this.o.agentName; }

  /** What this governor sends: 'metadata', 'redacted' or 'full' */
  get capture(): CaptureLevel { return this.o.capture; }

  /** The "before" report at the capture level. At 'metadata' the values stay here: only their shape and what they mean leave. */
  private async preBody(actionId: string, source: ActionSource, name: string, action: ClassifiedAction, hints?: ToolHints): Promise<Record<string, unknown>> {
    const base = { phase: 'pre', id: actionId, source, agent_name: this.o.agentName, tool: name, hints, capture: this.o.capture };
    if (this.o.capture === 'full') return { ...base, args: action.args };
    if (this.o.capture === 'redacted') return { ...base, args: redactLocally(action.args) };
    // Argument patterns are tested here. In enforce mode wait for the policies; in shadow mode use what is cached.
    const pol = this.mode === 'enforce' ? await this.currentPolicies() : (void this.currentPolicies(), this.policies);
    return {
      ...base,
      args: shapeOf(action.args),
      classified: summarize(action),
      arg_matches: argPatternMatches(pol.list, action.args),
      args_key: await argsFingerprint(this.o.apiKey, name, action.args),
    };
  }

  /**
   * Decides whether an action may run. Never throws: check `allowed`.
   * In shadow mode the only wait is a kill-switch status older than `statusTtlMs`.
   */
  async check(call: ToolCall, source: ActionSource, hints?: ToolHints): Promise<GateResult> {
    // Arguments are made JSON-safe first: a value that cannot be serialised must not skip the check
    const args = toPlain(call.args ?? {}) as Record<string, unknown>;
    const name = typeof call.name === 'string' ? call.name : String(call.name ?? '');
    const action = classifyAction({ name, args: args && typeof args === 'object' && !Array.isArray(args) ? args : { value: args } }, hints);
    const actionId = newActionId();
    const base = { actionId, action };

    if (!name.trim() || name.length > 200) {
      return { ...base, allowed: false, mode: this.mode, verdict: 'block', wouldBe: 'block', message: `"${name.slice(0, 40)}${name.length > 40 ? '…' : ''}" is not a valid tool name (1 to 200 characters), so it cannot be checked` };
    }

    const body = await this.preBody(actionId, source, name, action, hints);

    if (this.mode === 'shadow') {
      // Policies never wait in shadow mode. The kill switch still does, at most once per statusTtlMs.
      const st = await this.currentStatus();
      if (st.halted) {
        void this.report(body);
        return { ...base, allowed: false, mode: 'shadow', verdict: 'block', wouldBe: 'block', message: st.halted.message };
      }
      const pre = this.report(body).then((r) => {
        this.learn(r);
        if (r?.wouldBe && r.wouldBe !== 'allow') {
          this.o.log(`[Leap360] 👁  watch: ${name} (${r.category}, ${r.risk} risk) would be ${WOULD_BE[r.wouldBe as Verdict] ?? r.wouldBe}${r.policy?.name ? ` by "${r.policy.name}"` : ''}; it ran`);
        }
      }).catch(() => {}).finally(() => this.pendingPre.delete(actionId));
      this.pendingPre.set(actionId, pre);
      return { ...base, allowed: true, mode: 'shadow', verdict: 'allow', wouldBe: 'allow' };
    }

    // Fast path: decide in-process when the cached policies allow the call; the server only sees risky calls
    if (this.o.decisions === 'local') {
      const [st, pol] = await Promise.all([this.currentStatus(), this.currentPolicies()]);
      if (st.halted) {
        void this.report(body).catch(() => {});
        return { ...base, allowed: false, mode: 'enforce', verdict: 'block', wouldBe: 'block', message: st.halted.message };
      }
      if (pol.ok && this.mode === 'enforce') {
        const local = decideAction(action, pol.list, this.o.agentName);
        if (local.verdict === 'allow' || local.verdict === 'warn') {
          const pre = this.report(body).then((r) => this.learn(r)).catch(() => {}).finally(() => this.pendingPre.delete(actionId));
          this.pendingPre.set(actionId, pre);
          if (local.verdict === 'warn') this.o.log(`[Leap360] ⚠️ ${name}: ${local.reasons[0] ?? 'policy warning'}`);
          return { ...base, allowed: true, mode: 'enforce', verdict: local.verdict, wouldBe: local.verdict, policy: local.policy, message: local.verdict === 'warn' ? local.reasons[0] : undefined };
        }
        // A policy would block or hold it: the server decides (approvals, grants, key-bound stops)
      }
    }

    let res: any;
    try {
      res = await this.post('/v1/actions', body, this.o.timeoutMs);
    } catch (err) {
      return this.noDecision(base, err);
    }
    this.learn(res);
    const mode: Mode = res?.mode === 'shadow' ? 'shadow' : 'enforce';
    const halted = res?.code === 'GOVERNANCE_HALT' || res?.code === 'AGENT_HALT';
    let verdict: Verdict = halted ? 'block' : (res?.decision as Verdict) ?? 'allow';
    let message: string | undefined = res?.message;
    if (verdict === 'review' && this.o.approvalWaitMs > 0 && typeof res?.approvalId === 'string') {
      this.o.log(`[Leap360] ⏳ ${name} is waiting for approval in the Leap360 console (up to ${Math.round(this.o.approvalWaitMs / 1000)} s)`);
      const decided = await this.waitForApproval(res.approvalId);
      if (decided === 'APPROVED') { verdict = 'allow'; message = 'Approved in the Leap360 console'; }
      else if (decided === 'REJECTED') { verdict = 'block'; message = 'Rejected in the Leap360 console'; }
    }
    // "review" holds the action for a human; until approvals for tool calls ship, a held action does not run
    return {
      ...base,
      action: { ...action, category: res?.category ?? action.category, risk: res?.risk ?? action.risk, findings: res?.findings ?? action.findings },
      allowed: verdict === 'allow' || verdict === 'warn',
      mode,
      verdict,
      wouldBe: (res?.wouldBe as Verdict) ?? verdict,
      message,
      policy: res?.policy,
    };
  }

  /**
   * Reports how the action went. Fire and forget. The full result is scanned locally for prompt injection and
   * credentials (content coming back to the model is how indirect prompt injection arrives); only a redacted
   * preview and the findings leave the process.
   */
  record(actionId: string, outcome: { ok: boolean; error?: unknown; durationMs: number; result?: unknown }): Finding[] {
    const text = outcome.ok ? resultText(outcome.result) : undefined;
    const findings = text ? scanText(text.length > MAX_SCAN_RESULT ? text.slice(0, MAX_SCAN_RESULT) : text, 'result') : [];
    const errText = outcome.error === undefined ? undefined : outcome.error instanceof Error ? outcome.error.message : resultText(outcome.error);
    const level = this.o.capture;
    const body = level === 'metadata'
      // No result or error text: only that it failed, and what kind of error
      ? {
          phase: 'post', id: actionId, agent_name: this.o.agentName, capture: level,
          ok: outcome.ok, error: outcome.error === undefined ? undefined : outcome.error instanceof Error ? outcome.error.name : 'Error',
          duration_ms: Math.round(outcome.durationMs), output_findings: findings.map(findingWithoutValue),
        }
      : {
          phase: 'post', id: actionId, agent_name: this.o.agentName, capture: level,
          ok: outcome.ok, error: maskFor(level, preview(errText)), duration_ms: Math.round(outcome.durationMs), result_preview: maskFor(level, preview(text)),
          output_findings: findings,
        };
    const after = () => this.report(body).catch(() => {});
    const pre = this.pendingPre.get(actionId);
    void (pre ? pre.then(after, after) : after());
    for (const f of findings) {
      if (f.kind === 'injection' || f.kind === 'secret') this.o.log(`[Leap360] ⚠️ ${f.kind === 'injection' ? 'possible prompt injection' : 'credential'} in the output of an action: ${f.detail}`);
    }
    return findings;
  }

  /** Runs `fn` behind the gate: blocked actions throw Leap360ActionBlockedError and never run */
  async run<R>(call: ToolCall, source: ActionSource, fn: () => Promise<R> | R, hints?: ToolHints): Promise<R> {
    const gate = await this.check(call, source, hints);
    if (!gate.allowed) {
      this.o.log(`[Leap360] 🛡️ blocked ${call.name} (${gate.action.category}, ${gate.action.risk}): ${gate.message ?? gate.verdict}`);
      throw new Leap360ActionBlockedError(gate, gate.verdict === 'review' ? 'APPROVAL_REQUIRED' : 'ACTION_BLOCKED');
    }
    const t = Date.now();
    try {
      const result = await fn();
      this.record(gate.actionId, { ok: true, durationMs: Date.now() - t, result });
      return result;
    } catch (err) {
      this.record(gate.actionId, { ok: false, durationMs: Date.now() - t, error: err });
      throw err;
    }
  }

  /** Polls the approval queue until a person decides or approvalWaitMs passes */
  private async waitForApproval(id: string): Promise<'APPROVED' | 'REJECTED' | null> {
    const until = Date.now() + this.o.approvalWaitMs;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, Math.min(2000, Math.max(0, until - Date.now()))));
      try {
        const r = await this.get(`/v1/projects/default/approvals/${encodeURIComponent(id)}/poll`, 3000);
        if (r?.decision === 'APPROVED' || r?.decision === 'REJECTED') return r.decision;
      } catch { /* keep waiting */ }
    }
    return null;
  }

  /**
   * Tells Leap360 which tools this agent can reach, whether or not it ever calls them, so the console can map
   * its capabilities and point out risky ones a shadow window never saw. Batched, once per tool, never throws.
   */
  declareTools(tools: DeclaredTool[], source: ActionSource, server?: string): void {
    declareTools({ apiKey: this.o.apiKey, baseUrl: this.o.baseUrl, agentName: this.o.agentName }, tools, source, server);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ── internals ──────────────────────────────────────────────────────────

  private noDecision(base: { actionId: string; action: ClassifiedAction }, err: unknown): GateResult {
    const nd = err instanceof NoDecision ? err : new NoDecision('offline', err instanceof Error ? err.message : String(err));
    const name = base.action.name;
    // The API looked at the request and refused it: never run what Leap360 would not check
    if (nd.kind === 'refused') {
      return { ...base, allowed: false, mode: 'enforce', verdict: 'block', wouldBe: 'block', offline: true, message: `Leap360 refused to check "${name}": ${nd.message}` };
    }
    // A halt we already know about holds while we cannot reach the server
    if (this.status.halted) {
      return { ...base, allowed: false, mode: 'enforce', verdict: 'block', wouldBe: 'block', offline: true, message: this.status.halted.message };
    }
    const why = nd.kind === 'unsupported'
      ? 'this Leap360 API does not support action checks yet (deploy the latest API)'
      : nd.kind === 'unauthorized' ? 'the Leap360 API key was rejected' : `Leap360 is unreachable (${nd.message})`;
    if (!this.warned.has(nd.kind)) {
      this.warned.add(nd.kind);
      this.o.log(`[Leap360] ⚠️ ${why}; blocking ${this.o.failClosedAt}-risk actions and above until it is resolved`);
    }
    const block = riskRank(base.action.risk) >= riskRank(this.o.failClosedAt);
    return {
      ...base,
      allowed: !block,
      mode: 'enforce',
      verdict: block ? 'block' : 'allow',
      wouldBe: block ? 'block' : 'allow',
      offline: true,
      message: block ? `${why[0].toUpperCase()}${why.slice(1)}, and "${name}" is ${base.action.risk} risk (${base.action.category})` : undefined,
    };
  }

  private learn(res: any) {
    if (!res || typeof res !== 'object') return;
    if (res.mode === 'shadow' || res.mode === 'enforce') this.serverMode = res.mode;
    if (res.code === 'GOVERNANCE_HALT' || res.code === 'AGENT_HALT') {
      if (!this.status.halted) this.o.log(`[Leap360] 🛡️ ${res.code}: ${res.message ?? 'Stopped by your team in Leap360. Do not retry.'}`);
      this.status = { halted: { code: res.code, message: res.message ?? 'Stopped by your team in Leap360. Do not retry.' }, at: Date.now() };
    }
    if (this.warned.size) { this.warned.clear(); this.o.log('[Leap360] 🟢 reconnected'); }
  }

  /** Action policies no older than policyTtlMs; concurrent callers share one request. ok=false until a valid list arrives. */
  private currentPolicies(): Promise<Policies> {
    if (Date.now() - this.policies.at < this.o.policyTtlMs) return Promise.resolve(this.policies);
    if (!this.policiesInFlight) {
      this.policiesInFlight = this.fetchPolicies().finally(() => { this.policiesInFlight = null; });
    }
    return this.policiesInFlight;
  }

  private async fetchPolicies(): Promise<Policies> {
    try {
      const j = await this.get('/v1/projects/default/policies', Math.min(this.o.timeoutMs, 1500));
      // Only a real policy list enables local decisions; anything else keeps every call on the server path
      if (j && Array.isArray(j.policies)) {
        this.policies = { list: j.policies.filter((p: ActionPolicy) => p?.kind === 'action'), at: Date.now(), ok: true };
        return this.policies;
      }
    } catch { /* keep the last good list */ }
    this.policies = { ...this.policies, at: Date.now() };
    return this.policies;
  }

  /** Kill-switch status no older than statusTtlMs; concurrent callers share one request */
  private currentStatus(): Promise<Status> {
    if (Date.now() - this.status.at < this.o.statusTtlMs) return Promise.resolve(this.status);
    if (!this.statusInFlight) {
      this.statusInFlight = this.fetchStatus().finally(() => { this.statusInFlight = null; });
    }
    return this.statusInFlight;
  }

  private async fetchStatus(): Promise<Status> {
    try {
      const timeout = Math.min(this.o.timeoutMs, 1500);
      const [project, agent] = await Promise.all([
        this.get('/v1/projects/default/status', timeout),
        // caller=sdk: also stopped when this API key belongs to a suspended agent, whatever name we report
        this.get(`/v1/projects/default/agents/${encodeURIComponent(this.o.agentName)}/status?caller=sdk`, timeout),
      ]);
      if (project?.mode === 'shadow' || project?.mode === 'enforce') this.serverMode = project.mode;
      const wasHalted = !!this.status.halted;
      let halted: Status['halted'] = null;
      if (project?.status === 'SUSPENDED') halted = { code: 'GOVERNANCE_HALT', message: 'Stopped by your team in Leap360 (Stop all is on). Do not retry.' };
      else if (agent?.status === 'SUSPENDED') halted = { code: 'AGENT_HALT', message: agent?.reason || `Stopped by your team in Leap360: the agent "${this.o.agentName}" is stopped. Do not retry.` };
      else if (!project || !agent) halted = this.status.halted; // keep the last known state when a read failed
      this.status = { halted, at: Date.now() };
      if (halted && !wasHalted) this.o.log(`[Leap360] 🛡️ ${halted.message}`);
      if (!halted && wasHalted) this.o.log(`[Leap360] 🟢 ${this.o.agentName} resumed`);
    } catch {
      // Unreachable: keep the last known state, retry on the next call
      this.status = { ...this.status, at: Date.now() };
    }
    return this.status;
  }

  private startPolling() {
    void this.currentStatus();
    if (this.o.decisions === 'local') void this.currentPolicies();
    this.timer = setInterval(() => { this.status.at = 0; void this.currentStatus(); }, 15_000);
    // Never keep a process alive just to poll
    (this.timer as any)?.unref?.();
  }

  private report(body: Record<string, unknown>): Promise<any> {
    return this.post('/v1/actions', body, 10_000);
  }

  private async get(path: string, timeoutMs = 5000): Promise<any> {
    const res = await fetch(`${this.o.baseUrl}${path}`, { headers: { 'x-api-key': this.o.apiKey }, signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? res.json() : null;
  }

  private async post(path: string, body: unknown, timeoutMs = 10_000): Promise<any> {
    let res: Response;
    try {
      res = await fetch(`${this.o.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': this.o.apiKey },
        body: JSON.stringify(toPlain(body)),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err: any) {
      throw new NoDecision('offline', err?.name === 'TimeoutError' ? `no answer within ${timeoutMs} ms` : err?.message ?? String(err));
    }
    // 403 carries a decision (kill switch or block)
    if (res.status === 403) return res.json().catch(() => ({ code: 'AGENT_HALT', decision: 'block' }));
    if (res.ok) return res.json();
    const detail = await res.json().then((j: any) => j?.error || j?.message || '').catch(() => '');
    if (res.status === 404 || res.status === 405) throw new NoDecision('unsupported', `HTTP ${res.status}`);
    if (res.status === 401) throw new NoDecision('unauthorized', `HTTP 401${detail ? `: ${detail}` : ''}`);
    if (res.status >= 400 && res.status < 500) throw new NoDecision('refused', `HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
    throw new NoDecision('offline', `HTTP ${res.status}`);
  }
}
