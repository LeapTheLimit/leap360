/**
 * leap360 — privacy (issue #50)
 *
 * What leaves the customer's process. Three levels, per client:
 *
 *   metadata  (default) only what the gate needs: tool name, argument keys and types, the classified action and
 *             risk computed here, the verdict, timings, model name and token counts. No message text, no argument
 *             values, no result text.
 *   redacted  text and values are sent with credentials and personal details (cards, SSNs, emails, phone numbers)
 *             masked here, before sending. The API masks them again before storing.
 *   full      everything, for teams that want complete traces while debugging. Credentials are still masked.
 *
 * Tool rules ("what agents do") keep working at every level: the action is classified in this process, from the
 * real arguments, and only the result of that classification is sent. Message rules ("what agents say") need the
 * text, so at `metadata` they do not run and the console says so.
 */

import { redactSensitive, redactSecrets, isSafePattern, safeJson, type ActionPolicy, type ClassifiedAction, type Finding } from './actions.js';

export type CaptureLevel = 'metadata' | 'redacted' | 'full';
export const DEFAULT_CAPTURE: CaptureLevel = 'metadata';

/** Anything other than 'redacted' or 'full' is 'metadata': an unknown value never sends more */
export function captureLevel(v: unknown): CaptureLevel {
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'redacted' || s === 'full') return s;
  }
  return DEFAULT_CAPTURE;
}

/** The capture level from LEAP360_CAPTURE, if set, else the option, else 'metadata' */
export function resolveCapture(option?: CaptureLevel | string): CaptureLevel {
  const env = typeof process !== 'undefined' ? process.env?.LEAP360_CAPTURE : undefined;
  return captureLevel(option ?? env);
}

/** Keys and types, never values: { amount: 'number', to: 'string', items: 'array(3)' } */
export function shapeOf(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'object') {
    if (depth >= 4) return 'object';
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (n++ >= 50) { out['…'] = `${Object.keys(value as object).length - 50} more keys`; break; }
      out[k.slice(0, 100)] = shapeOf(v, depth + 1);
    }
    return out;
  }
  return typeof value;
}

/** Phone numbers in international or common national formats, last 2 digits kept */
const PHONE = /(?<![\w.])(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?)?\d{2,4}[ .-]\d{3,4}[ .-]?\d{2,4}(?!\w|\.\d)/g;

function maskPhones<T>(value: T, depth = 0): T {
  if (depth > 12 || value == null) return value;
  if (typeof value === 'string') {
    return value.replace(PHONE, (m) => {
      const digits = m.replace(/\D/g, '');
      // Dates, versions and short numbers are not phone numbers
      if (digits.length < 9 || digits.length > 15 || /^\d{4}-\d{2}-\d{2}/.test(m)) return m;
      return `[PHONE ••${digits.slice(-2)}]`;
    }) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => maskPhones(v, depth + 1)) as unknown as T;
  if (typeof value === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) o[k] = maskPhones(v, depth + 1);
    return o as T;
  }
  return value;
}

/** Credentials and personal details masked in this process */
export function redactLocally<T>(value: T): T {
  return maskPhones(redactSensitive(value));
}

/**
 * The content to send at this level: undefined at 'metadata' (send nothing), masked at 'redacted', and with only
 * credentials masked at 'full'.
 */
export function captured<T>(level: CaptureLevel, value: T): T | undefined {
  if (value === undefined) return undefined;
  if (level === 'metadata') return undefined;
  if (level === 'redacted') return redactLocally(value);
  return redactSecrets(value);
}

/** A finding without the value that triggered it: "Credential passed as \"token\": sk-…" → "Credential passed as \"token\"" */
export function findingWithoutValue(f: Finding): Finding {
  const detail = String(f.detail ?? '').split(/: |\s\(/)[0].trim().slice(0, 120);
  return { kind: f.kind, detail, severity: f.severity, ...(f.owasp ? { owasp: f.owasp } : {}), ...(f.path ? { path: f.path } : {}) };
}

/** What the gate needs about one action, without its argument values */
export interface ClassifiedSummary {
  category: string;
  risk: string;
  reasons: string[];
  findings: Finding[];
}

/**
 * The action policies whose argument pattern matches these arguments, tested here so the values never leave.
 * The API applies a policy with an argument pattern only when its id is in this list.
 */
export function argPatternMatches(policies: ActionPolicy[], args: unknown): string[] {
  const json = safeJson(args ?? {}).slice(0, 4000);
  const out: string[] = [];
  for (const p of policies) {
    const pat = p?.match?.argPattern;
    if (!pat || !p.policyId || !isSafePattern(pat)) continue;
    try { if (new RegExp(pat, 'i').test(json)) out.push(p.policyId); } catch { /* skip */ }
  }
  return out.slice(0, 50);
}

/**
 * A one-way fingerprint of the exact call, so an approval lets the same call run again and nothing else.
 * Salted with the API key, so it cannot be matched against a list of likely values by anyone without that key.
 */
export async function argsFingerprint(salt: string, tool: string, args: unknown): Promise<string | undefined> {
  try {
    const data = new TextEncoder().encode(`${salt}\u0000${tool}\u0000${safeJson(args ?? {})}`);
    const digest = await (globalThis as any).crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 48);
  } catch { return undefined; }
}

const RISKS = ['none', 'low', 'medium', 'high', 'critical'];
const CATEGORIES = new Set([
  'shell.exec', 'fs.delete', 'fs.write', 'db.destructive', 'db.write', 'k8s.delete', 'k8s.scale', 'k8s.exec',
  'git.merge', 'git.push', 'release.publish', 'deploy', 'iam.change', 'infra.apply', 'infra.destroy',
  'payment', 'message.send', 'secrets.read', 'network.request', 'read', 'unknown',
]);
const FINDING_KINDS = new Set(['secret', 'pii', 'injection', 'prod-target', 'wildcard', 'remote-code', 'exfil']);

/**
 * Server side of 'metadata' capture: the SDK classified the call from its real arguments, with the same code the API
 * runs, so the API uses that classification. This trusts the client no more than before: at any capture level the
 * client chooses which arguments to report. Without a valid classification the API falls back to the tool name.
 * `shape` replaces the arguments.
 */
export function mergeClassified(fromName: ClassifiedAction, client: unknown, shape: Record<string, unknown>): ClassifiedAction {
  const c = (client && typeof client === 'object' ? client : {}) as Record<string, unknown>;
  let valid = typeof c.risk === 'string' && RISKS.includes(c.risk) && typeof c.category === 'string' && CATEGORIES.has(c.category);
  // classifyAction only ever lowers a shell tool (to a read-only command). Anything else reported below what its
  // name says did not come from this SDK: keep the name's classification.
  if (valid && RISKS.indexOf(c.risk as string) < RISKS.indexOf(fromName.risk) && fromName.category !== 'shell.exec' && !fromName.reasons.includes('unrecognised tool')) valid = false;
  const risk = valid ? c.risk as string : fromName.risk;
  const category = valid ? c.category as string : fromName.category;
  const reasons = Array.isArray(c.reasons) ? c.reasons.filter((r): r is string => typeof r === 'string').map((r) => r.slice(0, 160)).slice(0, 10) : [];
  const findings = Array.isArray(c.findings)
    ? (c.findings as any[]).filter((f) => f && FINDING_KINDS.has(f.kind)).slice(0, 20).map((f) => findingWithoutValue({
        kind: f.kind, detail: String(f.detail ?? f.kind), severity: RISKS.includes(f.severity) ? f.severity : 'medium',
        ...(typeof f.owasp === 'string' ? { owasp: f.owasp.slice(0, 60) } : {}), ...(typeof f.path === 'string' ? { path: f.path.slice(0, 120) } : {}),
      }))
    : [];
  return {
    ...fromName,
    args: shape,
    category: category as ClassifiedAction['category'],
    risk: risk as ClassifiedAction['risk'],
    reasons: valid && reasons.length ? reasons : fromName.reasons,
    findings,
  };
}

/**
 * Policies as they apply to a 'metadata' call: one with an argument pattern applies only when the SDK reported that
 * the pattern matched (the values were tested there); its other conditions still apply here.
 */
export function policiesForMetadata(policies: ActionPolicy[], argMatches: unknown): ActionPolicy[] {
  const matched = new Set(Array.isArray(argMatches) ? argMatches.filter((x) => typeof x === 'string') : []);
  const out: ActionPolicy[] = [];
  for (const p of policies) {
    if (!p.match?.argPattern) { out.push(p); continue; }
    if (p.policyId && matched.has(p.policyId)) out.push({ ...p, match: { ...p.match, argPattern: '.*' } });
  }
  return out;
}

export function summarize(action: ClassifiedAction): ClassifiedSummary {
  return {
    category: action.category,
    risk: action.risk,
    reasons: action.reasons.slice(0, 10).map((r) => r.slice(0, 160)),
    findings: action.findings.slice(0, 20).map(findingWithoutValue),
  };
}
