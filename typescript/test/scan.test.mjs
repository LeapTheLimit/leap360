// Scanner tests against test/fixtures/scan-app. Run: npm run build && npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanProject, diffBaseline, newRiskAtOrAbove, toBaseline } from '../dist/scan.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'scan-app');
const CLI = path.join(here, '..', 'dist', 'cli.js');
const cli = (...args) => spawnSync(process.execPath, [CLI, 'scan', ...args], { encoding: 'utf8' });
const copyFixture = () => { const d = mkdtempSync(path.join(tmpdir(), 'leap360-scan-')); cpSync(FIXTURE, d, { recursive: true }); return d; };

const report = scanProject(FIXTURE);
const tool = (name) => report.tools.find((t) => t.name === name);

test('finds tools from every framework', () => {
  const names = report.tools.map((t) => `${t.name}:${t.framework.split(' ')[0]}`).sort();
  assert.deepEqual(names, [
    'cleanup:ai-sdk', 'delete_namespace:ai-sdk', 'drop_table:openai', 'get_weather:ai-sdk', 'list_files:mcp',
    'purge_users:mcp', 'refund:ai-sdk', 'run_shell:mcp', 'summarize:python', 'wipe_dir:python',
  ]);
  assert.equal(report.parseErrors.length, 0, 'TSX and TS both parse');
});

test('follows a tool across functions and files to the dangerous call', () => {
  const t = tool('delete_namespace');
  assert.equal(t.risk, 'critical');
  assert.equal(t.sinks[0].call, 'api.deleteNamespace');
  assert.equal(t.sinks[0].file, 'src/lib/k8s.ts');
  assert.deepEqual(t.sinks[0].via, ['removeNamespace', 'deleteNs']);
  // through a namespace import, into a literal command classified by the runtime engine
  const c = tool('cleanup');
  assert.deepEqual(c.categories.sort(), ['fs.delete', 'k8s.delete']);
  assert.deepEqual(c.sinks.find((s) => s.category === 'k8s.delete').via, ['ops.wipeCache']);
});

test('scores by what the code can do', () => {
  assert.equal(tool('run_shell').risk, 'critical', 'a command built at runtime is arbitrary execution');
  assert.equal(tool('purge_users').risk, 'critical', 'deleteMany({}) deletes everything');
  assert.equal(tool('drop_table').risk, 'critical', 'schema-only tool resolved to dropTable by name');
  assert.equal(tool('drop_table').sinks[0].category, 'db.destructive');
  assert.equal(tool('get_weather').risk, 'medium');
  assert.equal(tool('list_files').risk, 'none');
  assert.equal(tool('wipe_dir').sinks[0].call, 'shutil.rmtree');
  assert.equal(tool('summarize').risk, 'none');
});

test('knows which tools Leap360 already governs', () => {
  assert.equal(tool('refund').governed, true);
  assert.equal(tool('refund').sinks[0].category, 'payment', 'the wrapped function is still analysed');
  assert.equal(tool('delete_namespace').governed, false);
  assert.equal(report.summary.ungovernedAtRisk, 6);
  assert.ok(report.suggestions.every((p) => p.kind === 'action' && p.match.tools.length === 1));
  assert.ok(!report.suggestions.some((p) => p.match.tools[0] === 'refund'), 'no suggestion for a governed tool');
});

test('a baseline catches new dangerous abilities', () => {
  const base = toBaseline(report);
  assert.deepEqual(diffBaseline(report, base), { newTools: [], newAbilities: [], riskIncreases: [], removedTools: [] });
  delete base.tools.cleanup;
  base.tools.delete_namespace = { risk: 'low', categories: [] };
  base.tools.old_tool = { risk: 'low', categories: [] };
  const d = diffBaseline(report, base);
  assert.deepEqual(d.newTools.map((t) => t.name), ['cleanup']);
  assert.deepEqual(d.newAbilities, [{ name: 'delete_namespace', categories: ['k8s.delete'] }]);
  assert.deepEqual(d.riskIncreases, [{ name: 'delete_namespace', from: 'low', to: 'critical' }]);
  assert.deepEqual(d.removedTools, ['old_tool']);
  assert.equal(newRiskAtOrAbove(report, d, 'critical'), true);
});

test('CLI: --fail-on fails the build on an ungoverned critical tool', () => {
  const r = cli(FIXTURE, '--fail-on', 'critical', '--no-color');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /5 ungoverned tools at critical risk or above/);
  assert.equal(cli(FIXTURE, '--no-color').status, 0, 'report only by default');
  assert.equal(cli(FIXTURE, '--fail-on', 'bogus').status, 2);
});

test('CLI: --json is machine-readable', () => {
  const r = cli(FIXTURE, '--json');
  const j = JSON.parse(r.stdout);
  assert.equal(j.tools.length, 10);
  assert.equal(j.summary.critical, 5);
});

test('CLI: --install-hook adds a prebuild check and a baseline; only new abilities fail it', () => {
  const dir = copyFixture();
  const r = cli(dir, '--install-hook', '--no-color');
  assert.equal(r.status, 0);
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.prebuild, 'leap360 scan --fail-on-new critical');
  assert.ok(existsSync(path.join(dir, '.leap360', 'scan-baseline.json')));
  // installing twice changes nothing
  cli(dir, '--install-hook');
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts.prebuild, 'leap360 scan --fail-on-new critical');

  // the existing critical tools are accepted by the baseline: the build passes
  assert.equal(cli(dir, '--fail-on-new', 'critical').status, 0);

  // a commit gives the agent a new tool that can delete a cluster: the build fails
  mkdirSync(path.join(dir, 'src', 'new'), { recursive: true });
  writeFileSync(path.join(dir, 'src', 'new', 'tools.ts'), `import { tool } from 'ai';
import { EKSClient, DeleteClusterCommand } from '@aws-sdk/client-eks';
const eks = new EKSClient({});
export const t = { nuke_cluster: tool({ description: 'x', parameters: {}, execute: async () => eks.send(new DeleteClusterCommand({ name: 'prod' })) }) };
`);
  const fail = cli(dir, '--fail-on-new', 'critical', '--no-color');
  assert.equal(fail.status, 1);
  assert.match(fail.stdout, /\+ new tool nuke_cluster \(critical: infra\.destroy\)/);
  assert.match(fail.stderr, /new critical-risk ability/);

  // accepting it updates the baseline, and the build passes again
  assert.equal(cli(dir, '--update-baseline').status, 0);
  assert.equal(cli(dir, '--fail-on-new', 'critical').status, 0);
});

test('an existing prebuild script is kept', () => {
  const dir = copyFixture();
  const pj = path.join(dir, 'package.json');
  writeFileSync(pj, JSON.stringify({ name: 'x', scripts: { prebuild: 'npm run lint' } }, null, 2));
  cli(dir, '--install-hook');
  assert.equal(JSON.parse(readFileSync(pj, 'utf8')).scripts.prebuild, 'leap360 scan --fail-on-new critical && npm run lint');
});

test('skips node_modules and build output', () => {
  const dir = copyFixture();
  mkdirSync(path.join(dir, 'node_modules', 'evil'), { recursive: true });
  writeFileSync(path.join(dir, 'node_modules', 'evil', 'index.js'), "import { tool } from 'ai'; export const x = tool({ execute: async () => eval('1') });");
  assert.equal(scanProject(dir).tools.length, 10);
});
