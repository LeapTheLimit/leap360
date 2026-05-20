/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   Leap360 SDK — Real Multi-Agent System · Google gemini-3.5-flash       ║
 * ║                                                                          ║
 * ║   4 specialised AI agents collaborate in a research pipeline:            ║
 * ║     1. PlannerAgent  — decomposes the topic into 3 research questions    ║
 * ║     2. ResearchAgent — answers each question with detailed analysis      ║
 * ║     3. CriticAgent   — challenges the research, finds gaps               ║
 * ║     4. EditorAgent   — synthesises everything into a final report        ║
 * ║                                                                          ║
 * ║   Every LLM call is:                                                     ║
 * ║     • Kill-switch checked before execution                               ║
 * ║     • Traced to Leap360 with agent name, latency, tokens                 ║
 * ║     • Visible live at http://localhost:5173                              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { GoogleGenerativeAI } from './sdk-ts/node_modules/@google/generative-ai/dist/index.mjs';
import { Leap360 } from './sdk-ts/dist/index.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const GEMINI_KEY = 'AIzaSyAX-1hYrwWh-_WZP9w8fhQD_44M3t5MaRA';
const MODEL      = 'gemini-3.5-flash';   // newest model confirmed working on this key
const LEAP_KEY   = 'leap360-dev-secret-key-change-me';
const PROJECT_ID = '00000000-0000-0000-0000-000000000001';
const LEAP_URL   = 'http://localhost:4000';

const TOPIC = 'The impact of AI agents on software engineering workflows in 2025-2026';

// ─── Clients ──────────────────────────────────────────────────────────────────

const genAI = new GoogleGenerativeAI(GEMINI_KEY);

const leap = new Leap360({
    apiKey:      LEAP_KEY,
    projectId:   PROJECT_ID,
    serviceName: 'multi-agent-research-pipeline',
    baseUrl:     LEAP_URL,
    silent:      false,
});

// ─── Agent handles ────────────────────────────────────────────────────────────

const plannerAgent  = leap.createAgent({ name: 'PlannerAgent'  });
const researchAgent = leap.createAgent({ name: 'ResearchAgent' });
const criticAgent   = leap.createAgent({ name: 'CriticAgent'   });
const editorAgent   = leap.createAgent({ name: 'EditorAgent'   });

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function banner(title) {
    const pad = '─'.repeat(68);
    console.log(`\n${pad}\n  ${title}\n${pad}`);
}

/**
 * Call Gemini directly (raw REST — no SDK wrapper here, Leap360 traceCall wraps it).
 * Retries on 429 with exponential back-off.
 */
async function callGemini(systemInstruction, userPrompt, retries = 5) {
    const model = genAI.getGenerativeModel({ model: MODEL, systemInstruction });
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const result = await model.generateContent(userPrompt);
            return result.response.text().trim();
        } catch (err) {
            const is429 = err?.status === 429 || String(err?.message).includes('429');
            if (is429 && attempt < retries) {
                const wait = attempt * 10_000;
                console.log(`   ⏳  Rate-limited — waiting ${wait / 1000}s (retry ${attempt}/${retries - 1})...`);
                await sleep(wait);
            } else {
                throw err;
            }
        }
    }
}

/**
 * Run a Gemini call inside a named agent context so Leap360 tags the trace
 * with the correct agentName and checks the kill-switch automatically.
 */
async function agentCall(agentHandle, systemInstruction, userPrompt) {
    return agentHandle.run(async () => {
        // callGemini returns a plain string — wrap it in an object so the
        // Leap360 trace schema (which expects response: object) is satisfied.
        const text = await leap.traceCall({
            fn: async () => {
                const raw = await callGemini(systemInstruction, userPrompt);
                // Return as object so Leap360 stores it correctly
                return { text: raw };
            },
            provider: 'google',
            model: MODEL,
            extractUsage: () => ({
                prompt_tokens:     Math.ceil((systemInstruction.length + userPrompt.length) / 4),
                completion_tokens: 0,
                total_tokens:      Math.ceil((systemInstruction.length + userPrompt.length) / 4),
            }),
        });
        // Unwrap back to string for the pipeline to use
        return typeof text === 'object' ? text.text : text;
    });
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────

async function run() {
    console.log('\n╔══════════════════════════════════════════════════════════════════════════╗');
    console.log('║       Leap360 SDK  ·  Real Multi-Agent Research Pipeline  ·  LIVE       ║');
    console.log('╚══════════════════════════════════════════════════════════════════════════╝');
    console.log(`\n  🤖  Model   : ${MODEL}`);
    console.log(`  📋  Topic   : ${TOPIC}`);
    console.log(`  🔗  Traces  : http://localhost:5173`);
    console.log(`  🛡️  Governed by Leap360 SDK\n`);

    // ── 0. Pre-flight governance check ───────────────────────────────────────
    banner('0 · Pre-flight Kill-Switch Check');
    await leap.checkKillSwitch();
    console.log('  ✅  Kill-switch is ACTIVE — pipeline cleared to run');

    // ── 1. PlannerAgent: decompose topic into 3 questions ────────────────────
    banner('1 · PlannerAgent  —  Decomposing the research topic');
    console.log('  🧩  Thinking...\n');

    const planRaw = await agentCall(
        plannerAgent,
        `You are an expert research planner.
Your ONLY job is to break a topic into exactly 3 focused, non-overlapping research questions.
Output format: a JSON array of 3 strings. Nothing else. No markdown. No explanation.
Example: ["Question one?","Question two?","Question three?"]`,
        `Topic: "${TOPIC}"\n\nOutput the JSON array of 3 research questions now.`
    );

    let questions;
    try {
        const clean = planRaw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
        questions = JSON.parse(clean);
        if (!Array.isArray(questions)) throw new Error('not array');
        questions = questions.slice(0, 3).map(String);
    } catch {
        // Fallback: extract numbered lines
        questions = planRaw
            .split('\n')
            .map(l => l.replace(/^[\d\.\-\*\s"']+/, '').replace(/["']$/, '').trim())
            .filter(l => l.length > 10)
            .slice(0, 3);
        if (questions.length < 3) {
            questions = [
                'How are AI coding agents (GitHub Copilot, Cursor, Devin) changing day-to-day developer workflows?',
                'What governance and safety challenges arise from autonomous AI agents in production software pipelines?',
                'Which AI agent frameworks and architectures are most widely adopted in 2025-2026 and why?',
            ];
        }
    }

    console.log(`  📋  Research plan (${questions.length} questions):`);
    questions.forEach((q, i) => console.log(`\n     ${i + 1}. ${q}`));

    await sleep(2000);

    // ── 2. ResearchAgent: answer each question ────────────────────────────────
    banner('2 · ResearchAgent  —  Deep-diving each question');

    const answers = [];
    for (let i = 0; i < questions.length; i++) {
        console.log(`\n  🔍  Q${i + 1}: "${questions[i]}"`);
        const answer = await agentCall(
            researchAgent,
            `You are a senior technology research analyst specialising in AI and software engineering.
Write a concise, factual, insightful answer (3-4 sentences). Use specific examples and real products.
Do not repeat the question. Start directly with the answer.`,
            `Research question: ${questions[i]}`
        );
        console.log(`\n  💡  A${i + 1}: ${answer}`);
        answers.push({ question: questions[i], answer });
        if (i < questions.length - 1) await sleep(3000);
    }

    await sleep(2000);

    // ── 3. CriticAgent: challenge the research ────────────────────────────────
    banner('3 · CriticAgent  —  Challenging the research');
    console.log('  🔎  Reviewing for gaps and counterarguments...\n');

    const researchBlock = answers
        .map((a, i) => `Q${i + 1}: ${a.question}\nA: ${a.answer}`)
        .join('\n\n');

    const critique = await agentCall(
        criticAgent,
        `You are a critical thinking expert and devil's advocate.
Identify the 3 most important gaps, risks, or overlooked perspectives in this research.
Format: exactly 3 bullet points starting with "•". Be sharp and specific.`,
        `Review this research:\n\n${researchBlock}`
    );

    console.log('  🗡️  Critique:\n');
    critique.split('\n').forEach(l => console.log(`     ${l}`));

    await sleep(2000);

    // ── 4. EditorAgent: synthesise final report ───────────────────────────────
    banner('4 · EditorAgent  —  Writing the final report');
    console.log('  ✍️   Synthesising...\n');

    const report = await agentCall(
        editorAgent,
        `You are a senior technical writer.
Synthesise the research and critique into a polished report with this exact structure:

## Executive Summary
(2-3 sentences covering the main insight)

## Key Findings
• Finding 1
• Finding 2
• Finding 3

## Critical Considerations
• Risk/gap 1
• Risk/gap 2

## Conclusion
(1-2 sentences with a forward-looking statement)

Be concise, professional, and insightful. Use the research to back every claim.`,
        `Topic: ${TOPIC}\n\nResearch:\n${researchBlock}\n\nCritique:\n${critique}`
    );

    console.log('\n' + '═'.repeat(70));
    console.log('  📄  FINAL REPORT');
    console.log('═'.repeat(70) + '\n');
    report.split('\n').forEach(l => console.log('  ' + l));
    console.log('\n' + '═'.repeat(70));

    // ── 5. Kill-switch demo ───────────────────────────────────────────────────
    banner('5 · Kill-Switch Demo  —  Emergency Stop');

    console.log('  🔴  Suspending project (simulating security incident)...');
    await fetch(`${LEAP_URL}/v1/projects/${PROJECT_ID}/killswitch`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-leap360-key': LEAP_KEY },
        body:    JSON.stringify({ status: 'SUSPENDED', reason: 'Demo: emergency stop activated' }),
    });

    let blocked = false;
    try {
        await agentCall(
            researchAgent,
            'You are a helpful assistant.',
            'This call should be blocked by the kill-switch.'
        );
    } catch (err) {
        blocked = err.message?.includes('KILL_SWITCH_ACTIVE');
        console.log(`\n  ✅  SDK correctly blocked the call:`);
        console.log(`     "${err.message}"`);
    }

    if (!blocked) console.log('  ❌  Kill-switch did not block the call!');

    // Re-activate
    await fetch(`${LEAP_URL}/v1/projects/${PROJECT_ID}/killswitch`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-leap360-key': LEAP_KEY },
        body:    JSON.stringify({ status: 'ACTIVE' }),
    });
    console.log('\n  🟢  Kill-switch re-activated — project is ACTIVE again');

    // ── 6. Governance summary ─────────────────────────────────────────────────
    banner('6 · Governance Summary');

    await sleep(500);
    const [tracesRes, violationsRes, statsRes] = await Promise.all([
        fetch(`${LEAP_URL}/v1/projects/${PROJECT_ID}/traces?service=multi-agent-research-pipeline&limit=50`,
            { headers: { 'x-leap360-key': LEAP_KEY } }).then(r => r.json()),
        fetch(`${LEAP_URL}/v1/projects/${PROJECT_ID}/violations`,
            { headers: { 'x-leap360-key': LEAP_KEY } }).then(r => r.json()),
        fetch(`${LEAP_URL}/v1/projects/${PROJECT_ID}/stats`,
            { headers: { 'x-leap360-key': LEAP_KEY } }).then(r => r.json()),
    ]);

    const pTraces = tracesRes.data ?? [];
    const agentCounts = {};
    let totalLatency = 0;
    for (const t of pTraces) {
        const name = t.agentName || '(no agent)';
        agentCounts[name] = (agentCounts[name] || 0) + 1;
        totalLatency += t.latencyMs ?? 0;
    }

    console.log(`\n  📊  Pipeline traces     : ${pTraces.length}`);
    console.log(`  ⚡  Avg latency (total) : ${pTraces.length ? Math.round(totalLatency / pTraces.length) : 0}ms`);
    console.log(`  🚨  Violations logged   : ${violationsRes.summary?.total ?? 0}`);
    console.log(`  🛡️  Kill-switch status  : ${statsRes.killSwitch?.status ?? 'ACTIVE'}`);
    console.log(`\n  🤖  Agent call breakdown:`);
    for (const [agent, count] of Object.entries(agentCounts)) {
        console.log(`       ${agent.padEnd(22)} ${count} call(s)`);
    }

    console.log('\n  🔗  View all traces → http://localhost:5173');
    console.log('\n  ✅  Pipeline complete!\n');
}

// ─── Entry point ─────────────────────────────────────────────────────────────

run().catch(err => {
    console.error('\n  ❌  Pipeline failed:', err.message ?? err);
    process.exit(1);
});
