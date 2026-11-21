/**
 * leap360 — local mode
 *
 * Runs Leap360 on this device with no cloud, no account and no API key. Turn it on with any of:
 *   LEAP360_LOCAL=1                      (environment)
 *   new Leap360({ local: true, ... })    or baseUrl: 'local'
 *   new Leap360Client({ apiUrl: 'local' })
 *
 * Everything lives in one folder (LEAP360_HOME, default ~/.leap360/local), as plain files you can read and edit:
 *   rules.json      the mode ("enforce" or "watch") and the action rules. Created with the safe defaults.
 *   state.json      Stop all, and the agents that are stopped
 *   approvals.json  tool calls held for a person, and their decisions
 *   activity.jsonl  one line per checked tool call, outcome and LLM call
 *
 * The CLI drives it: `leap360 local status | stop | resume | approvals | approve | reject | mode | log`.
 * Nothing in this file opens a network connection.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ActionCategory, ActionPolicy } from './actions.js';

/** The safe defaults the console adds at onboarding (src/console/safeDefaults.ts): keep the two lists the same */
export const SAFE_DEFAULT_RULES: { name: string; action: 'block' | 'ask_admin'; severity: string; match: { categories: ActionCategory[] } }[] = [
  { name: 'Block destructive actions', action: 'block', severity: 'critical', match: { categories: ['db.destructive', 'infra.destroy', 'k8s.delete', 'fs.delete'] } },
  { name: 'Hold payments and refunds', action: 'ask_admin', severity: 'high', match: { categories: ['payment'] } },
  { name: 'Hold permission and secret changes', action: 'ask_admin', severity: 'high', match: { categories: ['iam.change', 'secrets.read'] } },
  { name: 'Hold deploys and releases', action: 'ask_admin', severity: 'high', match: { categories: ['deploy', 'release.publish', 'infra.apply'] } },
];

const truthy = (v: string | undefined) => !!v && !['0', 'false', 'no', 'off', ''].includes(v.trim().toLowerCase());

/** True when this URL (or, with none, the environment) means "run on this device" */
export function isLocal(url?: string | null): boolean {
  if (typeof url === 'string' && url) return url === 'local' || url.startsWith('local:');
  return typeof process !== 'undefined' && truthy(process.env['LEAP360_LOCAL']);
}

export const localHome = (): string =>
  process.env['LEAP360_HOME'] || path.join(process.env['HOME'] || process.env['USERPROFILE'] || os.homedir(), '.leap360', 'local');

export type LocalMode = 'shadow' | 'enforce';

export interface LocalRules {
  /** 'enforce' (rules apply) or 'watch' (nothing is blocked; the log shows what would have been) */
  mode: LocalMode;
  policies: ActionPolicy[];
  /** What activity.jsonl keeps of arguments: 'metadata', 'redacted' (default) or 'full' */
  capture?: 'metadata' | 'redacted' | 'full';
}

export interface LocalApproval {
  id: string;
  createdAt: string;
  agent: string;
  tool: string;
  category: string;
  risk: string;
  policy?: string;
  argsKey?: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  decidedAt?: string;
}

interface LocalState { stopped: boolean; stoppedAgents: string[] }

/** An approved call may run again for this long, as in the cloud */
const APPROVAL_TTL_MS = 15 * 60_000;

const normMode = (m: unknown): LocalMode | undefined =>
  m === 'shadow' || m === 'watch' ? 'shadow' : m === 'enforce' || m === 'block' ? 'enforce' : undefined;

function defaultRules(): LocalRules {
  return {
    mode: 'enforce',
    capture: 'redacted',
    policies: SAFE_DEFAULT_RULES.map((r, i) => ({ policyId: `default-${i + 1}`, kind: 'action', ...r })),
  };
}

export class LocalStore {
  readonly dir: string;
  private rulesCache: { mtime: number; rules: LocalRules } | null = null;

  constructor(dir = localHome()) {
    this.dir = dir;
  }

  private file(name: string) { return path.join(this.dir, name); }

  private ensureDir() { fs.mkdirSync(this.dir, { recursive: true }); }

  private readJson<T>(name: string, fallback: T): T {
    try { return JSON.parse(fs.readFileSync(this.file(name), 'utf8')) as T; } catch { return fallback; }
  }

  /** Write through a temporary file so a reader never sees half a file */
  private writeJson(name: string, value: unknown) {
    this.ensureDir();
    const tmp = this.file(`${name}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(tmp, this.file(name));
    if (name === 'rules.json') this.rulesCache = null;
  }

  /** Creates rules.json with the safe defaults when it does not exist yet. Returns true when it was created. */
  init(): boolean {
    if (fs.existsSync(this.file('rules.json'))) return false;
    this.writeJson('rules.json', defaultRules());
    return true;
  }

  /** The rules, re-read whenever rules.json changes. A broken file keeps the last good rules (or the defaults). */
  rules(): LocalRules {
    let mtime = -1;
    try { mtime = fs.statSync(this.file('rules.json')).mtimeMs; } catch { /* no file yet */ }
    if (mtime === -1) {
      try { this.init(); mtime = fs.statSync(this.file('rules.json')).mtimeMs; } catch { return this.rulesCache?.rules ?? defaultRules(); }
    }
    if (this.rulesCache && this.rulesCache.mtime === mtime) return this.rulesCache.rules;
    const raw = this.readJson<any>('rules.json', null);
    if (!raw || typeof raw !== 'object') return this.rulesCache?.rules ?? defaultRules();
    const rules: LocalRules = {
      mode: normMode(raw.mode) ?? 'enforce',
      capture: ['metadata', 'redacted', 'full'].includes(raw.capture) ? raw.capture : 'redacted',
      // Rules written by hand may leave out kind: every rule here is an action rule
      policies: (Array.isArray(raw.policies) ? raw.policies : [])
        .filter((p: any) => p && typeof p === 'object' && typeof p.name === 'string')
        .map((p: any, i: number) => ({ policyId: p.policyId ?? `rule-${i + 1}`, ...p, kind: p.kind ?? 'action' })),
    };
    this.rulesCache = { mtime, rules };
    return rules;
  }

  mode(): LocalMode { return this.rules().mode; }

  setMode(mode: string): LocalMode {
    const m = normMode(mode);
    if (!m) throw new Error(`mode must be "enforce" or "watch" (got "${mode}")`);
    this.writeJson('rules.json', { ...this.rules(), mode: m });
    return m;
  }

  policies(): ActionPolicy[] { return this.rules().policies; }

  addPolicy(p: Record<string, unknown>): ActionPolicy {
    const r = this.rules();
    const policy = { policyId: `rule-${Date.now().toString(36)}`, kind: 'action', ...p } as ActionPolicy;
    this.writeJson('rules.json', { ...r, policies: [...r.policies, policy] });
    return policy;
  }

  deletePolicy(policyId: string): boolean {
    const r = this.rules();
    const left = r.policies.filter((p) => p.policyId !== policyId);
    if (left.length === r.policies.length) return false;
    this.writeJson('rules.json', { ...r, policies: left });
    return true;
  }

  // ── Stop all ──────────────────────────────────────────────────────────

  private state(): LocalState {
    const s = this.readJson<Partial<LocalState>>('state.json', {});
    return { stopped: s.stopped === true, stoppedAgents: Array.isArray(s.stoppedAgents) ? s.stoppedAgents.filter((a) => typeof a === 'string') : [] };
  }

  /** Why this agent may not act right now, or null */
  halted(agent?: string): { code: 'GOVERNANCE_HALT' | 'AGENT_HALT'; message: string } | null {
    const s = this.state();
    if (s.stopped) return { code: 'GOVERNANCE_HALT', message: 'Stopped on this device (Stop all is on). Do not retry.' };
    if (agent && s.stoppedAgents.includes(agent)) return { code: 'AGENT_HALT', message: `Stopped on this device: the agent "${agent}" is stopped. Do not retry.` };
    return null;
  }

  status(): LocalState { return this.state(); }

  /** Stop every agent, or one */
  stop(agent?: string) {
    const s = this.state();
    if (agent) { if (!s.stoppedAgents.includes(agent)) s.stoppedAgents.push(agent); } else s.stopped = true;
    this.writeJson('state.json', s);
  }

  /** Resume every agent (and clear every per-agent stop), or one */
  resume(agent?: string) {
    const s = this.state();
    if (agent) s.stoppedAgents = s.stoppedAgents.filter((a) => a !== agent);
    else { s.stopped = false; s.stoppedAgents = []; }
    this.writeJson('state.json', s);
  }

  // ── Approvals ─────────────────────────────────────────────────────────

  approvals(): LocalApproval[] {
    const a = this.readJson<LocalApproval[]>('approvals.json', []);
    return Array.isArray(a) ? a : [];
  }

  /** Holds a call for a person. The same call (same agent, tool and arguments) waiting already reuses its entry. */
  hold(entry: Omit<LocalApproval, 'id' | 'createdAt' | 'status'>): LocalApproval {
    const list = this.approvals();
    const same = list.find((a) => a.status === 'PENDING' && a.agent === entry.agent && a.tool === entry.tool && a.argsKey === entry.argsKey);
    if (same) return same;
    const a: LocalApproval = { id: Math.random().toString(36).slice(2, 8), createdAt: new Date().toISOString(), status: 'PENDING', ...entry };
    // Keep the file small: the last 500 entries
    this.writeJson('approvals.json', [...list, a].slice(-500));
    return a;
  }

  decide(id: string, decision: 'APPROVED' | 'REJECTED'): LocalApproval | null {
    const list = this.approvals();
    const a = list.find((x) => x.id === id);
    if (!a) return null;
    a.status = decision;
    a.decidedAt = new Date().toISOString();
    this.writeJson('approvals.json', list);
    return a;
  }

  decision(id: string): LocalApproval['status'] | null {
    return this.approvals().find((a) => a.id === id)?.status ?? null;
  }

  /** True when a person approved this exact call in the last 15 minutes */
  isApproved(agent: string, tool: string, argsKey: string | undefined): boolean {
    const now = Date.now();
    return this.approvals().some((a) => a.status === 'APPROVED' && a.agent === agent && a.tool === tool && a.argsKey === argsKey
      && a.decidedAt && now - Date.parse(a.decidedAt) < APPROVAL_TTL_MS);
  }

  // ── Activity log ──────────────────────────────────────────────────────

  log(entry: Record<string, unknown>) {
    try {
      this.ensureDir();
      fs.appendFileSync(this.file('activity.jsonl'), `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
    } catch { /* the log must never break a call */ }
  }

  /** The last `limit` log entries, newest last */
  activity(limit = 50): Record<string, unknown>[] {
    let text = '';
    try { text = fs.readFileSync(this.file('activity.jsonl'), 'utf8'); } catch { return []; }
    return text.split('\n').filter(Boolean).slice(-limit).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  }

  /**
   * Answers the Leap360Client API on this device: the same paths and JSON shapes as the cloud, for the parts that
   * make sense without it. Anything else answers { code: 'LOCAL_UNSUPPORTED', httpStatus: 501 }.
   */
  request(method: string, apiPath: string, body?: any, query?: Record<string, string | number | undefined>): any {
    const parts = apiPath.split('?')[0].split('/').filter(Boolean).map(decodeURIComponent);
    // v1 projects <project> <resource> ...
    const [, , , resource, id, sub] = parts;
    const ok = <T>(v: T) => v;
    const s = this.state();
    if (resource === 'status') {
      if (method === 'POST') {
        if (body?.status === 'SUSPENDED') this.stop(); else if (body?.status === 'ACTIVE') this.resume();
      }
      return ok({ status: this.halted() ? 'SUSPENDED' : 'ACTIVE', mode: this.mode(), local: true });
    }
    if (resource === 'agents' && id && sub === 'status') {
      if (method === 'POST') {
        if (body?.status === 'SUSPENDED') this.stop(id); else if (body?.status === 'ACTIVE') this.resume(id);
      }
      return ok({ agentId: id, status: s.stopped || this.state().stoppedAgents.includes(id) ? 'SUSPENDED' : 'ACTIVE' });
    }
    if (resource === 'agents' && !id) {
      const seen = new Map<string, number>();
      for (const e of this.activity(10_000)) if (e['phase'] === 'pre' && typeof e['agent'] === 'string') seen.set(e['agent'] as string, (seen.get(e['agent'] as string) ?? 0) + 1);
      for (const a of s.stoppedAgents) if (!seen.has(a)) seen.set(a, 0);
      return ok({ agents: [...seen].map(([name, calls]) => ({ agentId: name, name, calls, killStatus: s.stopped || s.stoppedAgents.includes(name) ? 'SUSPENDED' : 'ACTIVE' })) });
    }
    if (resource === 'policies') {
      if (method === 'GET') return ok({ policies: this.policies() });
      if (method === 'POST') return ok(this.addPolicy(body ?? {}));
      if (method === 'DELETE' && id) return this.deletePolicy(id) ? ok({ deleted: id }) : { error: 'No such rule', httpStatus: 404 };
    }
    if (resource === 'mode') {
      if (method === 'POST') { try { this.setMode(body?.mode); } catch (e: any) { return { error: e.message, httpStatus: 400 }; } }
      return ok({ mode: this.mode(), local: true });
    }
    if (resource === 'approvals') {
      if (!id) return ok({ approvals: this.approvals().filter((a) => a.status === 'PENDING') });
      if (sub === 'poll') return ok({ decision: this.decision(id) ?? 'PENDING' });
      if (sub === 'decision' && method === 'POST') {
        const d = String(body?.decision ?? '').toUpperCase();
        if (d !== 'APPROVED' && d !== 'REJECTED') return { error: 'decision must be APPROVED or REJECTED', httpStatus: 400 };
        return this.decide(id, d) ?? { error: 'No such approval', httpStatus: 404 };
      }
    }
    if (resource === 'actions' && method === 'GET') {
      const limit = Number(query?.limit ?? 100) || 100;
      return ok({ actions: this.activity(limit * 3).filter((e) => e['phase'] === 'pre').slice(-limit) });
    }
    if (resource === 'traces' && method === 'GET') {
      const limit = Number(query?.limit ?? 50) || 50;
      return ok({ traces: this.activity(limit * 3).filter((e) => e['kind'] === 'trace').slice(-limit) });
    }
    return { error: `${method} ${apiPath} needs the Leap360 cloud; it is not available in local mode`, code: 'LOCAL_UNSUPPORTED', httpStatus: 501 };
  }
}

let shared: LocalStore | null = null;
let sharedDir = '';

/** One store per folder for the whole process */
export function localStore(): LocalStore {
  const dir = localHome();
  if (!shared || sharedDir !== dir) { shared = new LocalStore(dir); sharedDir = dir; }
  return shared;
}
