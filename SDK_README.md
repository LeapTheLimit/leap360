# Leap360 SDK & Integration Guide

Leap360 is an open-source AI Governance platform that helps you monitor, trace, and govern your AI agents in real-time — fully local, no cloud required. This SDK allows you to easily integrate Leap360 into your TypeScript/JavaScript applications.

## 🚀 Installation

```bash
npm install @leap360/sdk
# or for the CLI:
npm install leap360
```

## 📦 Usage Styles

There are two ways to use the Leap360 SDK: **Auto-wrap** (recommended for speed) and **Manual Tracing** (for full control).

### Setup

Point the SDK at your local Leap360 API server:

```typescript
import { Leap360 } from '@leap360/sdk';

const leap = new Leap360({
  apiKey:      'leap360-dev-secret-key-change-me', // from .env / pnpm seed output
  projectId:   '00000000-0000-0000-0000-000000000001',
  serviceName: 'my-service',
  baseUrl:     'http://localhost:4000', // your local API server
});
```

---

### 1. Auto-wrap Style (Recommended)

The `Leap360` class automatically wraps your LLM clients to trace every call without changing your business logic.

#### OpenAI Integration

```typescript
import { Leap360 } from '@leap360/sdk';
import OpenAI from 'openai';

const leap = new Leap360({
  apiKey:      'leap360-dev-secret-key-change-me',
  projectId:   '00000000-0000-0000-0000-000000000001',
  serviceName: 'chat-service',
});

// Wrap your OpenAI client
const openai = leap.wrapOpenAI(new OpenAI({ apiKey: process.env.OPENAI_API_KEY }));

// Now just use openai as normal — every call is automatically traced!
const completion = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello!' }],
});
console.log(completion.choices[0].message.content);
```

#### Anthropic Integration

```typescript
import Anthropic from '@anthropic-ai/sdk';

const anthropic = leap.wrapAnthropic(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));

const message = await anthropic.messages.create({
  model: 'claude-3-5-sonnet-20241022',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello!' }],
});
console.log(message.content[0].text);
```

#### Google Gemini Integration

```typescript
import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

// Wrap the GenerativeModel instance
const wrappedModel = leap.wrapGemini(model);

const result = await wrappedModel.generateContent('Explain quantum physics.');
console.log(result.response.text());
```

#### Named Agent Runs

Group multiple LLM calls under a named agent with a shared run ID:

```typescript
const agent = leap.createAgent({ name: 'Support Bot' });

await agent.run(async () => {
  // All calls inside here are tagged as 'Support Bot'
  await openai.chat.completions.create({ model: 'gpt-4o', messages: [...] });
  await openai.chat.completions.create({ model: 'gpt-4o', messages: [...] });
});
```

---

### 2. Manual Tracing Style

Use `traceCall` to wrap any async function and manually send traces:

```typescript
const result = await leap.traceCall({
  fn: () => myCustomLLMTask(query),
  provider: 'mistral',
  model: 'mistral-large-latest',
  extractUsage: (res) => ({
    prompt_tokens:     res.usage.prompt_tokens,
    completion_tokens: res.usage.completion_tokens,
    total_tokens:      res.usage.total_tokens,
  }),
});
```

---

## 🔴 Kill Switch

The SDK checks the kill switch before every wrapped call. If the project or agent is suspended, the call throws immediately:

```
[Leap360] KILL_SWITCH_ACTIVE (project): Project is SUSPENDED — reason: Security incident
```

You can also check it manually:

```typescript
await leap.checkKillSwitch();              // check project-level
await leap.checkKillSwitch('Finance-Bot'); // check per-agent
```

---

## 🛠️ CLI

```bash
# Interactive setup — saves config to ~/.leap360/config.json
npx leap360 setup

# Print current saved config
npx leap360 whoami

# Remove saved config
npx leap360 clear
```

---

## 📊 Dashboard

Once your application is sending traces, open the Leap360 dashboard at **http://localhost:5173** to see:

- **Services** — All registered services with trace counts
- **Traces** — Full per-service LLM call history (model, latency, tokens, cost)
- **Kill Switch** — Global + per-agent emergency stop controls
- **Policies** — Define governance rules (block or log)
- **Violations** — Policy breach log with severity and status

---

## 🏗️ Architecture

```
Your App  →  SDK  →  POST /v1/traces       →  SQLite (local)  →  Dashboard
                 ↘  GET  /v1/killswitch    (checked before every call)
```

No data ever leaves your machine. Your LLM API keys go **directly** to the provider.

---

## License

[Apache 2.0](../LICENSE) © 2026 Leap360
