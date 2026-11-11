// Integration test: MCP client ⇄ `leap360 mcp-proxy` (real process) ⇄ fake MCP server, with a fake Leap360 API.
// Run: npm run build && npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'dist', 'cli.js');
const SERVER = path.join(here, 'fixtures', 'fake-mcp-server.mjs');

/** A fake Leap360 API: blocks run_command when the command contains "rm -rf", reports a configurable mode */
function fakeApi(mode) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = body ? JSON.parse(body) : {};
      seen.push({ method: req.method, url: req.url, body: json, key: req.headers['x-api-key'] });
      res.setHeader('Content-Type', 'application/json');
      if (req.url.endsWith('/status')) return res.end(JSON.stringify({ status: 'ACTIVE', mode }));
      if (req.url === '/v1/actions' && json.phase === 'pre') {
        // The proxy sends keys and types by default, with its own classification of the real values (issue #50)
        const bad = json.tool === 'run_command' && (/rm -rf/.test(json.args?.command ?? '') || json.classified?.category === 'fs.delete');
        const verdict = bad ? 'block' : 'allow';
        return res.end(JSON.stringify({
          id: json.id, mode, decision: mode === 'shadow' ? 'allow' : verdict, wouldBe: verdict,
          category: bad ? 'fs.delete' : 'read', risk: bad ? 'critical' : 'low', findings: [],
          ...(bad && mode !== 'shadow' ? { message: 'Blocked by "No recursive deletes"', policy: { name: 'No recursive deletes' } } : {}),
        }));
      }
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

/** Starts the proxy and returns a tiny JSON-RPC client over its stdio */
function startProxy({ apiUrl, mode, extra = [] }) {
  const log = path.join(mkdtempSync(path.join(tmpdir(), 'leap360-mcp-')), 'calls.log');
  const args = [CLI, 'mcp-proxy', '--agent', 'test-agent', '--api-key', 'k_test', ...(mode ? ['--mode', mode] : []), ...extra, '--', process.execPath, SERVER];
  const child = spawn(process.execPath, args, { env: { ...process.env, LEAP360_API_URL: apiUrl, FAKE_MCP_LOG: log }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const waiting = new Map();
  const stray = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const m = JSON.parse(line); // every stdout line must be valid JSON-RPC
      if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } else stray.push(m);
    }
  });
  let next = 1;
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = next++;
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}; stderr:\n${stderr}`)), 8000);
    waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const callTool = (name, args = {}) => request('tools/call', { name, arguments: args });
  const close = () => new Promise((resolve) => { child.on('exit', resolve); child.stdin.end(); });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
  return { request, callTool, close, calls, stray, stderr: () => stderr };
}

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

test('enforce: allowed calls reach the server, blocked ones never do', async () => {
  const api = await fakeApi('enforce');
  const p = startProxy({ apiUrl: api.url, mode: 'enforce' });
  try {
    const init = await p.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'fake', 'initialize passes through untouched');
    const list = await p.request('tools/list', {});
    assert.equal(list.result.tools.length, 5);

    const ok = await p.callTool('list_pods', { namespace: 'web' });
    assert.equal(ok.result.content[0].text, 'ran list_pods');

    const blocked = await p.callTool('run_command', { command: 'rm -rf /var/lib/data' });
    assert.equal(blocked.result.isError, true);
    assert.match(blocked.result.content[0].text, /Leap360 blocked this action.*No recursive deletes/);

    await settle();
    assert.deepEqual(p.calls(), ['list_pods'], 'run_command never reached the MCP server');

    const pre = api.seen.filter((r) => r.url === '/v1/actions' && r.body.phase === 'pre');
    assert.deepEqual(pre.map((r) => r.body.tool), ['list_pods', 'run_command']);
    assert.equal(pre[0].body.source, 'mcp');
    assert.equal(pre[0].body.agent_name, 'test-agent');
    assert.equal(pre[0].key, 'k_test');
    assert.deepEqual(pre[0].body.hints, { readOnlyHint: true }, 'annotations from tools/list are forwarded');
    const post = api.seen.filter((r) => r.body.phase === 'post');
    assert.equal(post.length, 1, 'only the call that ran gets an outcome');
    assert.equal(post[0].body.ok, true);
    assert.equal(post[0].body.result_preview, undefined, 'no result text by default');
    assert.equal(p.stray.length, 0);
  } finally {
    await p.close();
    api.server.close();
  }
});

test('shadow: everything runs, and the outcome of each call is recorded', async () => {
  const api = await fakeApi('shadow');
  const p = startProxy({ apiUrl: api.url, mode: 'shadow' });
  try {
    await p.request('tools/list', {});
    const r = await p.callTool('run_command', { command: 'rm -rf /tmp/x' });
    assert.equal(r.result.content[0].text, 'ran run_command', 'shadow mode never blocks');
    const f = await p.callTool('flaky');
    assert.equal(f.result.isError, true);
    await settle();
    assert.deepEqual(p.calls(), ['run_command', 'flaky']);
    const post = api.seen.filter((x) => x.body.phase === 'post');
    assert.equal(post.find((x) => x.body.ok === false).body.error, 'Error', 'the error type, never its message, by default');
    assert.match(p.stderr(), /watch: run_command .* would be blocked; it ran/);
  } finally {
    await p.close();
    api.server.close();
  }
});

test('enforce with Leap360 unreachable: critical actions are blocked, the rest run', async () => {
  // Nothing listens on this port
  const p = startProxy({ apiUrl: 'http://127.0.0.1:9', mode: 'enforce' });
  try {
    await p.request('tools/list', {});
    const safe = await p.callTool('list_pods');
    assert.equal(safe.result.content[0].text, 'ran list_pods');
    const danger = await p.callTool('run_command', { command: 'kubectl delete ns prod' });
    assert.equal(danger.result.isError, true);
    assert.match(danger.result.content[0].text, /unreachable.*critical risk/);
    await settle();
    assert.deepEqual(p.calls(), ['list_pods']);
  } finally {
    await p.close();
  }
});

test('a lower --fail-closed-at also holds high-risk calls when offline', async () => {
  const p = startProxy({ apiUrl: 'http://127.0.0.1:9', mode: 'enforce', extra: ['--fail-closed-at', 'high'] });
  try {
    await p.request('tools/list', {});
    // frobnicate is only known to be risky through its destructiveHint annotation
    const r = await p.callTool('frobnicate');
    assert.equal(r.result.isError, true);
    await settle();
    assert.deepEqual(p.calls(), []);
  } finally {
    await p.close();
  }
});

test('non-tool messages and unknown methods pass straight through', async () => {
  const api = await fakeApi('enforce');
  const p = startProxy({ apiUrl: api.url, mode: 'enforce' });
  try {
    assert.deepEqual((await p.request('ping', {})).result, {});
    assert.equal((await p.request('resources/list', {})).error.code, -32601);
    assert.equal(api.seen.filter((r) => r.url === '/v1/actions').length, 0, 'only tools/call is gated');
  } finally {
    await p.close();
    api.server.close();
  }
});

test('the MCP server is named by its package or script, never its arguments', async () => {
  const { serverName } = await import('../dist/mcp-proxy.js');
  assert.equal(serverName('npx', ['-y', '@modelcontextprotocol/server-github']), '@modelcontextprotocol/server-github');
  assert.equal(serverName('npx', ['-y', '@modelcontextprotocol/server-github@1.2.3']), '@modelcontextprotocol/server-github');
  assert.equal(serverName('uvx', ['mcp-server-git', '--repository', '/home/me/secret-repo']), 'mcp-server-git');
  assert.equal(serverName('node', ['C:\\tools\\fake-github.mjs', '--token=abc']), 'fake-github.mjs');
  assert.equal(serverName('python', ['-m', 'my_server']), 'my_server');
  assert.equal(serverName('docker', ['run', '-i', '--rm', '-e', 'GITHUB_TOKEN', 'ghcr.io/github/github-mcp-server']), 'github-mcp-server');
});
