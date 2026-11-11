/**
 * leap360 — action engine
 *
 * Reads what an AI agent is trying to DO (tool calls), not just what it says, and scores it.
 * Pure and dependency-free: the SDK runs it locally (L0, well under 1 ms per call) and the Cloud API
 * bundles the same file so the server never has to trust the client's classification.
 *
 *   extractToolCalls(response)   tool calls from an OpenAI, Anthropic, Gemini or Bedrock response
 *   classifyAction(call)         category + risk + findings for one tool call
 *   scanText(text)               secrets, personal data and prompt-injection markers in any text
 *   decideAction(action, ...)    the verdict deterministic action policies give a classified call
 *   suggestPolicies(actions)     draft policies from what shadow mode observed, each replayed against it
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type RiskLevel = 'none' | 'low' | 'medium' | 'high' | 'critical';

export type ActionCategory =
  | 'shell.exec' | 'fs.delete' | 'fs.write'
  | 'db.destructive' | 'db.write'
  | 'k8s.delete' | 'k8s.scale' | 'k8s.exec'
  | 'git.merge' | 'git.push' | 'release.publish' | 'deploy'
  | 'iam.change' | 'infra.apply' | 'infra.destroy'
  | 'payment' | 'message.send' | 'secrets.read' | 'network.request'
  | 'read' | 'unknown';

export type FindingKind = 'secret' | 'pii' | 'injection' | 'prod-target' | 'wildcard' | 'remote-code' | 'exfil';

export interface Finding {
  kind: FindingKind;
  /** What was found, with any sensitive value already redacted */
  detail: string;
  severity: RiskLevel;
  /** OWASP Top 10 for LLM Applications (2025) reference */
  owasp?: string;
  /** Which argument it was found in, e.g. "args.command" */
  path?: string;
}

/** Where a tool call was seen */
export type ActionSource = 'llm' | 'sdk' | 'mcp';

export interface ToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

/** Hints a tool declares about itself (MCP tool annotations) */
export interface ToolHints {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}

export interface ClassifiedAction extends ToolCall {
  category: ActionCategory;
  risk: RiskLevel;
  reasons: string[];
  findings: Finding[];
}

export type Verdict = 'allow' | 'warn' | 'review' | 'block';

export interface ActionPolicyMatch {
  /** Any of these categories */
  categories?: ActionCategory[];
  /** Tool name globs, e.g. "delete_*" or "github.*" */
  tools?: string[];
  /** At or above this risk */
  minRisk?: RiskLevel;
  /** Case-insensitive regex tested against the JSON of the arguments */
  argPattern?: string;
  /** Any of these finding kinds */
  findings?: FindingKind[];
}

export interface ActionPolicy {
  policyId?: string;
  name: string;
  kind?: string;
  action: 'warn' | 'ask_admin' | 'block' | string;
  severity?: string;
  match?: ActionPolicyMatch;
  assignedAgents?: string[];
  /** Calls this policy no longer applies to, each added by a person after approving one (issue #9) */
  exceptions?: PolicyException[];
}

/** "This agent may run this tool": an exact tool name, for one agent or (agent null) every agent */
export interface PolicyException {
  tool: string;
  agent?: string | null;
  addedBy?: string;
  addedAt?: string;
  /** The approved action or trace that led to it */
  fromApproval?: string;
}

/** True when an exception lets this call through the policy */
export function isExcepted(policy: ActionPolicy, toolName: string, agent: string | null | undefined): boolean {
  return (policy.exceptions ?? []).some((e) => e.tool === toolName && (!e.agent || e.agent === (agent ?? null)));
}

export interface ActionDecision {
  /** What the policies say should happen */
  verdict: Verdict;
  /** The policy that decided it, if any */
  policy?: { policyId?: string; name: string };
  reasons: string[];
}

// ─── Risk helpers ───────────────────────────────────────────────────────────

const RISK_ORDER: RiskLevel[] = ['none', 'low', 'medium', 'high', 'critical'];
export const riskRank = (r: RiskLevel | undefined): number => RISK_ORDER.indexOf(r ?? 'none');
const maxRisk = (a: RiskLevel, b: RiskLevel): RiskLevel => (riskRank(a) >= riskRank(b) ? a : b);
const bumpRisk = (r: RiskLevel): RiskLevel => RISK_ORDER[Math.min(RISK_ORDER.length - 1, riskRank(r) + 1)];
const lowerRisk = (r: RiskLevel): RiskLevel => RISK_ORDER[Math.max(1, riskRank(r) - 1)];

const VERDICT_ORDER: Verdict[] = ['allow', 'warn', 'review', 'block'];
const verdictRank = (v: Verdict): number => VERDICT_ORDER.indexOf(v);
export const policyActionToVerdict = (a: string): Verdict =>
  a === 'block' ? 'block' : a === 'ask_admin' ? 'review' : a === 'warn' ? 'warn' : 'allow';

// ─── 1. Extract tool calls from any provider response ────────────────────────

const MAX_CALLS = 50;

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === 'string') {
    try {
      const v = JSON.parse(raw);
      return v && typeof v === 'object' && !Array.isArray(v) ? v : { value: v };
    } catch {
      return { raw };
    }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return { value: raw };
}

/**
 * Pulls tool calls out of a model response. Handles:
 *   OpenAI Chat Completions (tool_calls, legacy function_call), OpenAI Responses API (output[].function_call),
 *   Anthropic Messages (content[].tool_use), Gemini old and new SDKs (parts[].functionCall),
 *   Bedrock Converse (output.message.content[].toolUse).
 */
/**
 * The tools an LLM request offers the model: what the agent is configured to reach, whether or not the model
 * ever calls them. Works on the request bodies of OpenAI (Chat and Responses), Anthropic, Gemini and Bedrock.
 */
export function extractToolDefinitions(request: unknown): { name: string; description?: string }[] {
  if (!request || typeof request !== 'object') return [];
  const r = request as any;
  const out = new Map<string, string | undefined>();
  const push = (name: unknown, description?: unknown) => {
    if (typeof name === 'string' && name && out.size < 200 && !out.has(name)) out.set(name, typeof description === 'string' ? description.slice(0, 200) : undefined);
  };
  const lists = [r.tools, r.config?.tools, r.toolConfig?.tools, r.generationConfig?.tools].filter(Array.isArray) as any[][];
  for (const list of lists) {
    for (const t of list) {
      if (t?.function) push(t.function.name, t.function.description);                 // OpenAI Chat
      else if (t?.toolSpec) push(t.toolSpec.name, t.toolSpec.description);             // Bedrock Converse
      else if (Array.isArray(t?.functionDeclarations)) for (const f of t.functionDeclarations) push(f?.name, f?.description); // Gemini
      else if (Array.isArray(t?.function_declarations)) for (const f of t.function_declarations) push(f?.name, f?.description);
      else if (t?.type === 'function' || t?.input_schema || t?.parameters) push(t.name, t.description); // OpenAI Responses, Anthropic
    }
  }
  return [...out.entries()].map(([name, description]) => (description ? { name, description } : { name }));
}

export function extractToolCalls(response: unknown): ToolCall[] {
  if (!response || typeof response !== 'object') return [];
  const r = response as any;
  const calls: ToolCall[] = [];
  const push = (name: unknown, args: unknown, id?: unknown) => {
    if (typeof name === 'string' && name && calls.length < MAX_CALLS) {
      calls.push({ id: typeof id === 'string' ? id : undefined, name, args: parseArgs(args) });
    }
  };

  // OpenAI Chat Completions
  if (Array.isArray(r.choices)) {
    for (const ch of r.choices) {
      const m = ch?.message ?? ch?.delta;
      if (Array.isArray(m?.tool_calls)) for (const tc of m.tool_calls) push(tc?.function?.name, tc?.function?.arguments, tc?.id);
      if (m?.function_call) push(m.function_call.name, m.function_call.arguments);
    }
  }
  // OpenAI Responses API
  if (Array.isArray(r.output)) {
    for (const o of r.output) if (o?.type === 'function_call') push(o.name, o.arguments, o.call_id ?? o.id);
  }
  // Anthropic Messages
  if (Array.isArray(r.content)) {
    for (const b of r.content) if (b?.type === 'tool_use') push(b.name, b.input, b.id);
  }
  // Gemini: old SDK nests under .response, new SDK has candidates at the top
  const candidates = r.response?.candidates ?? r.candidates;
  if (Array.isArray(candidates)) {
    for (const c of candidates) {
      for (const p of c?.content?.parts ?? []) if (p?.functionCall) push(p.functionCall.name, p.functionCall.args, p.functionCall.id);
    }
  }
  // Bedrock Converse
  const bedrock = r.output?.message?.content;
  if (Array.isArray(bedrock)) {
    for (const b of bedrock) if (b?.toolUse) push(b.toolUse.name, b.toolUse.input, b.toolUse.toolUseId);
  }
  return calls;
}

// ─── 2. Scan text for secrets, personal data and prompt injection ────────────

interface Detector { kind: FindingKind; label: string; re: RegExp; severity: RiskLevel; owasp: string; check?: (m: string) => boolean }

const LLM02 = 'LLM02:2025 Sensitive Information Disclosure';
const LLM01 = 'LLM01:2025 Prompt Injection';
const LLM06 = 'LLM06:2025 Excessive Agency';

function luhn(digits: string): boolean {
  const d = digits.replace(/\D/g, '');
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = d.charCodeAt(d.length - 1 - i) - 48;
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}

const DETECTORS: Detector[] = [
  { kind: 'secret', label: 'AWS access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, severity: 'critical', owasp: LLM02 },
  { kind: 'secret', label: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g, severity: 'critical', owasp: LLM02 },
  { kind: 'secret', label: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_\-]{20,}/g, severity: 'critical', owasp: LLM02 },
  { kind: 'secret', label: 'OpenAI API key', re: /\bsk-(?:proj-)?[A-Za-z0-9_\-]{32,}/g, severity: 'critical', owasp: LLM02 },
  { kind: 'secret', label: 'Stripe live key', re: /\b[rs]k_live_[A-Za-z0-9]{16,}\b/g, severity: 'critical', owasp: LLM02 },
  { kind: 'secret', label: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, severity: 'high', owasp: LLM02 },
  { kind: 'secret', label: 'Google API key', re: /\bAIza[0-9A-Za-z_\-]{35}\b/g, severity: 'high', owasp: LLM02 },
  { kind: 'secret', label: 'Private key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g, severity: 'critical', owasp: LLM02 },
  { kind: 'secret', label: 'JSON Web Token', re: /\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g, severity: 'high', owasp: LLM02 },
  { kind: 'secret', label: 'Password in a connection string', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@\/]+:[^\s@\/]{3,}@/gi, severity: 'critical', owasp: LLM02 },
  { kind: 'secret', label: 'Bearer token', re: /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}=*/g, severity: 'high', owasp: LLM02 },
  { kind: 'secret', label: 'Basic auth credentials', re: /\bBasic\s+[A-Za-z0-9+\/]{16,}={0,2}/g, severity: 'high', owasp: LLM02 },
  { kind: 'secret', label: 'Password or secret assignment', re: /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*["']?[^\s"',;]{8,}/gi, severity: 'high', owasp: LLM02 },
  { kind: 'pii', label: 'Payment card number', re: /\b(?:\d[ -]?){13,19}\b/g, severity: 'high', owasp: LLM02, check: luhn },
  { kind: 'pii', label: 'US Social Security number', re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g, severity: 'high', owasp: LLM02 },
  { kind: 'pii', label: 'IBAN', re: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}\b/g, severity: 'medium', owasp: LLM02 },
  { kind: 'pii', label: 'Email address', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, severity: 'low', owasp: LLM02 },
  { kind: 'injection', label: 'Instruction override', re: /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|system)\s+(?:instructions?|prompts?|rules?|messages?)/gi, severity: 'high', owasp: LLM01 },
  { kind: 'injection', label: 'System prompt extraction', re: /\b(?:reveal|print|show|repeat|output)\s+(?:me\s+)?(?:your|the)\s+(?:system\s+prompt|hidden\s+instructions|initial\s+instructions)/gi, severity: 'high', owasp: LLM01 },
  { kind: 'injection', label: 'Jailbreak persona', re: /\b(?:you\s+are\s+now\s+(?:DAN|in\s+developer\s+mode|unrestricted)|do\s+anything\s+now|jailbreak(?:ed)?\s+mode)\b/gi, severity: 'high', owasp: LLM01 },
  { kind: 'injection', label: 'Chat-template token', re: /<\|(?:im_start|im_end|system|endoftext)\|>|\[\/?INST\]/g, severity: 'medium', owasp: LLM01 },
];

/** Shows enough of a match to recognise it, never the value itself */
export function redactSample(s: string): string {
  const t = s.trim();
  if (t.length <= 8) return '*'.repeat(t.length);
  return `${t.slice(0, 4)}…${'*'.repeat(Math.min(8, t.length - 4))}`;
}

const MAX_SCAN = 100_000;

/** Finds secrets, personal data and prompt-injection markers. Findings never contain the raw value. */
export function scanText(text: string, path?: string): Finding[] {
  if (!text) return [];
  const t = text.length > MAX_SCAN ? text.slice(0, MAX_SCAN) : text;
  const out: Finding[] = [];
  for (const d of DETECTORS) {
    d.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let hits = 0;
    let sample = '';
    while ((m = d.re.exec(t)) && hits < 20) {
      if (d.check && !d.check(m[0])) continue;
      if (!hits) sample = m[0];
      hits++;
    }
    if (hits) {
      const shown = d.kind === 'injection' ? `"${sample.slice(0, 60)}"` : redactSample(sample);
      out.push({ kind: d.kind, detail: `${d.label}${hits > 1 ? ` ×${hits}` : ''}: ${shown}`, severity: d.severity, owasp: d.owasp, path });
    }
  }
  return out;
}

const SECRET_DETECTORS = DETECTORS.filter((d) => d.kind === 'secret');

function redactSecretText(s: string): string {
  for (const d of SECRET_DETECTORS) {
    s = d.label === 'Password in a connection string'
      ? s.replace(d.re, (m) => m.replace(/:([^\s@\/:]+)@$/, ':[REDACTED]@'))
      : s.replace(d.re, (m) => `[REDACTED ${d.label}: ${redactSample(m)}]`);
  }
  return s;
}

/** Personal data kept recognisable but not usable: card → last 4 digits, SSN → last 4, email → first letter and domain */
function redactPiiText(s: string): string {
  return s
    .replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => (luhn(m) ? `[CARD •••• ${m.replace(/\D/g, '').slice(-4)}]` : m))
    .replace(/\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(\d{4})\b/g, (_m, last) => `[SSN •••-••-${last}]`)
    .replace(/\b([A-Za-z0-9])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, (_m, first, domain) => `${first}•••@${domain}`);
}

function redactDeep<T>(value: T, text: (s: string) => string, depth = 0): T {
  if (depth > 12 || value == null) return value;
  if (typeof value === 'string') return text(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, text, depth + 1)) as unknown as T;
  if (typeof value === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // A value held under a credential-like key is a credential, whatever it looks like
      o[k] = typeof v === 'string' && /(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|credential)/i.test(k) && v.length >= 6 && !v.startsWith('[REDACTED')
        ? `[REDACTED ${k}: ${redactSample(v)}]`
        : redactDeep(v, text, depth + 1);
    }
    return o as T;
  }
  return value;
}

/** Replaces credentials with a redacted marker, recursively */
export function redactSecrets<T>(value: T): T {
  return redactDeep(value, redactSecretText);
}

/** Credentials and personal data (cards, SSNs, emails) masked: what Leap360 stores */
export function redactSensitive<T>(value: T): T {
  return redactDeep(value, (s) => redactPiiText(redactSecretText(s)));
}

/**
 * A JSON-safe copy of anything an agent might pass: BigInt → string, cycles → "[Circular]",
 * functions → "[Function name]", Map → object, Set → array, binary → "[binary N bytes]", Error → { name, message }.
 * Serialising tool arguments must never fail: a failure would let the call skip its policy check.
 */
export function toPlain(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value ?? null;
  switch (typeof value) {
    case 'bigint': return `${value.toString()}n`;
    case 'function': return `[Function ${(value as { name?: string }).name || 'anonymous'}]`;
    case 'symbol': return value.toString();
    case 'number': return Number.isFinite(value) ? value : String(value);
    case 'string': case 'boolean': return value;
  }
  if (depth > 12) return '[Too deep]';
  const o = value as object;
  if (seen.has(o)) return '[Circular]';
  seen.add(o);
  try {
    if (o instanceof Date) return isNaN(o.getTime()) ? 'Invalid Date' : o.toISOString();
    if (o instanceof Error) return { name: o.name, message: o.message };
    if (o instanceof Map) return Object.fromEntries([...o.entries()].map(([k, v]) => [String(k), toPlain(v, depth + 1, seen)]));
    if (o instanceof Set) return [...o].map((v) => toPlain(v, depth + 1, seen));
    if (ArrayBuffer.isView(o) || o instanceof ArrayBuffer) return `[binary ${(o as ArrayBuffer).byteLength} bytes]`;
    if (Array.isArray(o)) return o.slice(0, 1000).map((v) => toPlain(v, depth + 1, seen));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o).slice(0, 1000)) if (v !== undefined) out[k] = toPlain(v, depth + 1, seen);
    return out;
  } finally {
    seen.delete(o);
  }
}

/** JSON.stringify that cannot throw */
export const safeJson = (value: unknown): string => JSON.stringify(toPlain(value));

// ─── 3. Classify a tool call ─────────────────────────────────────────────────

interface Rule { category: ActionCategory; risk: RiskLevel; re: RegExp; why: string }

/** Matched against command-like argument text: what the call would actually run */
const COMMAND_RULES: Rule[] = [
  { category: 'shell.exec', risk: 'critical', re: /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/i, why: 'pipes a download straight into a shell' },
  { category: 'shell.exec', risk: 'critical', re: /\b(?:(?:ba|z)?sh|source|\.)\s+<\(\s*(?:curl|wget)\b|\beval\s+["']?\$\(\s*(?:curl|wget)\b|\b(?:python3?|node|perl|ruby)\s+-[ce]\s+["']?\$\(\s*(?:curl|wget)\b/i, why: 'runs a download straight into a shell' },
  { category: 'shell.exec', risk: 'critical', re: /\bbase64\s+(?:-d|--decode|-D)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b|\bxxd\s+-r\b[^\n]*\|\s*(?:ba|z)?sh\b/i, why: 'runs an encoded command' },
  { category: 'fs.delete', risk: 'critical', re: /\brm\s+-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)\b|\bRemove-Item\b[^\n]*-Recurse/i, why: 'recursive force delete' },
  { category: 'fs.delete', risk: 'critical', re: /\b(?:mkfs(?:\.\w+)?|dd\s+if=|shred|format\s+[a-z]:)/i, why: 'wipes a disk or filesystem' },
  { category: 'k8s.delete', risk: 'critical', re: /\b(?:kubectl|oc)\s+delete\b|\bhelm\s+(?:uninstall|delete)\b/i, why: 'deletes Kubernetes resources' },
  { category: 'k8s.scale', risk: 'high', re: /\b(?:kubectl|oc)\s+(?:scale|drain|cordon|rollout\s+(?:restart|undo))\b/i, why: 'changes Kubernetes capacity or rollout' },
  { category: 'k8s.exec', risk: 'high', re: /\b(?:kubectl|oc)\s+exec\b/i, why: 'opens a shell inside a running container' },
  { category: 'infra.destroy', risk: 'critical', re: /\b(?:terraform|tofu)\s+destroy\b|\b(?:terraform|tofu)\s+apply\b[^\n]*\s-destroy\b|\bpulumi\s+destroy\b|\baws\s+cloudformation\s+delete-stack\b/i, why: 'destroys infrastructure' },
  { category: 'infra.apply', risk: 'high', re: /\b(?:terraform|tofu)\s+apply\b|\bpulumi\s+up\b|\bcdk\s+deploy\b/i, why: 'applies infrastructure changes' },
  { category: 'iam.change', risk: 'critical', re: /\baws\s+iam\s+(?:create|attach|put|update|delete|add)|\bgcloud\b[^\n]*\badd-iam-policy-binding\b|\baz\s+role\s+assignment\s+create\b/i, why: 'changes cloud permissions' },
  { category: 'git.push', risk: 'critical', re: /\bgit\s+push\b[^\n]*(?:--force\b|-f\b|--force-with-lease\b)/i, why: 'force-pushes and can rewrite history' },
  { category: 'git.push', risk: 'high', re: /\bgit\s+push\b/i, why: 'pushes code' },
  { category: 'git.merge', risk: 'high', re: /\bgh\s+pr\s+merge\b|\bgit\s+merge\b/i, why: 'merges code' },
  { category: 'release.publish', risk: 'high', re: /\b(?:npm|pnpm|yarn)\s+publish\b|\bgh\s+release\s+create\b|\bdocker\s+push\b|\btwine\s+upload\b/i, why: 'publishes a release' },
  { category: 'db.destructive', risk: 'critical', re: /\b(?:drop|truncate)\s+(?:table|database|schema|index)\b/i, why: 'drops or truncates data' },
  { category: 'db.destructive', risk: 'critical', re: /\btruncate\s+(?:only\s+)?[\w."`\[\]]+\s*(?:;|,|$|\s+(?:cascade|restart|continue)\b)/im, why: 'drops or truncates data' },
  { category: 'db.destructive', risk: 'critical', re: /\bdelete\s+from\s+[\w."`\[\]]+\s*(?:;|$)/im, why: 'DELETE with no WHERE clause' },
  { category: 'db.destructive', risk: 'critical', re: /\bdb\.\w+\.(?:drop|deleteMany\(\s*\{\s*\}\s*\))|\bFLUSHALL\b|\bFLUSHDB\b/i, why: 'wipes a collection or cache' },
  { category: 'shell.exec', risk: 'high', re: /\b(?:chmod\s+(?:-R\s+)?777|chown\s+-R|sudo\s|systemctl\s+(?:stop|disable)|iptables\s+-F)\b/i, why: 'changes system permissions or services' },
];

/** SQL that writes; only applied to arguments that look like SQL */
const SQL_WRITE = /\b(?:insert\s+into|update\s+\w+\s+set|delete\s+from|alter\s+table|create\s+table|grant\s|revoke\s)/i;

/** Matched against the tool's own name */
const NAME_RULES: Rule[] = [
  // Before the shell rule, so "execute_sql" is a database call, not a shell
  { category: 'db.write', risk: 'medium', re: /(?:execute|exec|run)[_.\-]?(?:sql|query|statement)/i, why: 'runs database statements' },
  { category: 'shell.exec', risk: 'high', re: /(?:^|[_.\-\s])(?:shell|bash|zsh|powershell|terminal|exec(?:ute)?_?(?:command|cmd|shell|code)?|run_?(?:command|cmd|shell|script|code)|subprocess|spawn|eval)(?:$|[_.\-\s])/i, why: 'runs arbitrary commands' },
  { category: 'k8s.delete', risk: 'critical', re: /(?:delete|remove|destroy|uninstall)[_.\-]?(?:namespace|pod|deployment|cluster|node|service|statefulset|daemonset|helm|release|k8s|kube)/i, why: 'deletes Kubernetes resources' },
  { category: 'k8s.scale', risk: 'high', re: /(?:scale|drain|cordon|restart)[_.\-]?(?:deployment|statefulset|replica|node|pod|cluster)/i, why: 'changes Kubernetes capacity' },
  { category: 'infra.destroy', risk: 'critical', re: /(?:terraform|tofu|pulumi|stack)[_.\-]?destroy|destroy[_.\-]?(?:stack|infra|environment)/i, why: 'destroys infrastructure' },
  { category: 'infra.apply', risk: 'high', re: /(?:terraform|tofu|pulumi)[_.\-]?(?:apply|up)|apply[_.\-]?(?:plan|terraform|infra)/i, why: 'applies infrastructure changes' },
  { category: 'iam.change', risk: 'critical', re: /(?:create|attach|put|update|delete|add|grant|revoke)[_.\-]?(?:iam|role|policy|permission|access[_.\-]?key|user[_.\-]?policy|binding)|(?:iam|role)[_.\-]?(?:create|attach|grant|update)/i, why: 'changes permissions' },
  { category: 'git.merge', risk: 'high', re: /merge[_.\-]?(?:pull[_.\-]?request|pr|branch)|(?:pull[_.\-]?request|pr)[_.\-]?merge/i, why: 'merges code' },
  { category: 'git.push', risk: 'high', re: /(?:push[_.\-]?(?:files?|commit|branch|code)|create[_.\-]?or[_.\-]?update[_.\-]?file|delete[_.\-]?(?:branch|file[_.\-]?from[_.\-]?repo)|force[_.\-]?push)/i, why: 'writes to a repository' },
  { category: 'release.publish', risk: 'high', re: /(?:create|publish)[_.\-]?(?:release|tag|package)|publish[_.\-]?(?:npm|pypi|image)/i, why: 'publishes a release' },
  { category: 'deploy', risk: 'high', re: /(?:^|[_.\-])(?:deploy|rollout|promote|rollback)(?:$|[_.\-])/i, why: 'deploys or rolls back' },
  { category: 'payment', risk: 'high', re: /(?:refund|payment|charge|payout|transfer[_.\-]?(?:funds|money)|send[_.\-]?money|invoice|subscription[_.\-]?cancel|issue[_.\-]?credit)/i, why: 'moves money' },
  { category: 'secrets.read', risk: 'high', re: /(?:get|read|fetch|list|export)[_.\-]?(?:secret|credential|password|token|api[_.\-]?key|env(?:ironment)?[_.\-]?var)|vault|secrets?[_.\-]?manager/i, why: 'reads secrets' },
  { category: 'db.destructive', risk: 'critical', re: /(?:drop|truncate|purge|wipe)[_.\-]?(?:table|database|db|collection|schema|index|cache)/i, why: 'drops data' },
  { category: 'db.write', risk: 'medium', re: /(?:execute|run)[_.\-]?(?:sql|query)|(?:sql|db|database)[_.\-]?(?:query|execute|write|update)|(?:insert|update|upsert|delete)[_.\-]?(?:row|record|document|item)s?/i, why: 'writes to a database' },
  { category: 'fs.delete', risk: 'high', re: /(?:delete|remove|unlink|rm)[_.\-]?(?:file|dir|directory|folder|path)/i, why: 'deletes files' },
  { category: 'fs.write', risk: 'medium', re: /(?:write|create|edit|save|overwrite|append|move|rename)[_.\-]?(?:file|dir|directory|folder)|(?:file|fs)[_.\-]?(?:write|edit)|str_replace|apply[_.\-]?patch/i, why: 'writes files' },
  { category: 'message.send', risk: 'medium', re: /(?:send|post|reply)[_.\-]?(?:email|mail|message|sms|text|slack|tweet|notification|dm)|(?:email|slack|sms)[_.\-]?send/i, why: 'sends a message to people' },
  { category: 'network.request', risk: 'medium', re: /(?:http|fetch|request|curl|browse|navigate|webhook|download|upload)(?:$|[_.\-])|(?:^|[_.\-])(?:get|fetch|open)[_.\-]?url/i, why: 'makes a network request' },
  { category: 'read', risk: 'low', re: /^(?:[\w-]+[_.\-])?(?:get|list|read|search|find|describe|view|show|query|lookup|fetch|retrieve|count|check|inspect|status)(?:$|[_.\-A-Z])/i, why: 'reads data' },
];

/** Catch-all for destructive verbs on things we don't recognise */
const DESTRUCTIVE_VERB = /(?:^|[_.\-])(?:delete|remove|destroy|drop|purge|terminate|wipe|kill|revoke|disable|reset|cancel)(?:$|[_.\-A-Z])/i;

/** Arguments that are executed as-is */
const EXEC_KEYS = /^(?:command|cmd|commands|script|shell|exec|run|sql|statement|stmt|argv)$/i;
/** Arguments that are often, but not always, executed */
const LOOSE_KEYS = /^(?:args|input|query|code|line)$/i;
const SECRET_KEYS = /(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|credential)/i;
/** Categories where "applies to everything" turns a mistake into an outage */
const DESTRUCTIVE_CATEGORIES = new Set<ActionCategory>(['fs.delete', 'db.destructive', 'k8s.delete', 'k8s.scale', 'infra.destroy', 'iam.change', 'git.push', 'shell.exec']);
const ENV_KEYS = /^(?:namespace|ns|env|environment|stage|cluster|context|kube_?context|branch|base|target|account|project|region|workspace|database|db|host|bucket)$/i;
const PROD_VALUE = /^(?:prod|production|prd|live|main|master|release)$|(?:^|[-_./:])(?:prod|production|prd)(?:$|[-_./:])/i;
const WILDCARD_VALUE = /^(?:\*|all|--all|-A|--all-namespaces|%|\.\*)$/i;
/** Commands that only read; a shell tool running nothing else is treated as a read */
const READ_COMMAND = /^(?:(?:kubectl|oc)\s+(?:get|describe|logs|top|explain|version|api-resources)\b|git\s+(?:status|log|diff|show|branch|remote|rev-parse)\b|(?:ls|cat|head|tail|grep|rg|find|pwd|echo|wc|which|whoami|date|env)\b|aws\s+\S+\s+(?:describe|list|get)-|(?:terraform|tofu)\s+(?:plan|show|output|validate|version)\b|(?:npm|pnpm|yarn)\s+(?:test|ls|outdated|run\s+(?:test|lint|build))\b|(?:pytest|go\s+test|cargo\s+test)\b|docker\s+(?:ps|images|logs|inspect)\b|helm\s+(?:list|status|get)\b)/i;
/** Target flags inside a command line: --context prod-eu-1, -n production, --profile=prod, -var env=prod */
const TARGET_FLAG = /(?:^|\s)(--context|--kube-context|--namespace|-n|--env|--environment|--stage|--cluster|--profile|--workspace|--project|--account|--target|-var\s+env)[=\s]+["']?([^\s"']+)/gi;

/** Base64 runs that decode to readable text: a common way to slip a command or a key past a scanner */
function decodeHidden(value: string): string[] {
  const out: string[] = [];
  for (const m of value.matchAll(/[A-Za-z0-9+/_-]{16,}={0,2}/g)) {
    if (out.length >= 5) break;
    try {
      // atob and TextDecoder, not Buffer: this engine also runs in the browser
      const bin = atob(m[0].replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, ''));
      const text = new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
      const printable = text.replace(/[^\x20-\x7e\n\t]/g, '').length;
      if (text.length >= 8 && printable / text.length > 0.95 && /[a-z]{3}/i.test(text) && text !== m[0]) out.push(text);
    } catch { /* not base64 */ }
  }
  return out;
}

/** SQL and shell comments hide keywords: "drop /* cleanup *\/ table" */
const stripComments = (value: string, sql: boolean) => {
  let v = value.replace(/\/\*[\s\S]*?\*\//g, ' ');
  if (sql) v = v.replace(/--[^\n]*/g, ' ');
  return v.replace(/\s+/g, ' ').trim();
};

/**
 * Variants of the arguments a disguise would hide: decoded base64, SQL without comments, and the top-level
 * values read as one command line ({ cmd: 'kubectl', args: ['delete', …] }). Checked like the originals.
 */
function disguises(args: Record<string, unknown> | undefined, strings: { path: string; key: string; value: string }[]) {
  const out: { path: string; key: string; value: string }[] = [];
  for (const s of strings) {
    for (const d of decodeHidden(s.value)) out.push({ path: `${s.path} (decoded)`, key: s.key, value: d });
    const sql = /^(?:query|sql|statement|stmt)$/i.test(s.key);
    if (/\/\*|--/.test(s.value)) {
      const clean = stripComments(s.value, sql);
      if (clean !== s.value.replace(/\s+/g, ' ').trim()) out.push({ path: s.path, key: s.key, value: clean });
    }
  }
  const top = args && typeof args === 'object' ? Object.values(args) : [];
  const parts = top.flatMap((v) => (typeof v === 'string' ? [v] : Array.isArray(v) && v.every((x) => typeof x === 'string') ? v as string[] : []));
  if (top.length > 1 && parts.length > 1) out.push({ path: 'args', key: 'args', value: parts.join(' ').slice(0, 4000) });
  return out;
}

function flattenStrings(v: unknown, path: string, out: { path: string; key: string; value: string }[], depth = 0) {
  if (depth > 6 || out.length > 200 || v == null) return;
  if (typeof v === 'string') { out.push({ path, key: path.split('.').pop() || '', value: v }); return; }
  if (typeof v === 'number' || typeof v === 'boolean') { out.push({ path, key: path.split('.').pop() || '', value: String(v) }); return; }
  if (Array.isArray(v)) {
    // argv arrays read as one command line too
    if (v.every((x) => typeof x === 'string')) out.push({ path, key: path.split('.').pop() || '', value: v.join(' ') });
    v.forEach((x, i) => flattenStrings(x, `${path}[${i}]`, out, depth + 1));
    return;
  }
  if (typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) flattenStrings(x, `${path}.${k}`, out, depth + 1);
}

/**
 * Scores one tool call. Combines what the tool is called, what its arguments would actually run,
 * where it points (production, wildcards) and anything sensitive inside the arguments.
 */
export function classifyAction(call: ToolCall, hints: ToolHints = {}): ClassifiedAction {
  const reasons: string[] = [];
  const findings: Finding[] = [];
  let category = 'unknown' as ActionCategory;
  let risk = 'medium' as RiskLevel;
  let decided = false;

  const set = (c: ActionCategory, r: RiskLevel, why: string) => {
    // Higher risk wins; at equal risk, knowing what a shell command does beats "it is a shell"
    const moreSpecific = riskRank(r) === riskRank(risk) && category === 'shell.exec' && c !== 'shell.exec';
    if (!decided || riskRank(r) > riskRank(risk) || moreSpecific) { category = c; risk = r; }
    decided = true;
    if (!reasons.includes(why)) reasons.push(why);
  };

  // What the tool is called. MCP names are often namespaced ("github.merge_pull_request"),
  // and camelCase is split so "deleteNamespace" reads like "delete_namespace".
  const name = call.name.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  for (const rule of NAME_RULES) {
    if (rule.re.test(name)) { set(rule.category, rule.risk, `tool name: ${rule.why}`); break; }
  }
  if (!decided && DESTRUCTIVE_VERB.test(name)) set('unknown', 'high', 'tool name uses a destructive verb');

  // What the arguments would actually run. This can outrank the name: a tool called
  // "run_command" whose argument is "kubectl delete ns prod" is a k8s.delete.
  const strings: { path: string; key: string; value: string }[] = [];
  flattenStrings(call.args, 'args', strings);
  strings.push(...disguises(call.args, strings));
  // A tool that runs things (or one we don't recognise) gets every argument checked; anything else only its
  // executable arguments, so a Slack message that mentions "kubectl delete" is not scored as a delete.
  const runsThings = !decided || category === 'shell.exec' || category === 'unknown' || category === 'db.write';
  const commandLike = strings.filter((s) => EXEC_KEYS.test(s.key) || (runsThings && (LOOSE_KEYS.test(s.key) || s.value.length > 12)));
  let commandHit = false;
  for (const s of commandLike) {
    for (const rule of COMMAND_RULES) {
      if (rule.re.test(s.value)) {
        commandHit = true;
        set(rule.category, rule.risk, `${s.path}: ${rule.why}`);
        if (rule.why.includes('download straight into a shell')) {
          findings.push({ kind: 'remote-code', detail: 'Runs code downloaded from the internet', severity: 'critical', owasp: LLM06, path: s.path });
        }
      }
    }
    if (/^(?:query|sql|statement|stmt)$/i.test(s.key) && SQL_WRITE.test(s.value) && riskRank(risk) < riskRank('medium')) {
      set('db.write', 'medium', `${s.path}: SQL that writes`);
    }
  }

  // A shell tool whose every command is plainly read-only (kubectl get, git status, terraform plan…) is a read
  if (category === 'shell.exec' && !commandHit) {
    const cmds = strings.filter((s) => EXEC_KEYS.test(s.key)).map((s) => s.value.trim());
    if (cmds.length && cmds.every((v) => READ_COMMAND.test(v) && !/[;&|`>]|\$\(/.test(v))) {
      category = 'read';
      risk = 'low';
      reasons.push('read-only command');
    }
  }

  // Where it points. Only matters for calls that change something: reading production is fine.
  const destructive = DESTRUCTIVE_CATEGORIES.has(category) || DESTRUCTIVE_VERB.test(name);
  const changesThings = destructive || (category !== 'read' && category !== 'unknown');
  if (changesThings) {
    // Either an argument such as { context: 'prod' }, or a flag inside a command: kubectl … --context prod-eu-1
    let prod: { key: string; value: string; path: string } | undefined = strings.find((s) => ENV_KEYS.test(s.key) && PROD_VALUE.test(s.value.trim()));
    if (!prod) {
      for (const s of commandLike) {
        TARGET_FLAG.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = TARGET_FLAG.exec(s.value))) {
          if (PROD_VALUE.test(m[2])) { prod = { key: m[1], value: m[2], path: s.path }; break; }
        }
        if (prod) break;
      }
    }
    if (prod) {
      findings.push({ kind: 'prod-target', detail: `Targets production (${prod.key}=${prod.value.slice(0, 40)})`, severity: 'high', owasp: LLM06, path: prod.path });
      risk = bumpRisk(risk);
      reasons.push('targets production');
    }
  }
  if (destructive) {
    const all = strings.find((s) => WILDCARD_VALUE.test(s.value.trim()) || /\s(?:--all|-A|--all-namespaces)\b/.test(s.value));
    if (all) {
      findings.push({ kind: 'wildcard', detail: `Applies to everything (${all.key}=${all.value.slice(0, 40)})`, severity: 'critical', owasp: LLM06, path: all.path });
      risk = 'critical';
      reasons.push('applies to everything at once');
    }
  }

  // What it carries
  for (const s of strings) {
    if (SECRET_KEYS.test(s.key) && s.value.length >= 8 && !/^\[REDACTED/.test(s.value)) {
      findings.push({ kind: 'secret', detail: `Credential passed as "${s.key}": ${redactSample(s.value)}`, severity: 'high', owasp: LLM02, path: s.path });
    }
    for (const f of scanText(s.value, s.path)) {
      // An email address inside a "send_email" call is expected, not a leak
      if (f.kind === 'pii' && f.severity === 'low' && category === 'message.send') continue;
      findings.push(f);
    }
  }
  if (!findings.some((f) => f.kind === 'secret')) {
    // A key split over neighbouring arguments ("sk_live_Dm0F" + "x8Qp…"): every detector needs a distinctive prefix
    const values = strings.filter((s) => !s.path.endsWith('(decoded)') && s.path !== 'args').map((s) => s.value);
    for (let i = 0; i + 1 < values.length && !findings.some((f) => f.kind === 'secret'); i++) {
      for (const n of [2, 3]) {
        const joined = values.slice(i, i + n).join('');
        const hit = scanText(joined.slice(0, 2000), 'args').find((f) => f.kind === 'secret');
        if (hit && !values.slice(i, i + n).some((v) => scanText(v).some((f) => f.kind === 'secret'))) {
          findings.push({ ...hit, detail: `Credential split across arguments: ${hit.detail}` });
          break;
        }
      }
    }
  }
  if (findings.some((f) => f.kind === 'secret')) { risk = maxRisk(risk, 'high'); reasons.push('arguments contain a credential'); }
  if (category === 'network.request' && findings.some((f) => f.kind === 'secret' || f.kind === 'pii')) {
    findings.push({ kind: 'exfil', detail: 'Sends sensitive data over the network', severity: 'critical', owasp: LLM02 });
    risk = 'critical';
  }
  const longBlob = strings.find((s) => category === 'network.request' && /^[A-Za-z0-9+/=_-]{400,}$/.test(s.value));
  if (longBlob) {
    findings.push({ kind: 'exfil', detail: 'Sends a large encoded blob over the network', severity: 'high', owasp: LLM02, path: longBlob.path });
    risk = maxRisk(risk, 'high');
  }

  // What the tool says about itself (MCP annotations). Trusted to raise risk, only half-trusted to lower it.
  if (hints.destructiveHint === true && riskRank(risk) < riskRank('high')) { risk = 'high'; reasons.push('tool declares itself destructive'); }
  if (hints.readOnlyHint === true && !decided && findings.length === 0) { category = 'read'; risk = 'low'; reasons.push('tool declares itself read-only'); }
  else if (hints.readOnlyHint === true && category === 'unknown') { risk = lowerRisk(risk); }

  if (!decided && !reasons.length) reasons.push('unrecognised tool');
  return { ...call, category, risk, reasons, findings };
}

// ─── 4. Decide with deterministic action policies ────────────────────────────

function globToRegex(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`, 'i');
}

/** True when every condition the policy sets matches. A policy with no conditions matches nothing. */
export function matchesActionPolicy(policy: ActionPolicy, action: ClassifiedAction, agent: string | null | undefined = (action as ObservedAction).agentName): boolean {
  const m = policy.match;
  if (!m) return false;
  if (isExcepted(policy, action.name, agent)) return false;
  let any = false;
  if (m.categories?.length) { any = true; if (!m.categories.includes(action.category)) return false; }
  if (m.tools?.length) { any = true; if (!m.tools.some((g) => globToRegex(g).test(action.name))) return false; }
  if (m.minRisk) { any = true; if (riskRank(action.risk) < riskRank(m.minRisk)) return false; }
  if (m.findings?.length) { any = true; if (!action.findings.some((f) => m.findings!.includes(f.kind))) return false; }
  if (m.argPattern) {
    any = true;
    if (!isSafePattern(m.argPattern)) return false;
    let re: RegExp;
    try { re = new RegExp(m.argPattern, 'i'); } catch { return false; }
    // Bounded input: a pattern is only ever run over the first 4,000 characters of the arguments
    if (!re.test(safeJson(action.args ?? {}).slice(0, 4000))) return false;
  }
  return any;
}

/**
 * Rejects patterns that can backtrack catastrophically, such as (a+)+, (a*)*, (a|a)+ or (.*)*: a quantified group
 * whose body can itself repeat. One bad policy must not be able to stall every action check.
 */
export function isSafePattern(pattern: string): boolean {
  if (typeof pattern !== 'string' || pattern.length > 200) return false;
  try { new RegExp(pattern); } catch { return false; }
  // Strip escapes and character classes, then look for a group with a quantifier inside that is itself quantified
  const flat = pattern.replace(/\\./g, 'x').replace(/\[[^\]]*\]/g, 'x');
  const stack: { hasRepeat: boolean; hasAlt: boolean }[] = [];
  for (let i = 0; i < flat.length; i++) {
    const ch = flat[i];
    if (ch === '(') { stack.push({ hasRepeat: false, hasAlt: false }); continue; }
    if (ch === '|' && stack.length) { stack[stack.length - 1].hasAlt = true; continue; }
    if ((ch === '*' || ch === '+' || ch === '{') && stack.length) stack[stack.length - 1].hasRepeat = true;
    if (ch === ')') {
      const g = stack.pop();
      const next = flat[i + 1];
      const quantified = next === '*' || next === '+' || next === '{' || (next === '?' && false);
      if (g && quantified && (g.hasRepeat || g.hasAlt)) return false;
      if (g?.hasRepeat && stack.length) stack[stack.length - 1].hasRepeat = true;
    }
  }
  return true;
}

export function appliesToAgent(policy: ActionPolicy, agent: string | null | undefined): boolean {
  if (!policy.assignedAgents || policy.assignedAgents.length === 0) return true;
  return !!agent && policy.assignedAgents.includes(agent);
}

/** The strictest verdict among the action policies that match. No match means allow. */
export function decideAction(action: ClassifiedAction, policies: ActionPolicy[], agent?: string | null): ActionDecision {
  let best: ActionDecision = { verdict: 'allow', reasons: [] };
  for (const p of policies) {
    if (p.kind !== 'action' || !appliesToAgent(p, agent) || !matchesActionPolicy(p, action, agent)) continue;
    const v = policyActionToVerdict(p.action);
    if (verdictRank(v) > verdictRank(best.verdict)) {
      best = { verdict: v, policy: { policyId: p.policyId, name: p.name }, reasons: [`matched policy "${p.name}"`] };
    }
  }
  return best;
}

// ─── 5. Suggest policies from what shadow mode saw, and replay them ──────────

export interface ObservedAction extends ClassifiedAction {
  actionId?: string;
  agentName?: string | null;
  timestamp?: string;
  /** What policy said when it was recorded */
  verdict?: Verdict;
  source?: ActionSource;
  outcome?: 'ok' | 'error';
}

export interface PolicySuggestion {
  policy: ActionPolicy & { kind: 'action'; match: ActionPolicyMatch };
  why: string;
  /** Replay over the observed window */
  replay: PolicyReplay;
}

/** One call a policy would have caught, enough to show it next to the policy */
export interface ActionSample { id: string; timestamp: string; agent: string | null; tool: string; risk: RiskLevel; wouldBe?: Verdict; detail?: string }

export interface PolicyReplay { matched: number; agents: string[]; sampleActionIds: string[]; samples: ActionSample[] }

/** A tool an agent can reach: listed by an MCP server, offered to the model in a request, or wrapped with wrapTool */
export interface Capability {
  agent: string;
  tool: string;
  source: ActionSource;
  /** The MCP server that listed it */
  server?: string;
  description?: string;
  hints?: ToolHints;
  firstSeen: string;
  lastSeen?: string;
}

const CATEGORY_LABEL: Record<ActionCategory, string> = {
  'shell.exec': 'shell commands', 'fs.delete': 'file deletion', 'fs.write': 'file writes',
  'db.destructive': 'destructive database operations', 'db.write': 'database writes',
  'k8s.delete': 'Kubernetes deletes', 'k8s.scale': 'Kubernetes scaling and restarts', 'k8s.exec': 'Kubernetes exec',
  'git.merge': 'merges', 'git.push': 'pushes to repositories', 'release.publish': 'publishing releases', deploy: 'deploys',
  'iam.change': 'permission changes', 'infra.apply': 'infrastructure applies', 'infra.destroy': 'infrastructure destroys',
  payment: 'payments and refunds', 'message.send': 'outbound messages', 'secrets.read': 'reading secrets',
  'network.request': 'network requests', read: 'reads', unknown: 'unrecognised tools',
};

/** Replays any action policy over observed actions: what it would have caught */
export function replayPolicy(policy: ActionPolicy, actions: ObservedAction[]): PolicyReplay {
  const hits = actions.filter((a) => appliesToAgent(policy, a.agentName) && matchesActionPolicy(policy, a));
  // The riskiest first, so the samples are the calls worth reading
  const shown = [...hits].sort((a, b) => riskRank(b.risk) - riskRank(a.risk) || (b.timestamp ?? '').localeCompare(a.timestamp ?? '')).slice(0, 5);
  return {
    matched: hits.length,
    agents: [...new Set(hits.map((a) => a.agentName || 'unknown'))],
    sampleActionIds: shown.map((a) => a.actionId || a.id || '').filter(Boolean),
    samples: shown.map(toSample),
  };
}

function toSample(a: ObservedAction): ActionSample {
  const detail = a.findings?.[0]?.detail || a.reasons?.[0];
  return { id: a.actionId || a.id || '', timestamp: a.timestamp ?? '', agent: a.agentName ?? null, tool: a.name, risk: a.risk, ...(a.verdict ? { wouldBe: a.verdict } : {}), ...(detail ? { detail } : {}) };
}

/**
 * Where a call went: hosts it contacted, repositories, environments and namespaces it named.
 * Read from the (already redacted) arguments, so it never needs the source code.
 */
export function destinationsOf(args: Record<string, unknown> | undefined): string[] {
  const out = new Set<string>();
  const text = safeJson(args ?? {});
  for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) out.add(m[1].toLowerCase());
  const a = (args ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.length <= 80 ? v : '');
  if (str(a.owner) && str(a.repo)) out.add(`${str(a.owner)}/${str(a.repo)}`);
  else if (str(a.repo) && str(a.repo).includes('/')) out.add(str(a.repo));
  for (const k of ['env', 'environment', 'context', 'namespace', 'workspace', 'cluster', 'table', 'database']) if (str(a[k])) out.add(`${k}:${str(a[k])}`);
  for (const m of text.matchAll(/--(context|namespace)[= ]([a-z0-9._-]+)|\s-n ([a-z0-9._-]+)/gi)) out.add(m[1] ? `${m[1].toLowerCase()}:${m[2]}` : `namespace:${m[3]}`);
  return [...out].slice(0, 20);
}

/**
 * What each agent can reach, next to what it actually used. A risky tool that was listed but never called is the
 * blind spot of a shadow window: nothing happened, so nothing was learned, but the agent could still call it.
 */
export function capabilityMap(capabilities: Capability[], actions: ObservedAction[]) {
  const agents = new Map<string, Map<string, { tool: string; source: ActionSource; server?: string; description?: string; category: ActionCategory; risk: RiskLevel; listed: boolean; used: number; lastUsed?: string; firstSeen?: string }>>();
  const row = (agent: string) => { if (!agents.has(agent)) agents.set(agent, new Map()); return agents.get(agent)!; };
  for (const c of capabilities) {
    const k = classifyAction({ name: c.tool, args: {} }, c.hints ?? {});
    row(c.agent || 'unknown').set(c.tool, { tool: c.tool, source: c.source, server: c.server, description: c.description, category: k.category, risk: k.risk, listed: true, used: 0, firstSeen: c.firstSeen });
  }
  for (const a of actions) {
    const tools = row(a.agentName || 'unknown');
    const t = tools.get(a.name) ?? { tool: a.name, source: a.source ?? 'sdk', category: a.category, risk: 'none' as RiskLevel, listed: false, used: 0 };
    t.used += 1;
    if (riskRank(a.risk) > riskRank(t.risk)) t.risk = a.risk;
    if (!t.lastUsed || (a.timestamp ?? '') > t.lastUsed) t.lastUsed = a.timestamp;
    tools.set(a.name, t);
  }
  return [...agents.entries()].map(([agent, tools]) => {
    const list = [...tools.values()].sort((a, b) => Number(a.used > 0) - Number(b.used > 0) || riskRank(b.risk) - riskRank(a.risk) || b.used - a.used || a.tool.localeCompare(b.tool));
    const unused = list.filter((t) => t.listed && t.used === 0);
    return {
      agent,
      tools: list,
      listed: list.filter((t) => t.listed).length,
      used: list.filter((t) => t.used > 0).length,
      neverUsed: unused.length,
      unusedHighRisk: unused.filter((t) => riskRank(t.risk) >= riskRank('high')).map((t) => t.tool),
    };
  }).sort((a, b) => b.unusedHighRisk.length - a.unusedHighRisk.length || a.agent.localeCompare(b.agent));
}

/**
 * Drafts action policies from observed behaviour. Deterministic and explainable: every draft says why,
 * and comes with a replay over the same window so the human sees exactly what it would have caught.
 * Policies that already cover a pattern are skipped.
 */
export function suggestPolicies(actions: ObservedAction[], existing: ActionPolicy[] = [], capabilities: Capability[] = []): PolicySuggestion[] {
  const out: PolicySuggestion[] = [];
  // Mostly caught already (by a policy in place or a broader suggestion above it): not worth another policy
  const caughtBy = (pols: ActionPolicy[], a: ObservedAction) => pols.some((p) => appliesToAgent(p, a.agentName) && matchesActionPolicy(p, a));
  const add = (policy: PolicySuggestion['policy'], why: string) => {
    const hits = actions.filter((a) => appliesToAgent(policy, a.agentName) && matchesActionPolicy(policy, a));
    if (!hits.length) return;
    const inPlace = existing.filter((p) => p.kind === 'action');
    if (hits.some((a) => caughtBy(inPlace, a))) return;
    const already = hits.filter((a) => caughtBy(out.map((o) => o.policy), a)).length;
    if (already / hits.length >= 0.8) return;
    out.push({ policy, why, replay: replayPolicy(policy, actions) });
  };

  // Credentials in tool arguments are never fine
  add({ kind: 'action', name: 'Block tool calls that carry credentials', action: 'block', severity: 'critical', match: { findings: ['secret'] } },
    'Agents passed API keys or passwords as tool arguments. Anything logging or receiving those arguments now holds the credential.');
  add({ kind: 'action', name: 'Block sending sensitive data out', action: 'block', severity: 'critical', match: { findings: ['exfil'] } },
    'Network calls carried credentials, personal data or large encoded payloads.');
  add({ kind: 'action', name: 'Block running downloaded scripts', action: 'block', severity: 'critical', match: { findings: ['remote-code'] } },
    'An agent piped a download straight into a shell.');
  add({ kind: 'action', name: 'Hold actions that target production', action: 'ask_admin', severity: 'high', match: { findings: ['prod-target'], minRisk: 'high' } },
    'High-risk actions pointed at production. A person should confirm those.');
  add({ kind: 'action', name: 'Hold actions that apply to everything at once', action: 'ask_admin', severity: 'critical', match: { findings: ['wildcard'] } },
    'Actions used wildcards or --all, so one mistake hits every resource.');

  // One per risky category actually used
  const byCat = new Map<ActionCategory, ObservedAction[]>();
  for (const a of actions) {
    if (riskRank(a.risk) < riskRank('high')) continue;
    byCat.set(a.category, [...(byCat.get(a.category) ?? []), a]);
  }
  for (const [cat, list] of [...byCat.entries()].sort((x, y) => y[1].length - x[1].length)) {
    const critical = list.some((a) => a.risk === 'critical');
    const agents = [...new Set(list.map((a) => a.agentName).filter(Boolean))] as string[];
    add({
      kind: 'action',
      name: `${critical ? 'Require approval for' : 'Flag'} ${CATEGORY_LABEL[cat]}`,
      action: critical ? 'ask_admin' : 'warn',
      severity: critical ? 'critical' : 'high',
      match: { categories: [cat], minRisk: 'high' },
      assignedAgents: agents.length && agents.length <= 3 ? agents : [],
    }, `${list.length} high-risk call${list.length === 1 ? '' : 's'} in ${CATEGORY_LABEL[cat]}${agents.length ? ` from ${agents.join(', ')}` : ''}.`);
  }

  // Risky tools an agent can reach but never used: holding them costs nothing today and closes the blind spot
  const inPlace = [...existing.filter((p) => p.kind === 'action'), ...out.map((o) => o.policy)];
  for (const { agent, tools } of capabilityMap(capabilities, actions)) {
    const unused = tools.filter((t) => t.listed && t.used === 0 && riskRank(t.risk) >= riskRank('high'))
      .filter((t) => !inPlace.some((p) => appliesToAgent(p, agent) && matchesActionPolicy(p, { name: t.tool, args: {}, category: t.category, risk: t.risk, reasons: [], findings: [] })));
    if (!unused.length || agent === 'unknown') continue;
    const policy: PolicySuggestion['policy'] = {
      kind: 'action', name: `Hold unused risky tools for ${agent}`, action: 'ask_admin', severity: 'high',
      match: { tools: unused.map((t) => t.tool) }, assignedAgents: [agent],
    };
    out.push({
      policy,
      why: `${agent} can call ${unused.map((t) => t.tool).join(', ')} but never did in this window, so shadow mode learned nothing about ${unused.length === 1 ? 'it' : 'them'}. Holding ${unused.length === 1 ? 'it' : 'them'} for approval changes nothing today.`,
      replay: replayPolicy(policy, actions),
    });
  }
  return out;
}

// ─── 6. Summarise a window of observed actions (the shadow report) ───────────

const DAY_MS = 86_400_000;

function countBy<T>(xs: T[], key: (x: T) => string): [string, number][] {
  const m = new Map<string, number>();
  for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * Everything the shadow report shows, from a list of observed actions: what agents did, what policy would have
 * done, the riskiest calls, tools that appeared late in the window, a replay of the policies already in place,
 * and drafted policies. Pure, so the API and the console's demo mode build the same report.
 */
/**
 * One entry per tool call. When the model asks for a tool (source "llm") and the app then runs it through wrapTool
 * or the MCP proxy, both are recorded; counting both doubled every number. The model's request is dropped when the
 * same agent ran the same tool with the same arguments within two minutes. A request that was never run (blocked at
 * the model stage, or ignored by the app) still counts.
 */
export function dedupeActions(actions: ObservedAction[]): ObservedAction[] {
  const key = (a: ObservedAction) => `${a.agentName || ''}\u0000${a.name}\u0000${safeJson(a.args ?? {})}`;
  const runs = new Map<string, number[]>();
  for (const a of actions) {
    if (a.source === 'llm') continue;
    const k = key(a);
    runs.set(k, [...(runs.get(k) ?? []), Date.parse(a.timestamp ?? '') || 0]);
  }
  return actions.filter((a) => {
    if (a.source !== 'llm') return true;
    const t = Date.parse(a.timestamp ?? '') || 0;
    return !(runs.get(key(a)) ?? []).some((r) => r >= t - 1000 && r - t <= 120_000);
  });
}

/**
 * Authority Replay (issue #12): what draft policies would have done to recorded traffic, next to what the policies in
 * place did. Pure and read-only, so it never touches production: nothing is blocked, held or written.
 */
export function replayDrafts(allActions: ObservedAction[], current: ActionPolicy[], drafts: ActionPolicy[]) {
  const actions = dedupeActions(allActions);
  const order: Verdict[] = ['allow', 'warn', 'review', 'block'];
  const both = [...current, ...drafts];
  const empty = (): Record<Verdict, number> => ({ allow: 0, warn: 0, review: 0, block: 0 });
  const before = empty(), after = empty();
  const days = new Set<string>();
  const heldByDay = { before: new Map<string, number>(), after: new Map<string, number>() };
  const flows = new Map<string, { agent: string; tool: string; calls: number; verdict: Verdict; policy?: string; sample: ActionSample[] }>();
  let changed = 0;
  for (const a of actions) {
    const day = (a.timestamp ?? '').slice(0, 10);
    days.add(day);
    const b = decideAction(a, current, a.agentName).verdict;
    const d = decideAction(a, both, a.agentName);
    before[b]++;
    after[d.verdict]++;
    if (b === 'review') heldByDay.before.set(day, (heldByDay.before.get(day) ?? 0) + 1);
    if (d.verdict === 'review') heldByDay.after.set(day, (heldByDay.after.get(day) ?? 0) + 1);
    if (order.indexOf(d.verdict) > order.indexOf(b)) {
      changed++;
      // A workflow that would break: an agent's tool that ran before and would now be held or denied
      if (d.verdict === 'review' || d.verdict === 'block') {
        const k = `${a.agentName || 'unknown'}\u0000${a.name}\u0000${d.verdict}`;
        const f = flows.get(k) ?? { agent: a.agentName || 'unknown', tool: a.name, calls: 0, verdict: d.verdict, policy: d.policy?.name, sample: [] };
        f.calls++;
        if (f.sample.length < 3) f.sample.push(toSample(a));
        flows.set(k, f);
      }
    }
  }
  const nDays = Math.max(1, days.size);
  return {
    actions: actions.length,
    days: days.size,
    before, after, changed,
    approvalsPerDay: { before: (before.review / nDays), after: (after.review / nDays), peakAfter: Math.max(0, ...heldByDay.after.values()) },
    workflows: [...flows.values()].sort((x, y) => (x.verdict === y.verdict ? y.calls - x.calls : x.verdict === 'block' ? -1 : 1)).slice(0, 50),
    drafts: drafts.map((p) => ({ name: p.name, action: p.action, ...replayPolicy(p, actions) })),
  };
}

export function summarizeActions(allActions: ObservedAction[], policies: ActionPolicy[], window: { start: string; end: string }, capabilities: Capability[] = []) {
  const actions = dedupeActions(allActions);
  // What the policies in place NOW would do: the headline must change when a policy is adopted
  const now = new Map(actions.map((a) => [a, decideAction(a, policies, a.agentName).verdict]));
  const order: Verdict[] = ['allow', 'warn', 'review', 'block'];
  const verdict = (a: ObservedAction): Verdict => {
    const v = now.get(a) ?? 'allow', r = a.verdict ?? 'allow';
    return order.indexOf(v) >= order.indexOf(r) ? v : r;
  };
  const agents = countBy(actions, (a) => a.agentName || 'unknown');

  // A tool an agent first used in the last 24 h of a window that has run at least 2 days is worth a look
  const firstSeen = new Map<string, string>();
  for (const a of [...actions].sort((x, y) => (x.timestamp ?? '').localeCompare(y.timestamp ?? ''))) {
    const k = `${a.agentName || 'unknown'}\u0000${a.name}`;
    if (!firstSeen.has(k)) firstSeen.set(k, a.timestamp ?? '');
  }
  const endMs = Date.parse(window.end);
  const newTools = endMs - Date.parse(window.start) >= 2 * DAY_MS
    ? [...firstSeen.entries()]
        .filter(([, t]) => endMs - Date.parse(t) < DAY_MS)
        .map(([k, t]) => { const [agent, tool] = k.split('\u0000'); return { agent, tool, firstSeen: t }; })
    : [];

  return {
    window,
    totals: {
      actions: actions.length,
      agents: agents.length,
      tools: new Set(actions.map((a) => a.name)).size,
      highRisk: actions.filter((a) => a.risk === 'high').length,
      critical: actions.filter((a) => a.risk === 'critical').length,
      wouldBlock: actions.filter((a) => verdict(a) === 'block').length,
      wouldReview: actions.filter((a) => verdict(a) === 'review').length,
      wouldWarn: actions.filter((a) => verdict(a) === 'warn').length,
      failed: actions.filter((a) => a.outcome === 'error').length,
    },
    byCategory: countBy(actions, (a) => a.category).map(([category, n]) => ({
      category, count: n, highRisk: actions.filter((a) => a.category === category && riskRank(a.risk) >= riskRank('high')).length,
    })),
    byAgent: agents.map(([agent, n]) => {
      const mine = actions.filter((a) => (a.agentName || 'unknown') === agent);
      const maxRisk = (tool: string) => mine.filter((a) => a.name === tool).reduce<RiskLevel>((r, a) => (riskRank(a.risk) > riskRank(r) ? a.risk : r), 'none');
      return {
        agent, count: n, critical: mine.filter((a) => a.risk === 'critical').length,
        tools: countBy(mine, (a) => a.name).slice(0, 50).map(([tool, c]) => ({ tool, count: c, risk: maxRisk(tool) })),
        destinations: countBy(mine.flatMap((a) => destinationsOf(a.args)), (d) => d).slice(0, 20).map(([destination, c]) => ({ destination, count: c })),
      };
    }),
    findings: countBy(actions.flatMap((a) => a.findings ?? []), (f) => f.kind).map(([kind, n]) => ({ kind, count: n })),
    newTools,
    riskiest: [...actions]
      .sort((a, b) => riskRank(b.risk) - riskRank(a.risk) || (b.timestamp ?? '').localeCompare(a.timestamp ?? ''))
      .slice(0, 25)
      .map((a) => ({
        id: a.actionId ?? a.id ?? '', timestamp: a.timestamp ?? '', agent: a.agentName ?? null, tool: a.name, source: a.source,
        category: a.category, risk: a.risk, reasons: a.reasons, findings: a.findings, wouldBe: verdict(a), outcome: a.outcome,
      })),
    policyReplay: policies.filter((p) => p.kind === 'action').map((p) => ({ policyId: p.policyId, name: p.name, action: p.action, ...replayPolicy(p, actions) })),
    suggestions: suggestPolicies(actions, policies, capabilities),
    capabilities: capabilityMap(capabilities, actions),
  };
}
