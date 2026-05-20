# Leap360 — Open-Source AI Governance SDK

> Real-time observability, kill-switch controls, policy enforcement, and violation tracking for your AI applications — **fully local, zero cloud dependency**.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-v18%2B-green)](https://nodejs.org)
[![pnpm](https://img.shields.io/badge/pnpm-workspace-orange)](https://pnpm.io)

---

## ✨ What is Leap360?

Leap360 is an **open-source AI governance platform** that lets you:

- 📡 **Trace every LLM call** — provider, model, tokens, latency, cost
- 🔴 **Kill Switch** — instantly suspend all AI calls (global or per-agent)
- 🛡️ **Policy Enforcement** — define rules that block or log violations at runtime
- 🚨 **Violation Log** — full history of policy breaches with severity and status
- 📊 **Web Dashboard** — built-in React UI at `http://localhost:5173`

Everything runs **on your machine** using SQLite — no Postgres, no Redis, no cloud account required.

---

## 🚀 Quick Start (< 5 minutes)

### Prerequisites

- **Node.js** v18+
- **pnpm** — `npm i -g pnpm`

### 1. Clone

```bash
git clone https://github.com/LeapTheLimit/LEAP360-SDK.git
cd LEAP360-SDK
pnpm install
```

### 2. Configure

```bash
cp .env.example .env
# The defaults work out of the box — no changes needed for local dev
```

### 3. Initialize the Database

```bash
pnpm migrate   # creates api/prisma/dev.db (SQLite)
pnpm seed      # adds a default project + API key
```

### 4. Start

```bash
pnpm dev
```

| Service | URL |
|---------|-----|
| API | http://localhost:4000 |
| Dashboard | http://localhost:5173 |

### 5. Send a Test Trace

```bash
cd example
pnpm install
pnpm start
```

Open the dashboard — you'll see your first trace appear in real time.

---

## 📦 SDK Usage

### TypeScript / JavaScript

```bash
npm install leap360
# or: pnpm add leap360
```

```typescript
import { Leap360 } from 'leap360';

const leap = new Leap360({
  apiKey:      'leap360-dev-secret-key-change-me',
  projectId:   '00000000-0000-0000-0000-000000000001',
  serviceName: 'my-service',
  baseUrl:     'http://localhost:4000',   // your local server
});

// Wrap any supported client
const openai = leap.wrapOpenAI(new OpenAI({ apiKey: process.env.OPENAI_API_KEY }));

const response = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

### Python

```bash
pip install leap360
```

```python
from leap360 import Leap360Tracer
from openai import OpenAI

tracer = Leap360Tracer(
    api_key="leap360-dev-secret-key-change-me",
    project_id="00000000-0000-0000-0000-000000000001",
    service_name="my-service",
    base_url="http://localhost:4000",
)

client = tracer.wrap(OpenAI())

response = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)
```

### Supported Providers

| Provider | TypeScript | Python |
|----------|-----------|--------|
| OpenAI | `leap.wrapOpenAI(client)` | `tracer.wrap(OpenAI())` |
| Anthropic | `leap.wrapAnthropic(client)` | `tracer.wrap(Anthropic())` |
| Google Gemini | `leap.wrapGoogleGenAI(client)` | `tracer.wrap(genai_client)` |
| AWS Bedrock | — | `tracer.wrap(boto3_bedrock_client)` |
| Any other | `leap.traceCall(fn, opts)` | `tracer.trace_call(fn=..., provider=..., model=...)` |

---

## 🔴 Kill Switch

Stop all AI calls instantly — from the dashboard or via API:

```bash
# Suspend the entire project
curl -X POST http://localhost:4000/v1/projects/{projectId}/killswitch \
  -H "x-leap360-key: leap360-dev-secret-key-change-me" \
  -H "Content-Type: application/json" \
  -d '{"status":"SUSPENDED","reason":"Security incident"}'

# Suspend a single agent
curl -X POST http://localhost:4000/v1/projects/{projectId}/killswitch/agents/finance-bot \
  -H "x-leap360-key: leap360-dev-secret-key-change-me" \
  -H "Content-Type: application/json" \
  -d '{"status":"SUSPENDED","reason":"Anomaly detected"}'
```

When suspended, any SDK call immediately throws:
```
[Leap360] KILL_SWITCH_ACTIVE: Project is SUSPENDED — reason: Security incident
```

---

## 🛡️ Policy Enforcement

Create a policy (from the dashboard or API):

```bash
curl -X POST http://localhost:4000/v1/projects/{projectId}/policies \
  -H "x-leap360-key: leap360-dev-secret-key-change-me" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "No PII",
    "description": "Block responses containing personal identifiable information",
    "severity": "high",
    "action": "block",
    "rules": ["detect_pii", "block_ssn", "block_credit_card"]
  }'
```

Policy actions:
- `"block"` — throws an error before the response reaches your code
- `"log"` — records the violation but allows the response through

---

## 🖥️ Dashboard Pages

| Page | Path | Description |
|------|------|-------------|
| Services | `/services` | All registered services + trace counts |
| Traces | `/services/:id/traces` | Per-service LLM call history |
| Violations | `/violations` | Policy breach log with severity & status |
| Policies | `/policies` | Create, edit, enable/disable governance rules |
| Kill Switch | `/killswitch` | Global + per-agent emergency stop controls |

---

## 🏗️ Architecture

```
LEAP360-SDK/
├── api/            # Fastify REST API (SQLite via Prisma ORM)
│   ├── prisma/     # schema.prisma + migrations + dev.db
│   └── src/
│       ├── routes/ # traces, services, killswitch, policies, violations
│       └── server.ts
├── web/            # React + Vite dashboard (Tailwind CSS)
│   └── src/pages/
├── sdk-ts/         # TypeScript SDK source
├── sdk-py/         # Python SDK source
├── src/            # CLI  (npx leap360 setup | whoami | clear)
└── example/        # Runnable demo
```

### Data Flow

```
Your App  →  SDK  →  POST /v1/traces  →  SQLite  →  Dashboard
                 ↘  GET  /v1/killswitch  (checked before every call)
```

No data ever leaves your machine. Your LLM API keys go **directly** to the provider — not through Leap360.

---

## � Default Credentials

These are set in `.env` and seeded into the local database automatically:

| Setting | Default Value |
|---------|--------------|
| API Key | `leap360-dev-secret-key-change-me` |
| Project ID | `00000000-0000-0000-0000-000000000001` |
| API Port | `4000` |
| Dashboard Port | `5173` |

> **Change the API key** before exposing the server on a shared network.

---

## 🛠️ CLI

```bash
npx leap360 setup    # interactive config → ~/.leap360/config.json
npx leap360 whoami   # print current config
npx leap360 clear    # remove saved config
```

---

## 📖 Full Documentation

- [HowToRun.md](./HowToRun.md) — Step-by-step setup guide
- [CONTRIBUTING.md](./CONTRIBUTING.md) — How to contribute
- [sdk-ts README](./sdk-ts/README.md) — TypeScript SDK reference  
- [sdk-py README](./sdk-py/README.md) — Python SDK reference

---

## 🤝 Contributing

Pull requests are welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

---

## 📜 License

[Apache 2.0](./LICENSE) © 2026 Leap360
