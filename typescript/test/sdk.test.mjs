// Shadow mode and wrapTool() in the Leap360 class, against a deliberately slow fake API.
// Run: npm run build && npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Leap360, Leap360ActionBlockedError, Governor } from '../dist/index.js';

const API_DELAY = 600;

/** Fake Leap360 API. Every reply waits API_DELAY ms, so a call that waits on it is easy to spot. */
function fakeApi({ mode, blockTraces = false, blockTools = [] }) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = body ? JSON.parse(body) : {};
      seen.push({ url: req.url, body: json });
      setTimeout(() => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url.endsWith('/status')) return res.end(JSON.stringify({ status: 'ACTIVE', mode: mode() }));
        if (req.url === '/v1/traces') {
          if (blockTraces && mode() === 'enforce') {
            res.statusCode = 403;
            return res.end(JSON.stringify({ code: 'POLICY_VIOLATION_BLOCKED', message: 'BLOCKED by "No prod deletes"', violation: { policyName: 'No prod deletes', reasoning: 'k8s.delete' } }));
          }
          return res.end(JSON.stringify({ status: 'ok', mode: mode() }));
        }
        if (req.url === '/v1/actions' && json.phase === 'pre') {
          const verdict = blockTools.includes(json.tool) ? 'block' : 'allow';
          return res.end(JSON.stringify({ id: json.id, mode: mode(), decision: mode() === 'shadow' ? 'allow' : verdict, wouldBe: verdict, category: 'unknown', risk: 'high', findings: [], ...(verdict === 'block' ? { message: `Blocked by "Guard ${json.tool}"` } : {}) }));
        }
        res.end(JSON.stringify({ ok: true }));
      }, API_DELAY);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

/** An OpenAI-shaped client whose model always asks to delete a namespace */
const fakeOpenAI = () => ({
  chat: { completions: { create: async (body) => ({
    model: body.model, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    choices: [{ message: { role: 'assistant', tool_calls: [{ id: 't1', type: 'function', function: { name: 'delete_namespace', arguments: '{"name":"web","context":"prod"}' } }] } }],
  }) } },
});

const timed = async (fn) => { const t = Date.now(); const r = await fn(); return { r, ms: Date.now() - t }; };
const settle = (ms = API_DELAY + 200) => new Promise((r) => setTimeout(r, ms));

test('shadow mode: LLM calls never wait for Leap360, but are still reported', async () => {
  const api = await fakeApi({ mode: () => 'shadow', blockTraces: true });
  try {
    const leap = new Leap360({ apiKey: 'k', projectId: 'p', serviceName: 'svc', baseUrl: api.url, mode: 'shadow' });
    const openai = leap.wrapOpenAI(fakeOpenAI());
    const { r, ms } = await timed(() => openai.chat.completions.create({ model: 'gpt', messages: [] }));
    assert.ok(ms < API_DELAY / 2, `took ${ms} ms`);
    assert.equal(r.choices[0].message.tool_calls[0].function.name, 'delete_namespace', 'the response is untouched');
    await settle();
    assert.equal(api.seen.filter((x) => x.url === '/v1/traces').length, 1, 'reported exactly once');
  } finally { api.server.close(); }
});

test('enforce mode: a blocked LLM response throws before the app sees the tool call', async () => {
  const api = await fakeApi({ mode: () => 'enforce', blockTraces: true });
  try {
    const leap = new Leap360({ apiKey: 'k', projectId: 'p', serviceName: 'svc', baseUrl: api.url });
    const openai = leap.wrapOpenAI(fakeOpenAI());
    await assert.rejects(openai.chat.completions.create({ model: 'gpt', messages: [] }), /POLICY_BLOCKED.*No prod deletes/);
  } finally { api.server.close(); }
});

test('the SDK follows the mode set in the console, both ways', async () => {
  let mode = 'shadow';
  const api = await fakeApi({ mode: () => mode });
  try {
    const leap = new Leap360({ apiKey: 'k', projectId: 'p', serviceName: 'svc', baseUrl: api.url });
    const openai = leap.wrapOpenAI(fakeOpenAI());
    const first = await timed(() => openai.chat.completions.create({ model: 'gpt', messages: [] }));
    assert.ok(first.ms >= API_DELAY - 50, 'mode unknown: the first call waits, as enforce would');
    assert.equal(leap.isShadow(), true, 'learned from the reply');
    const second = await timed(() => openai.chat.completions.create({ model: 'gpt', messages: [] }));
    assert.ok(second.ms < API_DELAY / 2, `shadow call took ${second.ms} ms`);
    mode = 'enforce';
    await settle(); // the background reply of the second call says enforce
    assert.equal(leap.isShadow(), false, 'switching back to enforce in the console takes effect');
  } finally { api.server.close(); }
});

test('wrapTool in enforce mode: a blocked call throws and the function never runs', async () => {
  const api = await fakeApi({ mode: () => 'enforce', blockTools: ['delete_namespace'] });
  try {
    const leap = new Leap360({ apiKey: 'k', projectId: 'p', serviceName: 'deploy-bot', baseUrl: api.url, mode: 'enforce' });
    let ran = 0;
    const del = leap.wrapTool('delete_namespace', async ({ name }) => { ran++; return `deleted ${name}`; });
    const list = leap.wrapTool('list_pods', async ({ ns }) => [`${ns}/web-1`]);

    const err = await del({ name: 'payments' }).catch((e) => e);
    assert.ok(err instanceof Leap360ActionBlockedError);
    assert.equal(err.code, 'ACTION_BLOCKED');
    assert.match(err.message, /Guard delete_namespace/);
    assert.equal(ran, 0);

    assert.deepEqual(await list({ ns: 'web' }), ['web/web-1']);
    await settle();
    const pre = api.seen.filter((x) => x.body.phase === 'pre');
    assert.deepEqual(pre.map((x) => [x.body.tool, x.body.agent_name, x.body.source]), [['delete_namespace', 'deploy-bot', 'sdk'], ['list_pods', 'deploy-bot', 'sdk']]);
    const post = api.seen.filter((x) => x.body.phase === 'post');
    assert.equal(post.length, 1);
    assert.equal(post[0].body.result_preview, undefined, 'no result text leaves the process by default (issue #50)');
  } finally { api.server.close(); }
});

test('wrapTool in shadow mode: runs at once, errors propagate and are recorded', async () => {
  const api = await fakeApi({ mode: () => 'shadow', blockTools: ['charge_card'] });
  try {
    const leap = new Leap360({ apiKey: 'k', projectId: 'p', serviceName: 'billing-bot', baseUrl: api.url, mode: 'shadow' });
    const charge = leap.wrapTool('charge_card', (customer, cents) => `charged ${customer} ${cents}`, { argNames: ['customer', 'cents'] });
    // The first call waits for one kill-switch status check; after that, calls never wait on Leap360
    const first = await timed(() => charge('cus_1', 500));
    assert.equal(first.r, 'charged cus_1 500');
    assert.ok(first.ms < API_DELAY * 1.5, `first call took ${first.ms} ms`);
    const { r, ms } = await timed(() => charge('cus_1', 500));
    assert.equal(r, 'charged cus_1 500');
    assert.ok(ms < 50, `took ${ms} ms`);

    const boom = leap.wrapTool('refund', async () => { throw new Error('card declined'); });
    await assert.rejects(boom({ id: 1 }), /card declined/);
    await settle();
    const pre = api.seen.filter((x) => x.body.phase === 'pre');
    assert.deepEqual(pre[0].body.args, { customer: 'string', cents: 'number' }, 'positional args are named; only keys and types leave by default');
    const failed = api.seen.find((x) => x.body.phase === 'post' && x.body.ok === false);
    assert.equal(failed.body.error, 'Error', 'the error type, never its message, by default');
  } finally { api.server.close(); }
});

// ── Local decisions (enforce fast path) ─────────────────────────────────────
/** A fake API that serves a real policy list, a kill switch and slow /v1/actions answers */
function policyApi() {
  const state = { policies: [{ kind: 'action', name: 'No Kubernetes deletes', action: 'block', match: { categories: ['k8s.delete'] } }], status: 'ACTIVE', actions: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      const json = body ? JSON.parse(body) : {};
      if (req.url.includes('/policies')) return res.end(JSON.stringify({ policies: state.policies }));
      if (req.url.endsWith('/status') || req.url.includes('/status?')) return res.end(JSON.stringify({ status: state.status, mode: 'enforce' }));
      if (req.url === '/v1/actions') {
        state.actions.push(json);
        // Slow on purpose: a call that waits for this is easy to spot
        return setTimeout(() => {
          const block = json.phase === 'pre' && /delete/.test(json.tool);
          res.end(JSON.stringify({ id: json.id, mode: 'enforce', decision: block ? 'block' : 'allow', wouldBe: block ? 'block' : 'allow', category: 'unknown', risk: 'low', findings: [], ...(block ? { message: 'Blocked by "No Kubernetes deletes"' } : {}) }));
        }, API_DELAY);
      }
      res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` })));
}

test('enforce, local decisions: allowed calls do not wait for the API; blocked ones still go to it', async () => {
  const api = await policyApi();
  const g = new Governor({ apiKey: 'k', baseUrl: api.url, agentName: 'ops-bot', mode: 'enforce', log: () => {} });
  try {
    await g.check({ name: 'list_pods', args: {} }, 'sdk'); // warm-up: loads status and policies once
    const t = performance.now();
    const ok = await g.check({ name: 'list_pods', args: { namespace: 'web' } }, 'sdk');
    const ms = performance.now() - t;
    assert.equal(ok.allowed, true);
    assert.ok(ms < 20, `allowed call took ${ms.toFixed(1)} ms`);
    const del = await timed(() => g.check({ name: 'delete_namespace', args: { name: 'payments' } }, 'sdk'));
    assert.equal(del.r.allowed, false);
    assert.ok(del.ms >= API_DELAY - 50, 'a call a policy would block asks the server');
    await settle();
    assert.ok(api.state.actions.some((a) => a.phase === 'pre' && a.tool === 'list_pods' && a.args?.namespace === 'string'), 'allowed calls are still recorded');
  } finally { g.stop(); api.server.close(); }
});

test('enforce, local decisions: a new policy applies within the refresh window', async () => {
  const api = await policyApi();
  const g = new Governor({ apiKey: 'k', baseUrl: api.url, agentName: 'ops-bot', mode: 'enforce', policyTtlMs: 150, log: () => {} });
  try {
    assert.equal((await g.check({ name: 'send_email', args: { to: 'a@b.co' } }, 'sdk')).allowed, true);
    api.state.policies.push({ kind: 'action', name: 'No email', action: 'block', match: { categories: ['message.send'] } });
    await new Promise((r) => setTimeout(r, 200));
    // Now a local "block": the server path decides (the fake only blocks deletes), which proves the call left the fast path
    const after = await timed(() => g.check({ name: 'send_email', args: { to: 'a@b.co' } }, 'sdk'));
    assert.ok(after.ms >= API_DELAY - 50, `took ${after.ms.toFixed(0)} ms: the new policy sent it to the server`);
  } finally { g.stop(); api.server.close(); }
});

test('enforce, local decisions: the kill switch still lands within the status window', async () => {
  const api = await policyApi();
  const g = new Governor({ apiKey: 'k', baseUrl: api.url, agentName: 'ops-bot', mode: 'enforce', statusTtlMs: 150, log: () => {} });
  try {
    assert.equal((await g.check({ name: 'list_pods', args: {} }, 'sdk')).allowed, true);
    api.state.status = 'SUSPENDED';
    await new Promise((r) => setTimeout(r, 200));
    const r = await g.check({ name: 'list_pods', args: {} }, 'sdk');
    assert.equal(r.allowed, false);
    assert.match(r.message, /Stopped by your team in Leap360.*Do not retry/, "a clear refusal, in the console's words");
  } finally { g.stop(); api.server.close(); }
});

test('Leap360Client reads and manages the project; errors resolve, never reject', async () => {
  const http = await import('node:http');
  const { Leap360Client } = await import('../dist/index.js');
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      seen.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: body ? JSON.parse(body) : null, key: req.headers['x-api-key'] });
      const send = (code, payload) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
      if (req.method === 'POST' && url.pathname.endsWith('/status') && JSON.parse(body || '{}').status === 'ACTIVE') return send(403, { error: 'Only a signed-in person can resume a stopped agent.', code: 'PERSON_REQUIRED' });
      if (url.pathname.endsWith('/shadow')) return send(200, { totals: { wouldBlock: 2 }, capabilities: [] });
      return send(200, { ok: true });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const c = new Leap360Client({ apiKey: 'leap360_test', apiUrl: `http://127.0.0.1:${server.address().port}`, projectId: 'p1' });
  try {
    assert.equal((await c.getShadowReport()).totals.wouldBlock, 2);
    for (const [call, path] of [[() => c.getStats(), '/v1/projects/p1/stats'], [() => c.getAgents(), '/v1/projects/p1/agents'], [() => c.getMode(), '/v1/projects/p1/mode'], [() => c.getScans(), '/v1/projects/p1/scans'], [() => c.getAgentStatus('a b'), '/v1/projects/p1/agents/a%20b/status']]) {
      await call();
      assert.equal(seen.at(-1).path, path);
      assert.equal(seen.at(-1).key, 'leap360_test');
    }
    await c.getActions({ limit: 5 });
    assert.deepEqual(seen.at(-1).query, { limit: '5' });
    await c.suspendAgent('bot');
    assert.deepEqual(seen.at(-1).body, { status: 'SUSPENDED' });
    await c.decideApproval('t1', 'approved', 'ok');
    assert.deepEqual(seen.at(-1).body, { decision: 'APPROVED', adminNote: 'ok' });
    await c.setMode('shadow', 7);
    assert.deepEqual(seen.at(-1).body, { mode: 'shadow', days: 7 });
    const resumed = await c.resumeAgent('bot');
    assert.equal(resumed.code, 'PERSON_REQUIRED');
    assert.equal(resumed.httpStatus, 403);
  } finally {
    server.close();
  }
  const offline = await new Leap360Client({ apiKey: 'leap360_test', apiUrl: 'http://127.0.0.1:1' }).getStats();
  assert.equal(offline.code, 'UNREACHABLE');
  const noKey = await new Leap360Client({ apiKey: '', apiUrl: 'http://127.0.0.1:1' }).getStats().catch((e) => e);
  assert.ok(noKey && typeof noKey === 'object');
});
