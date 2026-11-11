// Issue #50: by default nothing an end user wrote leaves the customer's process.
// Run: npm run build && npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Leap360, Leap360Client, Governor } from '../dist/index.js';
import { shapeOf, redactLocally, captureLevel, mergeClassified, policiesForMetadata, argPatternMatches } from '../dist/privacy.js';
import { classifyAction } from '../dist/actions.js';

const SECRET_TEXT = ['Jane Doe', 'jane.doe@example.com', '4111 1111 1111 1111', '12 Elm Street', 'refund my order'];

function fakeApi() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = body ? JSON.parse(body) : {};
      seen.push({ url: req.url, body: json, raw: body });
      res.setHeader('Content-Type', 'application/json');
      if (req.url.includes('/policies')) return res.end(JSON.stringify({ policies: [{ policyId: 'p-big', kind: 'action', name: 'Big refunds', action: 'ask_admin', match: { tools: ['refund'], argPattern: '"amount":\\s*[5-9]\\d{2,}' } }] }));
      if (req.url.includes('/status')) return res.end(JSON.stringify({ status: 'ACTIVE', mode: 'enforce' }));
      if (req.url === '/v1/actions' && json.phase === 'pre') return res.end(JSON.stringify({ id: json.id, mode: 'enforce', decision: 'allow', wouldBe: 'allow', category: 'payment', risk: 'high', findings: [] }));
      res.end(JSON.stringify({ status: 'ok', mode: 'enforce' }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const sentText = (api) => api.seen.map((x) => x.raw).join('\n');

const fakeOpenAI = () => ({
  chat: { completions: { create: async (body) => ({
    model: body.model, usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
    choices: [{ message: { role: 'assistant', content: 'Sure Jane Doe, refund my order is done.', tool_calls: [{ id: 't1', type: 'function', function: { name: 'refund', arguments: '{"order":"A-1","amount":900,"email":"jane.doe@example.com"}' } }] } }],
  }) } },
});
const prompt = { model: 'gpt-4o', messages: [{ role: 'user', content: 'I am Jane Doe, jane.doe@example.com, card 4111 1111 1111 1111, 12 Elm Street: refund my order' }], tools: [{ type: 'function', function: { name: 'refund', description: 'Refund an order' } }] };

test('capture levels: anything unknown is metadata', () => {
  assert.equal(captureLevel(undefined), 'metadata');
  assert.equal(captureLevel('FULL'), 'full');
  assert.equal(captureLevel('redacted'), 'redacted');
  assert.equal(captureLevel('everything'), 'metadata');
});

test('shapeOf keeps keys and types, never values', () => {
  assert.deepEqual(shapeOf({ to: 'jane@example.com', amount: 900, items: [1, 2], nested: { ok: true, none: null } }),
    { to: 'string', amount: 'number', items: 'array(2)', nested: { ok: 'boolean', none: 'null' } });
});

test('default: a traced OpenAI call sends no prompt, reply or argument text', async () => {
  const api = await fakeApi();
  try {
    const leap = new Leap360({ apiKey: 'k', projectId: 'p', serviceName: 'support-bot', baseUrl: api.url, mode: 'shadow' });
    assert.equal(leap.capture, 'metadata');
    const openai = leap.wrapOpenAI(fakeOpenAI());
    const r = await openai.chat.completions.create(prompt);
    assert.match(r.choices[0].message.content, /Jane Doe/, 'the app still gets the full reply');
    await settle();
    const trace = api.seen.find((x) => x.url === '/v1/traces');
    assert.ok(trace, 'the call is still reported');
    for (const t of SECRET_TEXT) assert.ok(!sentText(api).includes(t), `"${t}" left the process`);
    assert.equal(trace.body.capture, 'metadata');
    assert.equal(trace.body.request.messages, 1, 'a count of messages, not the messages');
    assert.deepEqual(trace.body.request.tools.map((t) => t.name), ['refund'], 'the tools offered still build the capability map');
    const call = trace.body.response.tool_calls[0];
    assert.equal(call.name, 'refund');
    assert.deepEqual(call.args, { order: 'string', amount: 'number', email: 'string' });
    assert.equal(call.classified.category, 'payment', 'classified here, from the real arguments');
    assert.equal(trace.body.usage.total_tokens, 17, 'token counts still count');
  } finally { api.server.close(); }
});

test('default: wrapTool sends no argument values or results, and argument patterns are tested locally', async () => {
  const api = await fakeApi();
  const g = new Governor({ apiKey: 'k', baseUrl: api.url, agentName: 'support-bot', mode: 'enforce', log: () => {} });
  try {
    await g.run({ name: 'refund', args: { order: 'A-1', amount: 900, note: 'Jane Doe, 12 Elm Street' } }, 'sdk', async () => 'refunded jane.doe@example.com');
    await settle();
    for (const t of SECRET_TEXT) assert.ok(!sentText(api).includes(t), `"${t}" left the process`);
    const pre = api.seen.find((x) => x.body.phase === 'pre');
    assert.deepEqual(pre.body.args, { order: 'string', amount: 'number', note: 'string' });
    assert.deepEqual(pre.body.arg_matches, ['p-big'], 'the amount was compared here, not on the server');
    assert.match(pre.body.args_key, /^[0-9a-f]{48}$/, 'a fingerprint, so an approval fits this exact call');
    assert.ok(!sentText(api).includes('900'), 'the amount itself never left');
    const post = api.seen.find((x) => x.body.phase === 'post');
    assert.equal(post.body.result_preview, undefined);
  } finally { g.stop(); api.server.close(); }
});

test('redacted: text is sent with emails, cards and phone numbers masked before it leaves', async () => {
  const api = await fakeApi();
  try {
    const leap = new Leap360({ apiKey: 'k', projectId: 'p', serviceName: 'support-bot', baseUrl: api.url, mode: 'shadow', capture: 'redacted' });
    const openai = leap.wrapOpenAI(fakeOpenAI());
    await openai.chat.completions.create({ ...prompt, messages: [{ role: 'user', content: `${prompt.messages[0].content}. Call me on +1 415 555 0132.` }] });
    await settle();
    const text = sentText(api);
    assert.ok(text.includes('Jane Doe'), 'names stay at redacted (they need the full level to be removed by a rule)');
    assert.ok(!text.includes('jane.doe@example.com') && text.includes('j•••@example.com'), 'email masked');
    assert.ok(!text.includes('4111 1111 1111 1111') && text.includes('[CARD •••• 1111]'), 'card masked');
    assert.ok(!text.includes('415 555 0132') && text.includes('[PHONE ••32]'), 'phone masked');
  } finally { api.server.close(); }
});

test('LEAP360_CAPTURE sets the level when the option is not given', async () => {
  process.env.LEAP360_CAPTURE = 'full';
  try {
    assert.equal(new Leap360Client({ apiKey: 'k', apiUrl: 'http://127.0.0.1:9' }).capture, 'full');
    assert.equal(new Leap360Client({ apiKey: 'k', apiUrl: 'http://127.0.0.1:9', capture: 'metadata' }).capture, 'metadata');
  } finally { delete process.env.LEAP360_CAPTURE; }
});

test('the API side: the SDK classification is used, but never to make a named risky tool safer', () => {
  const real = classifyAction({ name: 'run_command', args: { command: 'kubectl delete ns prod' } });
  const fromName = classifyAction({ name: 'run_command', args: {} });
  const merged = mergeClassified(fromName, { category: real.category, risk: real.risk, reasons: real.reasons, findings: real.findings }, { command: 'string' });
  assert.equal(merged.category, real.category);
  assert.equal(merged.risk, real.risk);
  assert.deepEqual(merged.args, { command: 'string' });
  assert.ok(merged.findings.every((f) => !f.detail.includes('prod)')), 'finding details carry no values');

  const drop = classifyAction({ name: 'drop_database', args: {} });
  const lied = mergeClassified(drop, { category: 'read', risk: 'low', reasons: ['read-only command'], findings: [] }, {});
  assert.equal(lied.risk, drop.risk, 'a named destructive tool keeps its risk');
  assert.equal(redactLocally('call +44 20 7946 0958 on 2026-11-11'), 'call [PHONE ••58] on 2026-11-11');
});

test('policies with argument patterns apply at metadata only when the SDK says the pattern matched', () => {
  const ps = [
    { policyId: 'a', name: 'Big refunds', action: 'ask_admin', match: { tools: ['refund'], argPattern: 'amount' } },
    { policyId: 'b', name: 'No deletes', action: 'block', match: { categories: ['fs.delete'] } },
  ];
  assert.deepEqual(policiesForMetadata(ps, []).map((p) => p.policyId), ['b']);
  assert.deepEqual(policiesForMetadata(ps, ['a']).map((p) => p.policyId), ['a', 'b']);
  assert.deepEqual(argPatternMatches(ps, { amount: 900 }), ['a']);
});
