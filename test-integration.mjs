/**
 * Leap360 SDK — Full Integration Test
 * Exercises every feature end-to-end against a live local server.
 * No OpenAI key required — uses traceCall() with fake async functions.
 *
 * Run:  node test-integration.mjs
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const BASE     = 'http://localhost:4000';
const API_KEY  = 'leap360-dev-secret-key-change-me';
const PROJECT  = '00000000-0000-0000-0000-000000000001';

let passed = 0;
let failed = 0;

// ─── helpers ──────────────────────────────────────────────────────────────────

function ok(label, cond, detail = '') {
    if (cond) {
        console.log(`  ✅  ${label}`);
        passed++;
    } else {
        console.error(`  ❌  ${label}${detail ? ' — ' + detail : ''}`);
        failed++;
    }
}

async function api(method, path, body) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            'x-leap360-key': API_KEY,
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── 1. Health check ──────────────────────────────────────────────────────────

console.log('\n━━━ 1. Health Check ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
{
    const r = await api('GET', '/health');
    ok('GET /health → 200',        r.status === 200);
    ok('status field is "ok"',     r.body?.status === 'ok');
    ok('version field present',    typeof r.body?.version === 'string');
}

// ─── 2. Auth ─────────────────────────────────────────────────────────────────

console.log('\n━━━ 2. Auth ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
{
    const good = await fetch(`${BASE}/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin@leap360.ai', password: 'admin123' }),
    }).then(r => r.json());
    ok('Login with correct creds → token',    typeof good.token === 'string');
    ok('Login returns projectId',             typeof good.projectId === 'string');

    const bad = await fetch(`${BASE}/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'wrong@leap360.ai', password: 'bad' }),
    });
    ok('Login with bad creds → 401',          bad.status === 401);

    const noKey = await fetch(`${BASE}/v1/traces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
    });
    ok('Missing API key → 401',               noKey.status === 401);

    const wrongKey = await fetch(`${BASE}/v1/traces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-leap360-key': 'totally-wrong' },
        body: JSON.stringify({}),
    });
    ok('Wrong API key → 401',                 wrongKey.status === 401);
}

// ─── 3. Trace ingestion ───────────────────────────────────────────────────────

console.log('\n━━━ 3. Trace Ingestion ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

const tracePayload = {
    project_id:   PROJECT,
    service_name: 'test-service',
    agent_name:   'TestAgent',
    run_id:       crypto.randomUUID(),
    provider:     'openai',
    model:        'gpt-4o',
    request:      { messages: [{ role: 'user', content: 'Hello!' }] },
    response:     { choices: [{ message: { content: 'Hi there!' } }] },
    latency_ms:   123,
    usage:        { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    timestamp:    new Date().toISOString(),
    error:        null,
};

let traceId;
{
    const r = await api('POST', '/v1/traces', tracePayload);
    ok('POST /v1/traces → 200',       r.status === 200);
    ok('Response has traceId',        typeof r.body?.traceId === 'string');
    traceId = r.body?.traceId;

    // Bad payload
    const bad = await api('POST', '/v1/traces', { project_id: 'x' });
    ok('Invalid trace payload → 400', bad.status === 400);
}

// ─── 4. Services ─────────────────────────────────────────────────────────────

console.log('\n━━━ 4. Services ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
{
    const r = await api('GET', `/v1/projects/${PROJECT}/services`);
    ok('GET /v1/projects/:id/services → 200', r.status === 200);
    ok('Returns array',                        Array.isArray(r.body));
    const svc = r.body?.find(s => s.name === 'test-service');
    ok('test-service appears in list',         !!svc);
    ok('Service has traceCount',               typeof svc?.traceCount === 'number');

    // "demo" alias
    const demo = await api('GET', `/v1/projects/demo/services`);
    ok('demo alias resolves correctly',        demo.status === 200 && Array.isArray(demo.body));
}

// ─── 5. Traces listing & detail ──────────────────────────────────────────────

console.log('\n━━━ 5. Traces Listing & Detail ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
{
    const r = await api('GET', `/v1/projects/${PROJECT}/traces`);
    ok('GET /v1/projects/:id/traces → 200',  r.status === 200);
    ok('Returns { data, total }',            Array.isArray(r.body?.data));
    ok('total >= 1',                         r.body?.total >= 1);

    // filter by service
    const byService = await api('GET', `/v1/projects/${PROJECT}/traces?service=test-service`);
    ok('Filter by service works',            byService.status === 200);

    // filter by agent
    const byAgent = await api('GET', `/v1/projects/${PROJECT}/traces?agent=TestAgent`);
    ok('Filter by agent works',              byAgent.status === 200);

    // detail
    if (traceId) {
        const detail = await api('GET', `/v1/traces/${traceId}`);
        ok('GET /v1/traces/:id → 200',       detail.status === 200);
        ok('Detail has correct id',          detail.body?.id === traceId);
        ok('Detail has requestJson parsed',  detail.body?.request !== undefined);
    }
}

// ─── 6. Kill Switch ───────────────────────────────────────────────────────────

console.log('\n━━━ 6. Kill Switch ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
{
    // Read initial state
    const initial = await api('GET', `/v1/projects/${PROJECT}/killswitch`);
    ok('GET killswitch → 200',               initial.status === 200);
    ok('Has global object',                  typeof initial.body?.global === 'object');
    ok('Has agents array',                   Array.isArray(initial.body?.agents));
    ok('Initial global status is ACTIVE',    initial.body?.global?.status === 'ACTIVE');

    // SDK check endpoint — should be allowed
    const checkAllow = await api('GET', `/v1/projects/${PROJECT}/killswitch/check`);
    ok('Kill-switch check when ACTIVE → allowed', checkAllow.body?.allowed === true);

    // Suspend globally
    const suspend = await api('POST', `/v1/projects/${PROJECT}/killswitch`, {
        status: 'SUSPENDED',
        reason: 'Integration test suspension',
    });
    ok('POST killswitch SUSPENDED → 200',    suspend.status === 200);
    ok('Response shows SUSPENDED',           suspend.body?.global?.status === 'SUSPENDED');

    // Verify trace is now blocked
    const blocked = await api('POST', '/v1/traces', { ...tracePayload, run_id: crypto.randomUUID() });
    ok('Trace blocked when SUSPENDED → 403', blocked.status === 403);
    ok('Error is KILL_SWITCH_ACTIVE',        blocked.body?.error === 'KILL_SWITCH_ACTIVE');
    ok('Scope is global',                    blocked.body?.scope === 'global');

    // SDK check endpoint — should now be blocked
    const checkBlock = await api('GET', `/v1/projects/${PROJECT}/killswitch/check`);
    ok('Kill-switch check when SUSPENDED → not allowed', checkBlock.body?.allowed === false);
    ok('Check returns reason',               typeof checkBlock.body?.reason === 'string');

    // Re-activate
    const activate = await api('POST', `/v1/projects/${PROJECT}/killswitch`, {
        status: 'ACTIVE',
        reason: null,
    });
    ok('POST killswitch ACTIVE → 200',       activate.status === 200);
    ok('Response shows ACTIVE',              activate.body?.global?.status === 'ACTIVE');

    // Per-agent kill switch
    const agentSuspend = await api('POST', `/v1/projects/${PROJECT}/killswitch/agents/TestAgent`, {
        status: 'SUSPENDED',
        reason: 'Testing per-agent switch',
    });
    ok('Per-agent SUSPENDED → 200',          agentSuspend.status === 200);

    // Trace from that agent should be blocked
    const agentBlocked = await api('POST', '/v1/traces', { ...tracePayload, run_id: crypto.randomUUID() });
    ok('Agent trace blocked → 403',          agentBlocked.status === 403);
    ok('Scope is agent',                     agentBlocked.body?.scope === 'agent');

    // Trace from different agent should pass
    const otherAgent = await api('POST', '/v1/traces', {
        ...tracePayload,
        agent_name: 'OtherAgent',
        run_id: crypto.randomUUID(),
    });
    ok('Different agent trace passes → 200', otherAgent.status === 200);

    // Re-activate agent
    await api('POST', `/v1/projects/${PROJECT}/killswitch/agents/TestAgent`, { status: 'ACTIVE' });

    // Invalid status
    const badStatus = await api('POST', `/v1/projects/${PROJECT}/killswitch`, { status: 'INVALID' });
    ok('Invalid status → 400',               badStatus.status === 400);
}

// ─── 7. Policies ─────────────────────────────────────────────────────────────

console.log('\n━━━ 7. Policies ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
let policyId;
{
    const list = await api('GET', `/v1/projects/${PROJECT}/policies`);
    ok('GET /v1/projects/:id/policies → 200', list.status === 200);
    ok('Returns array',                        Array.isArray(list.body));
    ok('Seeded policies exist (≥3)',           list.body?.length >= 3);

    // Create new policy
    const create = await api('POST', `/v1/projects/${PROJECT}/policies`, {
        name:        'Test No Profanity',
        description: 'Block profane language',
        severity:    'high',
        action:      'block',
        enabled:     true,
        rules:       ['detect_profanity', 'block_slurs'],
    });
    ok('POST /v1/policies → 200',             create.status === 200);
    ok('Response has id',                     typeof create.body?.id === 'string');
    ok('Response has name',                   create.body?.name === 'Test No Profanity');
    policyId = create.body?.id;

    // Update it
    if (policyId) {
        const update = await api('PUT', `/v1/projects/${PROJECT}/policies/${policyId}`, {
            severity: 'critical',
            enabled:  false,
        });
        ok('PUT /v1/policies/:id → 200',      update.status === 200);

        // Verify updated
        const updated = await api('GET', `/v1/projects/${PROJECT}/policies`);
        const found = updated.body?.find(p => p.id === policyId);
        ok('Policy severity updated',          found?.severity === 'critical');
        ok('Policy disabled',                  found?.enabled === false);
    }

    // Invalid create
    const bad = await api('POST', `/v1/projects/${PROJECT}/policies`, { name: '' });
    ok('Empty name → 400',                    bad.status === 400);
}

// ─── 8. Violations ───────────────────────────────────────────────────────────

console.log('\n━━━ 8. Violations ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
let violationId;
{
    // Trigger an auto-violation by sending a trace with an error
    const errTrace = await api('POST', '/v1/traces', {
        ...tracePayload,
        run_id:    crypto.randomUUID(),
        error:     'Connection timeout: upstream LLM unreachable',
        latency_ms: 5000,
    });
    ok('Error trace accepted → 200',          errTrace.status === 200);

    // Also trigger high-latency violation
    const latencyTrace = await api('POST', '/v1/traces', {
        ...tracePayload,
        run_id:    crypto.randomUUID(),
        error:     null,
        latency_ms: 8000,
    });
    ok('High-latency trace accepted → 200',   latencyTrace.status === 200);

    await sleep(200);

    const list = await api('GET', `/v1/projects/${PROJECT}/violations`);
    ok('GET /v1/violations → 200',            list.status === 200);
    ok('Returns violations array',             Array.isArray(list.body?.violations));
    ok('Returns summary object',               typeof list.body?.summary === 'object');
    ok('Auto-violations were created',         list.body?.violations?.length >= 1);
    ok('Summary total >= 1',                   list.body?.summary?.total >= 1);
    violationId = list.body?.violations?.[0]?.id;

    // Filter by status
    const open = await api('GET', `/v1/projects/${PROJECT}/violations?status=open`);
    ok('Filter violations by status=open',    open.status === 200 && Array.isArray(open.body?.violations));

    // Update violation status
    if (violationId) {
        const update = await api('PATCH', `/v1/projects/${PROJECT}/violations/${violationId}`, {
            status: 'investigating',
        });
        ok('PATCH violation → investigating → 200', update.status === 200);

        const resolve = await api('PATCH', `/v1/projects/${PROJECT}/violations/${violationId}`, {
            status: 'resolved',
        });
        ok('PATCH violation → resolved → 200',      resolve.status === 200);
        ok('resolvedAt is set',                      resolve.body?.resolvedAt !== null);
    }
}

// ─── 9. Agents ────────────────────────────────────────────────────────────────

console.log('\n━━━ 9. Agents ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
{
    const r = await api('GET', `/v1/projects/${PROJECT}/agents`);
    ok('GET /v1/agents → 200',               r.status === 200);
    ok('Returns array',                       Array.isArray(r.body));
    const agent = r.body?.find(a => a.name === 'TestAgent');
    ok('TestAgent appears in list',           !!agent);
    ok('Agent has calls count',              typeof agent?.calls === 'number');
    ok('Agent has avgLatencyMs',             typeof agent?.avgLatencyMs === 'number');
}

// ─── 10. Stats ────────────────────────────────────────────────────────────────

console.log('\n━━━ 10. Stats ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
{
    const r = await api('GET', `/v1/projects/${PROJECT}/stats`);
    ok('GET /v1/stats → 200',                r.status === 200);
    ok('Has totalTraces',                     typeof r.body?.totalTraces === 'number');
    ok('Has totalTokens',                     typeof r.body?.totalTokens === 'number');
    ok('Has avgLatencyMs',                    typeof r.body?.avgLatencyMs === 'number');
    ok('Has errors count',                    typeof r.body?.errors === 'number');
    ok('Has weeklyVolume array',              Array.isArray(r.body?.weeklyVolume));
    ok('Has killSwitch status',               typeof r.body?.killSwitch?.status === 'string');
}

// ─── 11. SDK class — real traceCall() ─────────────────────────────────────────

console.log('\n━━━ 11. SDK — Leap360 class (traceCall + agent context) ━━━━━━━━━━━');
{
    // Dynamically import the built SDK
    let Leap360;
    try {
        const mod = await import('./sdk-ts/dist/index.js');
        Leap360 = mod.Leap360 ?? mod.default;
    } catch (e) {
        console.warn('  ⚠️  sdk-ts not built yet — building now...');
        const { execSync } = require('child_process');
        execSync('npm run build', {
            cwd: 'c:\\Users\\abodq\\Desktop\\CODES\\ةثص\\LEAP360-SDK\\sdk-ts',
            stdio: 'inherit',
        });
        const mod = await import('./sdk-ts/dist/index.js');
        Leap360 = mod.Leap360 ?? mod.default;
    }

    const leap = new Leap360({
        apiKey:      API_KEY,
        projectId:   PROJECT,
        serviceName: 'sdk-integration-test',
        baseUrl:     BASE,
        silent:      false,
    });

    // traceCall — success path
    const result = await leap.traceCall({
        fn: async () => ({ answer: 42 }),
        provider: 'mock',
        model:    'mock-model-v1',
        agentName: 'SDKTestAgent',
        extractUsage: () => ({ prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }),
    });
    ok('traceCall returns function result',   result?.answer === 42);

    // Verify it appeared in traces
    await sleep(300);
    const traces = await api('GET', `/v1/projects/${PROJECT}/traces?service=sdk-integration-test`);
    ok('traceCall trace landed in API',       traces.body?.data?.length >= 1);
    ok('Correct provider stored',             traces.body?.data?.[0]?.provider === 'mock');

    // traceCall — error path (SDK still posts trace)
    let threw = false;
    try {
        await leap.traceCall({
            fn: async () => { throw new Error('Simulated LLM failure'); },
            provider: 'mock',
            model:    'mock-model-v1',
        });
    } catch { threw = true; }
    ok('traceCall re-throws error',           threw);

    await sleep(300);
    const errTraces = await api('GET', `/v1/projects/${PROJECT}/traces?service=sdk-integration-test`);
    const errEntry = errTraces.body?.data?.find(t => t.error);
    ok('Error trace still posted to API',     !!errEntry);
    ok('Error message stored',               errEntry?.error?.includes('Simulated'));

    // Agent context runner
    const agent = leap.createAgent({ name: 'ContextAgent' });
    await agent.run(async () => {
        await leap.traceCall({
            fn: async () => ({ ok: true }),
            provider: 'mock',
            model:    'mock-model-v2',
        });
    });
    await sleep(300);
    const agentTraces = await api('GET', `/v1/projects/${PROJECT}/traces?agent=ContextAgent`);
    ok('agent.run() tags traces with agent name', agentTraces.body?.data?.length >= 1);

    // Kill-switch integration — suspend then try SDK
    await api('POST', `/v1/projects/${PROJECT}/killswitch`, {
        status: 'SUSPENDED',
        reason: 'SDK kill-switch test',
    });

    let killSwitchThrew = false;
    try {
        await leap.traceCall({
            fn: async () => ({ ok: true }),
            provider: 'mock',
            model:    'mock-model-v1',
        });
    } catch (e) {
        killSwitchThrew = e.message?.includes('KILL_SWITCH_ACTIVE');
    }
    ok('SDK throws when kill-switch active',  killSwitchThrew);

    // Re-activate
    await api('POST', `/v1/projects/${PROJECT}/killswitch`, { status: 'ACTIVE' });
    ok('Kill-switch re-activated',            true);
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(60));
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(60));
if (failed > 0) {
    console.error('\n  Some tests FAILED — see ❌ above for details.\n');
    process.exit(1);
} else {
    console.log('\n  All tests passed! 🎉\n');
}
