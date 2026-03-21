# Leap360 SDK & Integration Guide

Leap360 is an AI Governance platform that helps you monitor, trace, and govern your AI agents in real-time. This SDK allows you to easily integrate Leap360 into your TypeScript/JavaScript applications.

## 🚀 Installation

```bash
npm install leap360-sdk
```

## 📦 Usage Styles

There are two ways to use the Leap360 SDK: **Auto-wrap** (recommended for speed) and **Manual Tracing** (for full control).

### 1. Auto-wrap Style (Recommended)

The `Leap360` class can automatically wrap your LLM clients (OpenAI, Gemini) to trace every call without changing your business logic.

#### OpenAI Integration

```typescript
import { Leap360 } from 'leap360-sdk';
import OpenAI from 'openai';

const leap = new Leap360({
  apiKey: 'your-api-key',
  projectId: 'my-project',
  serviceName: 'chat-service'
});

// Wrap your OpenAI client
const openai = leap.wrapOpenAI(new OpenAI());

// Now just use openai as normal — it's automatically traced!
const completion = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

#### Google Gemini Integration

```typescript
import { Leap360 } from 'leap360-sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';

const leap = new Leap360({ ... });
const genAI = leap.wrapGemini(new GoogleGenerativeAI('YOUR_API_KEY'));

const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
const result = await model.generateContent('Explain quantum physics.');
console.log(result.response.text());
```

#### Named Agent Runs

You can group multiple LLM calls under a named agent and a single run ID:

```typescript
const agent = leap.createAgent({ name: 'Support Bot' });

await agent.run(async (client) => {
  // All calls inside here are tagged as 'Support Bot'
  await openai.chat.completions.create({ ... });
  await openai.chat.completions.create({ ... });
});
```

---

### 2. Manual Tracing Style

Use the `Leap360Client` if you want to manually send traces or wrap specific functions. This class defaults to reading your credentials from `~/.leap360/config.json` (set via `leap360 login` in the CLI).

```typescript
import { Leap360Client } from 'leap360-sdk';

const client = new Leap360Client();

const result = await client.traceCall({
  agentName: 'Researcher',
  provider: 'openai',
  model: 'gpt-4o',
  fn: () => myComplexLLMTask(query)
});
```

---

## 🔐 CLI Authentication

If you are using the `Leap360Client` without providing an API key in the constructor, you can authenticate via our CLI:

```bash
# Log in via browser
npx leap360 login

# Check status
npx leap360 status

# Log out
npx leap360 logout
```

## 📊 Viewing Results

Once your application is sending traces, head over to your Leap360 Dashboard to see:
- **Live Monitor:** Real-time stream of all AI activity.
- **Rules & Violations:** Instant alerts when agents fail or exceed latency limits.
- **Model Registry:** Automatic tracking of model usage, costs, and performance.
- **Audit Trail:** A permanent, secure record of every AI decision.
