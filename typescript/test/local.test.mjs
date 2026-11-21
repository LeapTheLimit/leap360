// Local mode: Leap360 on this device with no cloud, no account and no API key.
// Every test here fails if anything calls fetch.
// Run: npm run build && npm run test:unit
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Leap360, Leap360Client, Leap360ActionBlockedError, Governor, localStore } from '../dist/index.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
const realFetch = globalThis.fetch;
let dir;
let fetches;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leap360-local-'));
  process.env.LEAP360_HOME = dir;
  fetches = 0;
  globalThis.fetch = async () => { fetches++; throw new Error('local mode must not use the network'); };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.LEAP360_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
});

const quiet = () => {};
const gov = (o = {}) => new Governor({ apiKey: '', baseUrl: 'local', agentName: 'bot', log: quiet, ...o });

test('local: no API key, safe defaults block destructive calls and allow the rest, with no network', async () => {
  const leap = new Leap360({ local: true, projectId: 'p', serviceName: 'bot' });
  const weather = leap.wrapTool('get_weather', async ({ city }) => `sunny in ${city}`);
  const sql = leap.wrapTool('run_sql', async () => 'dropped');
  assert.equal(await weather({ city: 'Haifa' }), 'sunny in Haifa');
  await assert.rejects(sql({ query: 'DROP TABLE users' }), (e) => e instanceof Leap360ActionBlockedError && e.code === 'ACTION_BLOCKED');
  assert.ok(fs.existsSync(path.join(dir, 'rules.json')), 'rules.json is created with the defaults');
  const log = localStore().activity();
  assert.deepEqual(log.filter((e) => e.phase === 'pre').map((e) => [e.tool, e.verdict]), [['get_weather', 'allow'], ['run_sql', 'block']]);
  assert.ok(log.some((e) => e.phase === 'post' && e.ok === true), 'the outcome is recorded');
  assert.equal(fetches, 0);
});

test('local: a held call waits for `approve`, then that exact call may run', async () => {
  const g = gov();
  const call = { name: 'refund_payment', args: { order: 'A1', amount: 40 } };
  const first = await g.check(call, 'sdk');
  assert.equal(first.allowed, false);
  assert.equal(first.verdict, 'review');
  const held = localStore().approvals().filter((a) => a.status === 'PENDING');
  assert.equal(held.length, 1);
  // Asking again does not pile up entries
  await g.check(call, 'sdk');
  assert.equal(localStore().approvals().length, 1);
  localStore().decide(held[0].id, 'APPROVED');
  assert.equal((await g.check(call, 'sdk')).allowed, true);
  // Different arguments are a different call
  assert.equal((await g.check({ ...call, args: { order: 'B2', amount: 9000 } }, 'sdk')).allowed, false);
  assert.equal(fetches, 0);
});

test('local: approvalWaitMs waits for a person to decide', async () => {
  const g = gov({ approvalWaitMs: 5000 });
  setTimeout(() => {
    const a = localStore().approvals().find((x) => x.status === 'PENDING');
    localStore().decide(a.id, 'REJECTED');
  }, 300);
  const r = await g.check({ name: 'refund_payment', args: { order: 'C3' } }, 'sdk');
  assert.equal(r.allowed, false);
  assert.equal(r.verdict, 'block');
  assert.match(r.message, /Rejected/);
});

test('local: Stop all and per-agent stops apply at once, and Resume lifts them', async () => {
  const g = gov();
  const call = { name: 'get_weather', args: {} };
  localStore().stop();
  let r = await g.check(call, 'sdk');
  assert.equal(r.allowed, false);
  assert.match(r.message, /Stop all/);
  localStore().resume();
  assert.equal((await g.check(call, 'sdk')).allowed, true);
  localStore().stop('bot');
  assert.equal((await g.check(call, 'sdk')).allowed, false);
  assert.equal((await gov({ agentName: 'other' }).check(call, 'sdk')).allowed, true);
  localStore().resume('bot');
  assert.equal((await g.check(call, 'sdk')).allowed, true);
});

test('local: watch mode runs everything and logs what would have happened', async () => {
  localStore().setMode('watch');
  const r = await gov().check({ name: 'run_sql', args: { query: 'DROP TABLE users' } }, 'sdk');
  assert.equal(r.allowed, true);
  assert.equal(r.mode, 'shadow');
  assert.equal(r.wouldBe, 'block');
  const e = localStore().activity().at(-1);
  assert.equal(e.mode, 'watch');
  assert.equal(e.wouldBe, 'block');
});

test('local: rules.json edits apply without a restart, and the log masks credentials', async () => {
  const g = gov();
  const call = { name: 'send_email', args: { to: 'dana@example.com', token: 'sk-live-abcdefghijklmnopqrstuvwxyz123456' } };
  assert.equal((await g.check(call, 'sdk')).allowed, true);
  localStore().addPolicy({ name: 'No email', action: 'block', match: { tools: ['send_*'] } });
  assert.equal((await g.check(call, 'sdk')).allowed, false);
  const logged = JSON.stringify(localStore().activity());
  assert.ok(!logged.includes('sk-live-abcdefghijklmnopqrstuvwxyz123456'), 'the token is not written to the log');
});

test('local: Leap360Client answers on this device; cloud-only calls say so', async () => {
  const c = new Leap360Client({ local: true });
  assert.equal((await c.getProjectStatus()).status, 'ACTIVE');
  await c.suspendAgent('bot');
  assert.equal((await c.getAgentStatus('bot')).status, 'SUSPENDED');
  await c.resumeAgent('bot');
  assert.equal((await c.getAgentStatus('bot')).status, 'ACTIVE');
  assert.equal((await c.getPolicies()).policies.length, 4);
  assert.equal((await c.setMode('shadow')).mode, 'shadow');
  const r = await c.getShadowReport();
  assert.equal(r.code, 'LOCAL_UNSUPPORTED');
  assert.equal(fetches, 0);
});

test('local: the CLI drives it with LEAP360_LOCAL=1 and no sign-in', () => {
  const env = { ...process.env, LEAP360_LOCAL: '1', LEAP360_HOME: dir, LEAP360_API_KEY: '' };
  const run = (...a) => execFileSync(process.execPath, [CLI, ...a], { env, encoding: 'utf8' });
  run('local', 'stop');
  assert.equal(localStore().status().stopped, true);
  assert.match(run('local', 'status'), /Stop all\s+ON/);
  run('agents', 'resume', 'bot');
  run('local', 'resume');
  assert.equal(localStore().status().stopped, false);
  assert.match(run('local', 'rules'), /Block destructive actions/);
});
