// The pre-push check (issue #10), with real git pushes into a local bare repository. Run: npm run build && npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { repoName, detectAgent, parsePushRefs, pushAction, installPushHook, BLOCKED_EXIT } from '../dist/pushcheck.js';
import { classifyAction } from '../dist/actions.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'dist', 'cli.js');

test('repository names never carry credentials', () => {
  assert.equal(repoName('https://x-access-token:ghp_secret@github.com/acme/payments-api.git'), 'acme/payments-api');
  assert.equal(repoName('git@github.com:acme/payments-api.git'), 'acme/payments-api');
  assert.equal(repoName('ssh://git@gitlab.example.com/team/app.git'), 'gitlab.example.com/team/app');
  assert.equal(repoName('C:\\repos\\app.git'), 'local/app');
  assert.equal(repoName('/srv/git/app.git'), 'local/app');
});

test('the pushing agent is read from its environment', () => {
  assert.equal(detectAgent({ CLAUDECODE: '1' }), 'claude-code');
  assert.equal(detectAgent({ CURSOR_TRACE_ID: 'x' }), 'cursor');
  assert.equal(detectAgent({ GITHUB_ACTIONS: 'true' }), 'github-actions');
  assert.equal(detectAgent({ LEAP360_AGENT: 'release-bot', CLAUDECODE: '1' }), 'release-bot');
  assert.equal(detectAgent({}), 'human');
});

test('a force push to main is a critical-looking push; a normal one is a push', () => {
  const refs = parsePushRefs('refs/heads/main 1a2b3c4d refs/heads/main 5e6f7a8b\n\nnot a ref line here\n');
  assert.equal(refs.length, 1);
  const force = pushAction({ repo: 'acme/app', branch: 'main', remoteRef: 'refs/heads/main', commits: 2, force: true, deleted: false, files: [], filesTotal: 0, agent: 'claude-code' });
  assert.equal(force.name, 'force_push');
  const c = classifyAction(force);
  assert.equal(c.category, 'git.push');
  assert.ok(c.findings.some((f) => f.kind === 'prod-target'), 'main is production');
});

function fakeApi(blockTools) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const json = body ? JSON.parse(body) : {};
      seen.push({ url: req.url, body: json });
      res.setHeader('Content-Type', 'application/json');
      if (req.url.endsWith('/status')) return res.end(JSON.stringify({ status: 'ACTIVE', mode: 'enforce' }));
      if (req.url === '/v1/actions' && json.phase === 'pre') {
        const verdict = blockTools.includes(json.tool) ? 'block' : 'allow';
        return res.end(JSON.stringify({ id: json.id, mode: 'enforce', decision: verdict, wouldBe: verdict, category: 'git.push', risk: 'high', findings: [], ...(verdict === 'block' ? { message: `Blocked by "No pushes from ${json.agent_name}"` } : {}) }));
      }
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

/** Runs git without blocking this process, so the fake API in this process can answer the hook */
const run = (args, opts) => new Promise((resolve) => {
  const c = spawn('git', args, opts);
  let stderr = '';
  c.stderr.on('data', (d) => (stderr += d));
  c.on('close', (status) => resolve({ status, stderr }));
});

function repoWithHook() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leap360-push-'));
  const remote = path.join(dir, 'remote.git');
  const work = path.join(dir, 'work');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  const g = (...a) => execFileSync('git', a, { cwd: work, encoding: 'utf8' });
  g('config', 'user.email', 'test@example.com'); g('config', 'user.name', 'Test'); g('remote', 'add', 'origin', remote);
  fs.writeFileSync(path.join(work, 'notes.md'), 'secret plan: do not send me\n');
  g('add', '.'); g('commit', '-q', '-m', 'first');
  const { hookPath } = installPushHook(work);
  // The test repository has no node_modules: run this build of the CLI instead of npx
  fs.writeFileSync(hookPath, fs.readFileSync(hookPath, 'utf8').replace('npx --no-install leap360', `"${process.execPath.replace(/\\/g, '/')}" "${CLI.replace(/\\/g, '/')}"`));
  return { work, remote, g };
}

test('a blocked push stops before git sends anything; the check sends paths, never contents', async () => {
  const api = await fakeApi(['push_code']);
  const { work, remote } = repoWithHook();
  try {
    const r = await run(['push', '-u', 'origin', 'main'], { cwd: work, env: { ...process.env, LEAP360_API_URL: api.url, LEAP360_API_KEY: 'leap360_test', CLAUDECODE: '1' } });
    assert.notEqual(r.status, 0, 'git push failed');
    assert.match(r.stderr, /Push to .* main stopped: Blocked by "No pushes from claude-code"/);
    assert.throws(() => execFileSync('git', ['--git-dir', remote, 'rev-parse', 'main'], { stdio: 'ignore' }), 'the remote never got the branch');
    const pre = api.seen.find((s) => s.url === '/v1/actions' && s.body.phase === 'pre');
    assert.equal(pre.body.tool, 'push_code');
    assert.equal(pre.body.agent_name, 'claude-code');
    assert.deepEqual(pre.body.args.files, ['added notes.md']);
    assert.ok(!JSON.stringify(api.seen).includes('secret plan'), 'file contents are never sent');
  } finally { api.server.close(); }
});

test('an allowed push goes through, and a broken check never blocks a push', async () => {
  const api = await fakeApi([]);
  const { work, remote } = repoWithHook();
  try {
    const ok = await run(['push', '-u', 'origin', 'main'], { cwd: work, env: { ...process.env, LEAP360_API_URL: api.url, LEAP360_API_KEY: 'leap360_test' } });
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(execFileSync('git', ['--git-dir', remote, 'rev-parse', 'main'], { encoding: 'utf8' }).trim());
  } finally { api.server.close(); }
  // No API key: the check says it did not run, and the push goes ahead
  const { work: w2, g } = repoWithHook();
  const noKey = await run(['push', '-u', 'origin', 'main'], { cwd: w2, env: { ...process.env, LEAP360_API_KEY: '', LEAP360_API_URL: 'http://127.0.0.1:9' , HOME: w2, USERPROFILE: w2 } });
  assert.equal(noKey.status, 0, noKey.stderr);
  assert.ok(BLOCKED_EXIT !== 0 && BLOCKED_EXIT !== 1);
  void g;
});
