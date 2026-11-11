/**
 * leap360 — build-time scanner
 *
 * Answers one question before code ships: what can the AI in this project actually do?
 *
 *   1. Finds every function handed to an AI as a tool: Vercel AI SDK / OpenAI Agents `tool()`, OpenAI and Anthropic
 *      tool schemas, LangChain tools, MCP servers (`server.tool`, `registerTool`), Mastra `createTool`,
 *      and `leap.wrapTool` (already governed). Python: `@tool`, `@function_tool`, `@mcp.tool()` (basic support).
 *   2. Follows each tool's code, across functions and local imports, to the calls that matter: shell, file
 *      deletion, SQL, Kubernetes, AWS, GitHub, payments, outbound messages, network.
 *   3. Scores each tool, flags the ones Leap360 does not govern, drafts action policies, and compares against a
 *      baseline so a pull request that gives an agent a new dangerous ability is caught before it merges.
 *
 * Node only (reads files). Uses @babel/parser for JavaScript and TypeScript, so it reads code, not text.
 */

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { parse } from '@babel/parser';
import { classifyAction, riskRank, type ActionCategory, type ActionPolicy, type RiskLevel } from './actions.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Sink {
  category: ActionCategory;
  risk: RiskLevel;
  /** The call as written, e.g. "k8sApi.deleteNamespace" */
  call: string;
  why: string;
  file: string;
  line: number;
  /** Functions between the tool and this call */
  via: string[];
  /** Not found in code: inferred from the tool's name because its implementation could not be followed */
  inferred?: boolean;
}

export interface ScannedTool {
  name: string;
  framework: string;
  file: string;
  line: number;
  /** Runs behind leap.wrapTool: every call is checked and recorded */
  governed: boolean;
  /** The implementation was found and followed */
  resolved: boolean;
  risk: RiskLevel;
  categories: ActionCategory[];
  sinks: Sink[];
}

export interface BaselineDiff {
  newTools: { name: string; risk: RiskLevel; categories: ActionCategory[] }[];
  newAbilities: { name: string; categories: ActionCategory[] }[];
  riskIncreases: { name: string; from: RiskLevel; to: RiskLevel }[];
  removedTools: string[];
}

export interface ScanReport {
  root: string;
  filesScanned: number;
  parseErrors: { file: string; message: string }[];
  tools: ScannedTool[];
  summary: { tools: number; critical: number; high: number; medium: number; low: number; ungoverned: number; ungovernedAtRisk: number };
  suggestions: ActionPolicy[];
  baseline?: BaselineDiff;
}

export interface ScanOptions {
  /** Extra directory names to skip */
  ignore?: string[];
  /** Stop after this many files (default 5000) */
  maxFiles?: number;
}

// ─── Files ──────────────────────────────────────────────────────────────────

const JS_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.svelte-kit', '.turbo', '.vercel', '.cache', '.venv', 'venv', '__pycache__', '.leap360', 'vendor', 'target']);
const MAX_FILE_BYTES = 1_000_000;

function listFiles(root: string, opts: ScanOptions): string[] {
  const skip = new Set([...SKIP_DIRS, ...(opts.ignore ?? [])]);
  const out: string[] = [];
  const max = opts.maxFiles ?? 5000;
  const walkDir = (dir: string) => {
    if (out.length >= max) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (out.length >= max) return;
      const full = path.join(dir, e);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        if (!skip.has(e) && !e.startsWith('.')) walkDir(full);
      } else if (st.size <= MAX_FILE_BYTES) {
        const ext = path.extname(e);
        if (JS_EXT.has(ext) && !e.endsWith('.d.ts') && !/\.min\.js$/.test(e)) out.push(full);
        else if (ext === '.py') out.push(full);
      }
    }
  };
  walkDir(root);
  return out;
}

// ─── AST helpers ────────────────────────────────────────────────────────────

type Node = any;

const SKIP_KEYS = new Set(['loc', 'start', 'end', 'leadingComments', 'trailingComments', 'innerComments', 'extra', 'range', 'typeAnnotation', 'returnType', 'typeParameters']);

function walk(node: Node, visit: (n: Node, parent: Node | null) => void | false, parent: Node | null = null) {
  if (!node || typeof node.type !== 'string') return;
  if (visit(node, parent) === false) return;
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const v = node[key];
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') walk(c, visit, node); }
    else if (v && typeof v.type === 'string') walk(v, visit, node);
  }
}

const isFn = (n: Node) => n && (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration' || n.type === 'ObjectMethod' || n.type === 'ClassMethod');

/** "a.b.c" for a member chain, "new X" for constructors, the identifier otherwise */
function calleeText(n: Node): string {
  if (!n) return '';
  switch (n.type) {
    case 'Identifier': return n.name;
    case 'ThisExpression': return 'this';
    case 'MemberExpression':
    case 'OptionalMemberExpression': {
      const prop = n.computed ? (n.property.type === 'StringLiteral' ? n.property.value : '[]') : n.property.name;
      return `${calleeText(n.object)}.${prop}`;
    }
    case 'CallExpression':
    case 'OptionalCallExpression': return `${calleeText(n.callee)}()`;
    case 'AwaitExpression': return calleeText(n.argument);
    case 'TSNonNullExpression': return calleeText(n.expression);
    default: return '';
  }
}

/** The literal text of a string or template argument, with ${…} shown as … */
function literalText(n: Node): string | null {
  if (!n) return null;
  if (n.type === 'StringLiteral') return n.value;
  if (n.type === 'TemplateLiteral') return n.quasis.map((q: Node) => q.value.cooked ?? q.value.raw).join('…');
  if (n.type === 'TaggedTemplateExpression') return literalText(n.quasi);
  return null;
}

const propName = (p: Node): string | null =>
  p && (p.type === 'ObjectProperty' || p.type === 'ObjectMethod')
    ? (p.key.type === 'Identifier' ? p.key.name : p.key.type === 'StringLiteral' ? p.key.value : null)
    : null;

function getProp(obj: Node, name: string): Node | null {
  if (!obj || obj.type !== 'ObjectExpression') return null;
  for (const p of obj.properties) {
    if (propName(p) === name) return p.type === 'ObjectMethod' ? p : p.value;
  }
  return null;
}

const strValue = (n: Node): string | null => (n?.type === 'StringLiteral' ? n.value : n?.type === 'TemplateLiteral' && n.expressions.length === 0 ? n.quasis[0].value.cooked : null);

// ─── Per-file index ─────────────────────────────────────────────────────────

interface FileIndex {
  file: string;
  ast: Node;
  /** Top-level and nested named functions */
  fns: Map<string, Node>;
  /** local name → import source and imported name ('*' for namespace, 'default') */
  imports: Map<string, { source: string; imported: string }>;
}

const parsed = new Map<string, FileIndex | null>();

function indexFile(file: string, errors: ScanReport['parseErrors']): FileIndex | null {
  if (parsed.has(file)) return parsed.get(file)!;
  let code: string;
  try { code = readFileSync(file, 'utf8'); } catch { parsed.set(file, null); return null; }
  const ext = path.extname(file);
  const ts = ext === '.ts' || ext === '.mts' || ext === '.cts' || ext === '.tsx';
  const jsx = ext !== '.ts' && ext !== '.mts' && ext !== '.cts';
  let ast: Node;
  try {
    ast = parse(code, {
      sourceType: 'unambiguous',
      errorRecovery: true,
      allowReturnOutsideFunction: true,
      plugins: [...(ts ? ['typescript' as const] : []), ...(jsx ? ['jsx' as const] : []), 'decorators-legacy', 'topLevelAwait', 'importAttributes'] as any,
    });
  } catch (err: any) {
    errors.push({ file, message: String(err?.message ?? err).slice(0, 200) });
    parsed.set(file, null);
    return null;
  }
  const fns = new Map<string, Node>();
  const imports = new Map<string, { source: string; imported: string }>();
  walk(ast, (n) => {
    if (n.type === 'ImportDeclaration') {
      for (const s of n.specifiers) {
        const imported = s.type === 'ImportNamespaceSpecifier' ? '*' : s.type === 'ImportDefaultSpecifier' ? 'default' : (s.imported?.name ?? s.imported?.value);
        imports.set(s.local.name, { source: n.source.value, imported });
      }
    } else if (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier') {
      // const { exec } = require('child_process')  /  const cp = require('child_process')
      const init = n.init?.type === 'AwaitExpression' ? n.init.argument : n.init;
      if (init?.type === 'CallExpression' && init.callee?.name === 'require' && strValue(init.arguments[0])) {
        imports.set(n.id.name, { source: strValue(init.arguments[0])!, imported: '*' });
      }
      if (isFn(n.init)) fns.set(n.id.name, n.init);
    } else if (n.type === 'VariableDeclarator' && n.id?.type === 'ObjectPattern' && n.init?.type === 'CallExpression' && n.init.callee?.name === 'require') {
      const source = strValue(n.init.arguments[0]);
      if (source) for (const p of n.id.properties) if (p.type === 'ObjectProperty' && p.value?.type === 'Identifier') imports.set(p.value.name, { source, imported: propName(p) ?? p.value.name });
    } else if (n.type === 'FunctionDeclaration' && n.id) {
      fns.set(n.id.name, n);
    } else if ((n.type === 'ClassMethod' || n.type === 'ObjectMethod') && n.key?.type === 'Identifier' && !fns.has(n.key.name)) {
      fns.set(n.key.name, n);
    } else if (n.type === 'ObjectProperty' && isFn(n.value) && propName(n) && !fns.has(propName(n)!)) {
      fns.set(propName(n)!, n.value);
    }
  });
  const idx = { file, ast, fns, imports };
  parsed.set(file, idx);
  return idx;
}

function resolveLocal(fromFile: string, source: string): string | null {
  if (!source.startsWith('.') && !source.startsWith('/')) return null;
  const base = path.resolve(path.dirname(fromFile), source);
  const stripped = base.replace(/\.(js|mjs|cjs|jsx)$/, '');
  const candidates = [base, ...['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.cjs'].map((e) => stripped + e), ...['index.ts', 'index.tsx', 'index.js', 'index.mjs'].map((i) => path.join(base, i))];
  for (const c of candidates) { try { if (statSync(c).isFile()) return c; } catch { /* next */ } }
  return null;
}

// ─── Dangerous calls ────────────────────────────────────────────────────────

interface SinkRule { re: RegExp; category: ActionCategory; risk: RiskLevel; why: string; from?: RegExp }

const CHILD_PROCESS = /^(?:node:)?child_process$/;
const FS_MODULE = /^(?:node:)?fs(?:\/promises)?$|^fs-extra$|^graceful-fs$/;

/** Matched against the call as written. `from` limits a bare identifier to imports from that module. */
const SINK_RULES: SinkRule[] = [
  // code execution
  { re: /^(?:\w+\.)?(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)$/, category: 'shell.exec', risk: 'high', why: 'runs a process', from: CHILD_PROCESS },
  { re: /^(?:execa|execaSync|execaCommand|execaCommandSync|\$|shelljs\.exec|shell\.exec)$/, category: 'shell.exec', risk: 'high', why: 'runs a shell command' },
  { re: /^(?:eval|new Function|vm\.runInNewContext|vm\.runInThisContext|new vm\.Script)$/, category: 'shell.exec', risk: 'critical', why: 'evaluates code it is given' },
  // files
  { re: /^(?:\w+\.)*(?:rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync|remove|removeSync|emptyDir|emptyDirSync)$/, category: 'fs.delete', risk: 'high', why: 'deletes files', from: FS_MODULE },
  { re: /^(?:rimraf|rimrafSync|del|deleteAsync|deleteSync)$/, category: 'fs.delete', risk: 'high', why: 'deletes files' },
  { re: /^(?:\w+\.)*(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|copyFile|copyFileSync|rename|renameSync|outputFile)$/, category: 'fs.write', risk: 'medium', why: 'writes files', from: FS_MODULE },
  // Kubernetes (@kubernetes/client-node)
  { re: /\.(?:deleteNamespace|deleteCollectionNamespaced\w+|deleteNamespaced\w+|deleteNode|deleteClusterRole\w*|deletePersistentVolume)$/, category: 'k8s.delete', risk: 'critical', why: 'deletes Kubernetes resources' },
  { re: /\.(?:patchNamespaced\w*Scale|replaceNamespaced\w*Scale|patchNamespacedDeployment|replaceNamespacedDeployment|patchNode)$/, category: 'k8s.scale', risk: 'high', why: 'changes Kubernetes workloads' },
  { re: /\.(?:connectGetNamespacedPodExec|connectPostNamespacedPodExec)$|^(?:new )?(?:k8s\.)?Exec$/, category: 'k8s.exec', risk: 'high', why: 'runs commands inside a pod' },
  // AWS SDK v3 commands and v2 methods
  { re: /^new (?:Create|Attach|Put|Update|Delete|Detach)(?:Role|User|Group)?Policy(?:Version)?Command$|^new (?:CreateAccessKey|CreateUser|CreateRole|AddUserToGroup|UpdateAssumeRolePolicy|AttachUserPolicy|AttachRolePolicy|PutRolePolicy|PutUserPolicy|CreateLoginProfile)Command$/, category: 'iam.change', risk: 'critical', why: 'changes AWS permissions' },
  { re: /^new (?:Delete(?:Bucket|Table|Stack|Cluster|DBInstance|DBCluster|Function|Queue|Topic|Repository|Vpc|Subnet|SecurityGroup|LoadBalancer|AutoScalingGroup)|TerminateInstances|DeleteVolume|DeregisterTaskDefinition)Command$|\.(?:terminateInstances|deleteBucket|deleteStack|deleteTable|deleteDBInstance|deleteDBCluster|deleteFunction)$/, category: 'infra.destroy', risk: 'critical', why: 'destroys cloud infrastructure' },
  { re: /^new (?:DeleteObject|DeleteObjects)Command$|\.deleteObjects?$/, category: 'fs.delete', risk: 'high', why: 'deletes objects from storage' },
  { re: /^new (?:DeleteItem|BatchWriteItem|TransactWriteItems)Command$/, category: 'db.write', risk: 'high', why: 'deletes or writes database items' },
  { re: /^new (?:GetSecretValue|GetParameter|GetParameters|GetParametersByPath|Decrypt)Command$|\.getSecretValue$/, category: 'secrets.read', risk: 'high', why: 'reads secrets' },
  { re: /^new (?:Create|Update|Put|Modify|Run|Start|Stop|Reboot)\w*Command$/, category: 'infra.apply', risk: 'medium', why: 'changes cloud resources' },
  // GitHub (Octokit)
  { re: /(?:^|\.)pulls\.merge$|\.mergePullRequest$/, category: 'git.merge', risk: 'high', why: 'merges a pull request' },
  { re: /(?:^|\.)repos\.delete$|(?:^|\.)git\.deleteRef$|(?:^|\.)repos\.(?:deleteBranchProtection|updateBranchProtection|removeCollaborator)$/, category: 'git.push', risk: 'critical', why: 'deletes or unprotects repository state' },
  { re: /(?:^|\.)repos\.(?:createOrUpdateFileContents|deleteFile|merge)$|(?:^|\.)git\.(?:createCommit|updateRef|createRef)$/, category: 'git.push', risk: 'high', why: 'writes to a repository' },
  { re: /(?:^|\.)repos\.createRelease$/, category: 'release.publish', risk: 'high', why: 'publishes a release' },
  { re: /(?:^|\.)actions\.(?:createWorkflowDispatch|reRunWorkflow)$/, category: 'deploy', risk: 'high', why: 'triggers a CI/CD workflow' },
  // Payments (Stripe)
  { re: /\.(?:refunds|charges|transfers|payouts|topups)\.create$|\.paymentIntents\.(?:create|confirm|capture)$|\.subscriptions\.(?:cancel|del|update)$|\.customers\.del$|\.invoices\.(?:pay|finalizeInvoice)$/, category: 'payment', risk: 'high', why: 'moves money' },
  // Messages
  { re: /(?:^|\.)(?:sendMail|sendEmail|sendSms|sendSMS)$|^sgMail\.send|\.emails\.send$|\.chat\.postMessage$|\.webhooks?\.send$/, category: 'message.send', risk: 'medium', why: 'sends messages to people' },
  // Databases
  { re: /\.(?:\$executeRaw|\$executeRawUnsafe|\$queryRawUnsafe)$/, category: 'db.write', risk: 'high', why: 'runs raw SQL' },
  { re: /\.(?:dropDatabase|dropCollection|dropTable|dropSchema)$/, category: 'db.destructive', risk: 'critical', why: 'drops data' },
  { re: /\.deleteMany$/, category: 'db.destructive', risk: 'high', why: 'deletes many records' },
  { re: /\.(?:delete|update|updateMany|upsert|create|createMany|insert|insertMany|del)$/, category: 'db.write', risk: 'medium', why: 'writes to a database', from: /prisma|drizzle|knex|mongoose|mongodb|sequelize|typeorm|supabase|^pg$|mysql|^db$/i },
  // Network
  { re: /^(?:fetch|got|ky|undici\.request|request)$|^axios(?:\.(?:get|post|put|patch|delete|request))?$|^https?\.(?:request|get)$/, category: 'network.request', risk: 'medium', why: 'calls the network' },
];

const SQL_CALL = /(?:^|\.)(?:query|execute|exec|raw|run|all|unsafe|sql)$/;
const SQL_TEXT = /\b(?:select|insert\s+into|update\s+\w+\s+set|delete\s+from|drop|truncate|alter\s+table|create\s+table|grant)\b/i;

function matchSink(call: string, args: Node[], idx: FileIndex): Omit<Sink, 'file' | 'line' | 'via'> | null {
  const root = call.split('.')[0];
  const imp = idx.imports.get(root);
  for (const rule of SINK_RULES) {
    if (!rule.re.test(call)) continue;
    if (rule.from) {
      // The call must come from that module: imported from it, or held in a variable named after it (prisma, knex, fs)
      const source = imp?.source ?? '';
      if (!rule.from.test(source) && !rule.from.test(root)) continue;
    }
    let sink = { category: rule.category, risk: rule.risk, call, why: rule.why };
    if (rule.category === 'shell.exec') {
      const lit = literalText(args[0]);
      if (lit && !lit.includes('…')) {
        // A fixed command tells us exactly what runs: classify it with the runtime engine
        const c = classifyAction({ name: 'run_command', args: { command: lit } });
        sink = { ...sink, category: c.category, risk: c.risk, why: `${rule.why}: ${lit.slice(0, 60)}` };
      } else if (args[0] && rule.risk !== 'critical') {
        // Built at runtime, often straight from the model's arguments: assume the worst
        sink = { ...sink, risk: 'critical', why: `${rule.why} built at runtime${lit ? `: ${lit.slice(0, 60)}` : ''}` };
      }
    }
    // deleteMany({}) / deleteMany() deletes every record
    if (/\.deleteMany$/.test(call) && (!args[0] || (args[0].type === 'ObjectExpression' && args[0].properties.length === 0))) {
      sink = { ...sink, risk: 'critical', why: 'deletes every record (no filter)' };
    }
    return sink;
  }
  // SQL passed to a query function
  if (SQL_CALL.test(call)) {
    const lit = literalText(args[0]);
    if (lit && SQL_TEXT.test(lit)) {
      const c = classifyAction({ name: 'execute_sql', args: { query: lit } });
      if (c.category === 'read' || /^\s*select\b/i.test(lit)) return null;
      return { category: c.category, risk: c.risk, call, why: `runs SQL: ${lit.replace(/\s+/g, ' ').slice(0, 60)}` };
    }
  }
  return null;
}

// ─── Following a tool to its sinks ──────────────────────────────────────────

const MAX_DEPTH = 5;

function sinksOf(fnNode: Node, idx: FileIndex, errors: ScanReport['parseErrors'], via: string[] = [], seen = new Set<Node>()): Sink[] {
  if (!fnNode || seen.has(fnNode) || via.length > MAX_DEPTH) return [];
  seen.add(fnNode);
  const out: Sink[] = [];
  const body = fnNode.type === 'ArrowFunctionExpression' && fnNode.body.type !== 'BlockStatement' ? fnNode.body : fnNode.body;
  walk(body, (n) => {
    // Nested function definitions are only followed when called
    if (n !== body && isFn(n) && n.type !== 'ArrowFunctionExpression' && n.type !== 'FunctionExpression') return false;
    let call = '';
    let args: Node[] = [];
    if (n.type === 'CallExpression' || n.type === 'OptionalCallExpression') { call = calleeText(n.callee); args = n.arguments; }
    else if (n.type === 'NewExpression') { call = `new ${calleeText(n.callee)}`; args = n.arguments; }
    else if (n.type === 'TaggedTemplateExpression') { call = calleeText(n.tag); args = [n]; }
    if (!call) return;
    const line = n.loc?.start?.line ?? 0;
    const sink = matchSink(call, args, idx);
    if (sink) out.push({ ...sink, file: idx.file, line, via });

    // Follow calls into project code
    const target = resolveCall(call, idx, errors);
    if (target) out.push(...sinksOf(target.fn, target.idx, errors, [...via, target.name], seen));

    // A function passed as an argument (callbacks, wrappers) runs too
    for (const a of args) if (a?.type === 'Identifier' && idx.fns.has(a.name)) out.push(...sinksOf(idx.fns.get(a.name), idx, errors, [...via, a.name], seen));
  });
  return out;
}

function resolveCall(call: string, idx: FileIndex, errors: ScanReport['parseErrors']): { fn: Node; idx: FileIndex; name: string } | null {
  const parts = call.replace(/^new /, '').split('.');
  if (parts.length === 1) {
    const name = parts[0];
    if (idx.fns.has(name)) return { fn: idx.fns.get(name), idx, name };
    const imp = idx.imports.get(name);
    if (imp) {
      const file = resolveLocal(idx.file, imp.source);
      const other = file ? indexFile(file, errors) : null;
      const exported = imp.imported === 'default' ? findDefault(other) : other?.fns.get(imp.imported);
      if (other && exported) return { fn: exported, idx: other, name };
    }
    return null;
  }
  // ns.fn() where ns is `import * as ns from './x'`, or this.fn() / obj.fn() defined in this file
  const [head, ...rest] = parts;
  const last = rest[rest.length - 1];
  const imp = idx.imports.get(head);
  if (imp && (imp.imported === '*' || imp.imported === 'default')) {
    const file = resolveLocal(idx.file, imp.source);
    const other = file ? indexFile(file, errors) : null;
    if (other?.fns.has(last)) return { fn: other.fns.get(last), idx: other, name: `${head}.${last}` };
  }
  if ((head === 'this' || !imp) && rest.length === 1 && idx.fns.has(last)) return { fn: idx.fns.get(last), idx, name: last };
  return null;
}

function findDefault(idx: FileIndex | null): Node | null {
  if (!idx) return null;
  for (const st of idx.ast.program.body) {
    if (st.type === 'ExportDefaultDeclaration') {
      const d = st.declaration;
      if (isFn(d)) return d;
      if (d.type === 'Identifier') return idx.fns.get(d.name) ?? null;
    }
  }
  return null;
}

// ─── Finding the tools ──────────────────────────────────────────────────────

interface FoundTool { name: string; framework: string; line: number; impl: Node | null; implName?: string; governed: boolean }

const snakeToCamel = (s: string) => s.replace(/[_-](\w)/g, (_, c) => c.toUpperCase());

/** The function a tool runs. Unwraps leap.wrapTool(name, fn), which also marks it governed. */
function implOf(n: Node, idx: FileIndex): { fn: Node | null; governed: boolean; name?: string } {
  if (!n) return { fn: null, governed: false };
  if (n.type === 'ObjectMethod' || isFn(n)) return { fn: n, governed: false };
  if (n.type === 'Identifier') return { fn: idx.fns.get(n.name) ?? null, governed: false, name: n.name };
  if (n.type === 'CallExpression' && /\.?wrapTool$/.test(calleeText(n.callee))) {
    const inner = implOf(n.arguments[1], idx);
    return { ...inner, governed: true };
  }
  return { fn: null, governed: false };
}

/** The name a tool is registered under: its `name`/`id` property, else the key or variable it is assigned to */
function nameFromContext(obj: Node | null, parent: Node | null, fallback: string): string {
  const named = strValue(getProp(obj, 'name')) ?? strValue(getProp(obj, 'id'));
  if (named) return named;
  if (parent?.type === 'ObjectProperty' && propName(parent)) return propName(parent)!;
  if (parent?.type === 'VariableDeclarator' && parent.id?.type === 'Identifier') return parent.id.name;
  return fallback;
}

function findTools(idx: FileIndex): FoundTool[] {
  const out: FoundTool[] = [];
  const schemaOnly: { name: string; framework: string; line: number }[] = [];
  const parents = new Map<Node, Node>();
  walk(idx.ast, (n, parent) => { if (parent) parents.set(n, parent); });

  walk(idx.ast, (n, parent) => {
    const line = n.loc?.start?.line ?? 0;
    if (n.type === 'CallExpression') {
      const callee = calleeText(n.callee);
      const a0 = n.arguments[0], a1 = n.arguments[1];
      const last = n.arguments[n.arguments.length - 1];

      // leap.wrapTool('name', fn): governed
      if (/(?:^|\.)wrapTool$/.test(callee) && strValue(a0)) {
        const impl = implOf(a1, idx);
        out.push({ name: strValue(a0)!, framework: 'leap360', line, impl: impl.fn, implName: impl.name, governed: true });
        return;
      }
      // tool({ description, parameters|inputSchema, execute })  — Vercel AI SDK, OpenAI Agents SDK
      // createTool({ id, execute })                              — Mastra
      if (/(?:^|\.)(?:tool|createTool|defineTool)$/.test(callee) && a0?.type === 'ObjectExpression' && getProp(a0, 'execute')) {
        const impl = implOf(getProp(a0, 'execute'), idx);
        out.push({ name: nameFromContext(a0, parents.get(n) ?? parent, `tool@${line}`), framework: /createTool/.test(callee) ? 'mastra' : 'ai-sdk', line, impl: impl.fn, implName: impl.name, governed: impl.governed });
        return;
      }
      // tool(fn, { name, schema })  — LangChain JS
      if (/(?:^|\.)tool$/.test(callee) && (isFn(a0) || a0?.type === 'Identifier') && a1?.type === 'ObjectExpression') {
        const impl = implOf(a0, idx);
        out.push({ name: nameFromContext(a1, parent, `tool@${line}`), framework: 'langchain', line, impl: impl.fn, implName: impl.name, governed: impl.governed });
        return;
      }
      // server.tool('name', …, handler) / server.registerTool('name', config, handler)  — MCP TypeScript SDK
      if (/\.(?:tool|registerTool)$/.test(callee) && strValue(a0) && n.arguments.length >= 2) {
        const impl = implOf(last, idx);
        if (impl.fn || last?.type === 'Identifier') {
          out.push({ name: strValue(a0)!, framework: 'mcp', line, impl: impl.fn, implName: impl.name, governed: impl.governed });
          return;
        }
      }
    }
    // new DynamicTool({ name, func }) / new DynamicStructuredTool({ name, func })  — LangChain JS
    if (n.type === 'NewExpression' && /(?:Dynamic|Structured)\w*Tool$/.test(calleeText(n.callee)) && n.arguments[0]?.type === 'ObjectExpression') {
      const o = n.arguments[0];
      const impl = implOf(getProp(o, 'func') ?? getProp(o, 'execute'), idx);
      out.push({ name: nameFromContext(o, parent, `tool@${line}`), framework: 'langchain', line, impl: impl.fn, implName: impl.name, governed: impl.governed });
      return;
    }
    // Schemas the model sees: { type: 'function', function: { name } } (OpenAI) or { name, input_schema } (Anthropic)
    if (n.type === 'ObjectExpression') {
      const fnObj = getProp(n, 'function');
      if (strValue(getProp(n, 'type')) === 'function' && fnObj?.type === 'ObjectExpression' && strValue(getProp(fnObj, 'name'))) {
        schemaOnly.push({ name: strValue(getProp(fnObj, 'name'))!, framework: 'openai', line });
      } else if (strValue(getProp(n, 'name')) && getProp(n, 'input_schema')) {
        schemaOnly.push({ name: strValue(getProp(n, 'name'))!, framework: 'anthropic', line });
      }
    }
  });
  // A schema names the tool; the code that runs it is usually a function of the same name (snake or camel case)
  for (const s of schemaOnly) {
    out.push({ ...s, impl: null, implName: s.name, governed: false });
  }
  return out;
}

// ─── Python (basic) ─────────────────────────────────────────────────────────

const PY_SINKS: { re: RegExp; category: ActionCategory; risk: RiskLevel; why: string }[] = [
  { re: /\bsubprocess\.(?:run|call|Popen|check_output|check_call)\s*\(|\bos\.(?:system|popen|exec\w*)\s*\(/, category: 'shell.exec', risk: 'high', why: 'runs a process' },
  { re: /\beval\s*\(|\bexec\s*\(/, category: 'shell.exec', risk: 'critical', why: 'evaluates code it is given' },
  { re: /\bshutil\.rmtree\s*\(|\bos\.(?:remove|unlink|rmdir|removedirs)\s*\(|\.unlink\s*\(/, category: 'fs.delete', risk: 'high', why: 'deletes files' },
  { re: /\bdelete_namespace\s*\(|\bdelete_namespaced_\w+\s*\(|\bdelete_collection_namespaced_\w+\s*\(/, category: 'k8s.delete', risk: 'critical', why: 'deletes Kubernetes resources' },
  { re: /\.(?:put_role_policy|attach_role_policy|attach_user_policy|create_access_key|create_user|put_user_policy|update_assume_role_policy)\s*\(/, category: 'iam.change', risk: 'critical', why: 'changes AWS permissions' },
  { re: /\.(?:terminate_instances|delete_bucket|delete_stack|delete_table|delete_db_instance|delete_function)\s*\(/, category: 'infra.destroy', risk: 'critical', why: 'destroys cloud infrastructure' },
  { re: /\.(?:delete_object|delete_objects)\s*\(/, category: 'fs.delete', risk: 'high', why: 'deletes objects from storage' },
  { re: /\.(?:get_secret_value|get_parameter)\s*\(/, category: 'secrets.read', risk: 'high', why: 'reads secrets' },
  { re: /\bstripe\.(?:Refund|Charge|Transfer|Payout|PaymentIntent)\.create\s*\(/, category: 'payment', risk: 'high', why: 'moves money' },
  { re: /\b(?:pr|pull|pull_request)\.merge\s*\(|\.create_git_ref\s*\(/, category: 'git.merge', risk: 'high', why: 'merges or changes a repository' },
  { re: /\brequests\.(?:post|put|patch|delete)\s*\(|\bhttpx\.(?:post|put|patch|delete)\s*\(/, category: 'network.request', risk: 'medium', why: 'calls the network' },
  { re: /\bsmtplib\b|\.send_message\s*\(|\.sendmail\s*\(/, category: 'message.send', risk: 'medium', why: 'sends messages to people' },
];

function scanPython(file: string): ScannedTool[] {
  let code: string;
  try { code = readFileSync(file, 'utf8'); } catch { return []; }
  if (!/@(?:\w+\.)?(?:tool|function_tool)\b/.test(code)) return [];
  const lines = code.split(/\r?\n/);
  // def name(...) blocks, by indentation
  const defs = new Map<string, { start: number; body: string }>();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:async\s+)?def\s+(\w+)\s*\(/);
    if (!m) continue;
    const indent = m[1].length;
    let j = i + 1;
    while (j < lines.length && (lines[j].trim() === '' || lines[j].match(/^(\s*)/)![1].length > indent)) j++;
    defs.set(m[2], { start: i + 1, body: lines.slice(i, j).join('\n') });
  }
  const tools: ScannedTool[] = [];
  for (let i = 0; i < lines.length; i++) {
    const deco = lines[i].match(/^\s*@(?:(\w+)\.)?(tool|function_tool)\b(?:\(\s*["']([^"']+)["'])?/);
    if (!deco) continue;
    let k = i + 1;
    while (k < lines.length && /^\s*@/.test(lines[k])) k++;
    const m = lines[k]?.match(/^\s*(?:async\s+)?def\s+(\w+)/);
    if (!m) continue;
    const def = defs.get(m[1]);
    const sinks: Sink[] = [];
    const scanBody = (body: string, startLine: number, via: string[]) => {
      body.split('\n').forEach((ln, off) => {
        for (const r of PY_SINKS) {
          const m = r.re.exec(ln);
          if (m) sinks.push({ category: r.category, risk: r.risk, call: m[0].replace(/\s*\($/, '').replace(/^\./, ''), why: r.why, file, line: startLine + off, via });
        }
      });
    };
    if (def) {
      scanBody(def.body, def.start, []);
      // one level into functions defined in the same file
      for (const [name, d] of defs) if (name !== m[1] && new RegExp(`\\b${name}\\s*\\(`).test(def.body)) scanBody(d.body, d.start, [name]);
    }
    tools.push(finishTool({ name: deco[3] ?? m[1], framework: deco[1] ? `python (${deco[1]}.${deco[2]})` : `python (@${deco[2]})`, file, line: k + 1, governed: false, resolved: !!def, sinks }));
  }
  return tools;
}

// ─── Scoring and report ─────────────────────────────────────────────────────

function finishTool(t: Omit<ScannedTool, 'risk' | 'categories'>): ScannedTool {
  // Nothing found in code (factory-built or dynamic tools): fall back to what the name says, like the runtime engine
  if (!t.sinks.length) {
    const byName = classifyAction({ name: t.name, args: {} });
    if (byName.category !== 'read' && byName.category !== 'unknown' && riskRank(byName.risk) >= riskRank('medium')) {
      t = { ...t, sinks: [{ category: byName.category, risk: byName.risk, call: t.name, why: `inferred from the tool name (${byName.reasons[0]?.replace(/^tool name: /, '') ?? byName.category}); its code could not be followed`, file: t.file, line: t.line, via: [], inferred: true }] };
    }
  }
  // One entry per kind of call and place, the worst first
  const seen = new Set<string>();
  const sinks = t.sinks
    .sort((a, b) => riskRank(b.risk) - riskRank(a.risk))
    .filter((s) => { const k = `${s.category}|${s.file}|${s.line}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const risk = sinks.reduce<RiskLevel>((r, s) => (riskRank(s.risk) > riskRank(r) ? s.risk : r), sinks.length ? 'low' : 'none');
  return { ...t, sinks, risk, categories: [...new Set(sinks.map((s) => s.category))] };
}

const CATEGORY_TEXT: Partial<Record<ActionCategory, string>> = {
  'shell.exec': 'shell commands', 'fs.delete': 'file deletion', 'k8s.delete': 'Kubernetes deletes', 'k8s.scale': 'Kubernetes changes',
  'iam.change': 'permission changes', 'infra.destroy': 'infrastructure destroys', 'infra.apply': 'infrastructure changes',
  'git.merge': 'merges', 'git.push': 'repository writes', 'release.publish': 'releases', deploy: 'deploys', payment: 'payments',
  'db.destructive': 'destructive database operations', 'db.write': 'database writes', 'secrets.read': 'reading secrets',
};

function suggest(tools: ScannedTool[]): ActionPolicy[] {
  const out: ActionPolicy[] = [];
  for (const t of tools) {
    if (t.governed || riskRank(t.risk) < riskRank('high')) continue;
    const worst = t.sinks.filter((s) => riskRank(s.risk) >= riskRank('high')).map((s) => s.category);
    const cats = [...new Set(worst)];
    out.push({
      kind: 'action',
      name: `${t.risk === 'critical' ? 'Require approval for' : 'Flag'} ${t.name} (${cats.map((c) => CATEGORY_TEXT[c] ?? c).join(', ')})`,
      action: t.risk === 'critical' ? 'ask_admin' : 'warn',
      severity: t.risk,
      match: { tools: [t.name] },
    });
  }
  return out;
}

export function scanProject(root: string, opts: ScanOptions = {}): ScanReport {
  parsed.clear();
  const errors: ScanReport['parseErrors'] = [];
  const files = listFiles(root, opts);
  const tools: ScannedTool[] = [];
  const allIdx: FileIndex[] = [];

  for (const file of files) {
    if (file.endsWith('.py')) { tools.push(...scanPython(file)); continue; }
    const idx = indexFile(file, errors);
    if (idx) allIdx.push(idx);
  }

  // Schema-only tools resolve to a same-named function anywhere in the project
  const findFnAnywhere = (name: string): { fn: Node; idx: FileIndex } | null => {
    for (const candidate of [name, snakeToCamel(name)]) {
      for (const idx of allIdx) if (idx.fns.has(candidate)) return { fn: idx.fns.get(candidate), idx };
    }
    return null;
  };

  for (const idx of allIdx) {
    for (const f of findTools(idx)) {
      let impl = f.impl ? { fn: f.impl, idx } : null;
      if (!impl && f.implName) impl = findFnAnywhere(f.implName);
      const sinks = impl ? sinksOf(impl.fn, impl.idx, errors, f.implName && f.implName !== f.name ? [f.implName] : []) : [];
      tools.push(finishTool({ name: f.name, framework: f.framework, file: idx.file, line: f.line, governed: f.governed, resolved: !!impl, sinks }));
    }
  }

  // The same tool registered twice (schema + implementation) is reported once, keeping what we learned
  const byName = new Map<string, ScannedTool>();
  for (const t of tools) {
    const prev = byName.get(t.name);
    if (!prev || riskRank(t.risk) > riskRank(prev.risk) || (t.resolved && !prev.resolved)) byName.set(t.name, { ...t, governed: t.governed || !!prev?.governed });
    else if (t.governed) prev.governed = true;
  }
  const unique = [...byName.values()].sort((a, b) => riskRank(b.risk) - riskRank(a.risk) || a.name.localeCompare(b.name));
  const rel = (f: string) => path.relative(root, f).split(path.sep).join('/');
  for (const t of unique) { t.file = rel(t.file); for (const s of t.sinks) s.file = rel(s.file); }

  return {
    root,
    filesScanned: files.length,
    parseErrors: errors.map((e) => ({ ...e, file: rel(e.file) })),
    tools: unique,
    summary: {
      tools: unique.length,
      critical: unique.filter((t) => t.risk === 'critical').length,
      high: unique.filter((t) => t.risk === 'high').length,
      medium: unique.filter((t) => t.risk === 'medium').length,
      low: unique.filter((t) => t.risk === 'low' || t.risk === 'none').length,
      ungoverned: unique.filter((t) => !t.governed).length,
      ungovernedAtRisk: unique.filter((t) => !t.governed && riskRank(t.risk) >= riskRank('high')).length,
    },
    suggestions: suggest(unique),
  };
}

// ─── Baseline ───────────────────────────────────────────────────────────────

export interface Baseline { version: 1; createdAt: string; tools: Record<string, { risk: RiskLevel; categories: ActionCategory[] }> }

export const DEFAULT_BASELINE = path.join('.leap360', 'scan-baseline.json');

export function toBaseline(report: ScanReport): Baseline {
  return { version: 1, createdAt: new Date().toISOString(), tools: Object.fromEntries(report.tools.map((t) => [t.name, { risk: t.risk, categories: [...t.categories].sort() }])) };
}

export function readBaseline(file: string): Baseline | null {
  try {
    const b = JSON.parse(readFileSync(file, 'utf8'));
    return b?.version === 1 && b.tools ? b : null;
  } catch { return null; }
}

export function writeBaseline(file: string, report: ScanReport) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(toBaseline(report), null, 2)}\n`);
}

export function diffBaseline(report: ScanReport, base: Baseline): BaselineDiff {
  const diff: BaselineDiff = { newTools: [], newAbilities: [], riskIncreases: [], removedTools: [] };
  for (const t of report.tools) {
    const before = base.tools[t.name];
    if (!before) { diff.newTools.push({ name: t.name, risk: t.risk, categories: t.categories }); continue; }
    const added = t.categories.filter((c) => !before.categories.includes(c));
    if (added.length) diff.newAbilities.push({ name: t.name, categories: added });
    if (riskRank(t.risk) > riskRank(before.risk)) diff.riskIncreases.push({ name: t.name, from: before.risk, to: t.risk });
  }
  const now = new Set(report.tools.map((t) => t.name));
  diff.removedTools = Object.keys(base.tools).filter((n) => !now.has(n));
  return diff;
}

/** True when the change adds a tool or ability at or above `risk` that Leap360 does not govern */
export function newRiskAtOrAbove(report: ScanReport, diff: BaselineDiff, risk: RiskLevel): boolean {
  const byName = new Map(report.tools.map((t) => [t.name, t]));
  const hit = (name: string) => { const t = byName.get(name); return !!t && !t.governed && riskRank(t.risk) >= riskRank(risk); };
  return diff.newTools.some((t) => hit(t.name)) || diff.newAbilities.some((t) => hit(t.name)) || diff.riskIncreases.some((t) => hit(t.name));
}

// ─── Text output ────────────────────────────────────────────────────────────

const RISK_COLOR: Record<RiskLevel, string> = { critical: '\x1b[41m\x1b[97m', high: '\x1b[31m', medium: '\x1b[33m', low: '\x1b[90m', none: '\x1b[90m' };

export function formatReport(r: ScanReport, color = true): string {
  const c = (code: string, s: string) => (color ? `${code}${s}\x1b[0m` : s);
  const out: string[] = [];
  out.push(`${c('\x1b[1m', 'Leap360 scan')}  ${r.filesScanned} files · ${r.tools.length} agent tool${r.tools.length === 1 ? '' : 's'} found`);
  if (!r.tools.length) {
    out.push('', '  No agent tools found. Leap360 looks for tool(), createTool(), LangChain tools, MCP server.tool(),', '  OpenAI/Anthropic tool schemas, leap.wrapTool() and Python @tool / @function_tool.');
  }
  for (const t of r.tools) {
    const label = t.risk === 'none' ? 'NONE' : t.risk.toUpperCase();
    const gov = t.governed ? c('\x1b[32m', 'governed by leap.wrapTool') : riskRank(t.risk) >= riskRank('high') ? c('\x1b[31m', 'NOT governed') : c('\x1b[90m', 'not governed');
    out.push('', `  ${c(RISK_COLOR[t.risk], ` ${label.padEnd(8)} `)} ${c('\x1b[1m', t.name)}  ${c('\x1b[90m', `${t.file}:${t.line} · ${t.framework}`)}  ${gov}`);
    if (!t.resolved) out.push(`             ${c('\x1b[90m', 'implementation not found: Leap360 can still govern it at runtime')}`);
    for (const s of t.sinks.slice(0, 6)) {
      const via = s.via.length ? c('\x1b[90m', ` via ${s.via.join(' → ')}`) : '';
      out.push(s.inferred
        ? `             └ ${s.category.padEnd(16)} ${c('\x1b[90m', s.why)}`
        : `             └ ${s.category.padEnd(16)} ${s.call}()  ${s.why}  ${c('\x1b[90m', `${s.file}:${s.line}`)}${via}`);
    }
    if (t.sinks.length > 6) out.push(`             └ … ${t.sinks.length - 6} more`);
  }
  const s = r.summary;
  out.push('', `  ${s.critical} critical · ${s.high} high · ${s.medium} medium · ${s.low} low   ${s.ungovernedAtRisk ? c('\x1b[31m', `${s.ungovernedAtRisk} high-risk tool${s.ungovernedAtRisk === 1 ? '' : 's'} not governed`) : c('\x1b[32m', 'every high-risk tool is governed')}`);
  if (r.baseline) {
    const b = r.baseline;
    const lines: string[] = [];
    for (const t of b.newTools) lines.push(`  + new tool ${t.name} (${t.risk}${t.categories.length ? `: ${t.categories.join(', ')}` : ''})`);
    for (const t of b.newAbilities) lines.push(`  + ${t.name} can now: ${t.categories.join(', ')}`);
    for (const t of b.riskIncreases) lines.push(`  ▲ ${t.name} risk ${t.from} → ${t.to}`);
    for (const n of b.removedTools) lines.push(`  - removed ${n}`);
    out.push('', `  ${c('\x1b[1m', 'Since the baseline')}${lines.length ? '' : ': no changes'}`, ...lines);
  }
  if (r.suggestions.length) {
    out.push('', `  ${c('\x1b[1m', 'Suggested action policies')} (adopt in the Leap360 console, or govern the tool with leap.wrapTool):`);
    for (const p of r.suggestions.slice(0, 8)) out.push(`  · ${p.name}  [${p.action}]`);
  }
  if (r.parseErrors.length) out.push('', c('\x1b[90m', `  ${r.parseErrors.length} file${r.parseErrors.length === 1 ? '' : 's'} could not be parsed (skipped): ${r.parseErrors.slice(0, 3).map((e) => e.file).join(', ')}`));
  return out.join('\n');
}

/** Adds `leap360 scan` to the project's prebuild script. Returns what changed, or null if already present. */
export function installPrebuildHook(root: string, command: string): { before: string | null; after: string } | null {
  const pkgFile = path.join(root, 'package.json');
  if (!existsSync(pkgFile)) throw new Error(`no package.json in ${root}`);
  const raw = readFileSync(pkgFile, 'utf8');
  const pkg = JSON.parse(raw);
  pkg.scripts = pkg.scripts ?? {};
  const before: string | null = pkg.scripts.prebuild ?? null;
  if (before && before.includes('leap360 scan')) return null;
  const after = before ? `${command} && ${before}` : command;
  pkg.scripts.prebuild = after;
  const indent = raw.match(/^(\s+)"/m)?.[1] ?? '  ';
  writeFileSync(pkgFile, `${JSON.stringify(pkg, null, indent)}\n`);
  return { before, after };
}
