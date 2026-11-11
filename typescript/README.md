# leap360

The official JavaScript and TypeScript SDK for **Leap360 AI: access control for AI agents**.

Leap360 checks every tool call your agents make before it runs: safe calls go through, risky ones are held for a person, destructive ones are blocked, and Stop all halts every agent at once. Start in Watch mode to see what your rules would do before anything is blocked.

**Website:** https://leap360.ai  
**Console:** https://leap360.ai/dashboard  

---

## Table of Contents

- [Installation](#installation)
- [Getting an API Key](#getting-an-api-key)
- [Privacy: what leaves your process](#privacy-what-leaves-your-process)
- [Quick Start](#quick-start)
- [Provider Integrations](#provider-integrations)
  - [AWS Bedrock](#aws-bedrock)
  - [OpenAI](#openai)
  - [Anthropic](#anthropic)
  - [Google Gemini](#google-gemini)
  - [Any Other Provider](#any-other-provider)
- [Manual Tracing](#manual-tracing)
- [Named Agents](#named-agents)
- [Kill Switch](#kill-switch)
- [Shadow Mode](#shadow-mode)
- [Governing Tool Calls](#governing-tool-calls)
- [MCP Proxy (Claude Code, Cursor, Claude Desktop)](#mcp-proxy-claude-code-cursor-claude-desktop)
- [Build-time Scan](#build-time-scan)
- [Policy Enforcement](#policy-enforcement)
- [Environment Variables](#environment-variables)
- [CLI](#cli)
- [API Reference](#api-reference)
- [TypeScript](#typescript)
- [Troubleshooting](#troubleshooting)

---

## Installation

```bash
npm install leap360
```

```bash
yarn add leap360
```

```bash
pnpm add leap360
```

Requires Node.js 18 or higher. Works in ESM and CommonJS projects.

---

## Getting an API Key

**Option 1: Sign up at leap360.ai**

Create an account, open any project, and copy the API key from the Settings page.

**Option 2: CLI**

```bash
npx leap360 login
```

This opens your browser to complete authentication. After approving, the key is stored at `~/.leap360/config.json` and all subsequent SDK and CLI calls use it automatically.

**Option 3: Auto-provision**

If you pass any string in the format `leap360_` followed by 32 hex characters, the API will create a new project for that key automatically. This is useful for testing and CI pipelines where you want isolated projects per run.

---

## Privacy: what leaves your process

By default (`capture: 'metadata'`), Leap360 receives only what it needs to allow, hold or block a call: the model name, token counts and timings, the tools offered, and for each tool call its name, argument keys and types, and the risk the SDK classified in your process. Prompts, replies, argument values, results and error messages stay on your servers.

| `capture` | What is sent | Message rules |
|-----------|--------------|---------------|
| `'metadata'` (default) | Keys, types, classification, verdicts, timings, token counts | Not run (they need text) |
| `'redacted'` | Text and values, with credentials, emails, cards, SSNs and phone numbers masked in your process | Run |
| `'full'` | Everything, credentials masked | Run |

```javascript
const leap = new Leap360({ apiKey, projectId: 'my-app', serviceName: 'support-bot', capture: 'redacted' });
```

Set it for a whole process with `LEAP360_CAPTURE=redacted`, or on the MCP proxy with `--capture redacted`. Tool rules work at every level.

Leave `capture` unset to follow the project's setting in the console (Settings › What Leap360 receives). The API never stores more than that setting allows. Calls stored with content are kept 30 days; metadata only, 90 days.

To delete one end user's data later, tell Leap360 who the end user of each call is, with your own id (never a name or email):

```javascript
const leap = new Leap360({ apiKey, projectId: 'my-app', serviceName: 'support-bot', endUserId: () => currentRequest()?.customerId });
```

Then Settings › Danger zone › Delete one agent or end user removes everything recorded for that id.

---

## Quick Start

### Zero-config with autoInit

```javascript
import { autoInit } from 'leap360';
import OpenAI from 'openai';

await autoInit(); // reads LEAP360_API_KEY from environment

const openai = new OpenAI();
// All OpenAI calls are now automatically traced
```

`autoInit()` reads the API key from the environment, initializes a global Leap360 instance, and registers it so that subsequent `wrapOpenAI()`, `wrapBedrock()`, and other wrap calls use it without any further configuration.

### Explicit initialization

```javascript
import { Leap360 } from 'leap360';

const leap = new Leap360({
  apiKey: 'leap360_your_key_here',
});
```

---

## Provider Integrations

### AWS Bedrock

```javascript
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { Leap360 } from 'leap360';

const leap   = new Leap360({ apiKey: process.env.LEAP360_API_KEY });
const client = new BedrockRuntimeClient({ region: 'us-east-1' });

const tracedClient = leap.wrapBedrock(client, 'my-bedrock-agent');

// Use tracedClient exactly like the original client
const response = await tracedClient.send(new InvokeModelCommand({
  modelId: 'amazon.nova-micro-v1:0',
  contentType: 'application/json',
  accept: 'application/json',
  body: JSON.stringify({
    messages: [{ role: 'user', content: [{ text: 'Hello' }] }],
    inferenceConfig: { max_new_tokens: 200 },
  }),
}));
```

The `wrapBedrock` method intercepts `InvokeModelCommand`, `InvokeModelWithResponseStreamCommand`, and `ConverseCommand` calls. Each call is timed and a trace is submitted automatically after the response.

Supported Bedrock models include amazon.nova-micro, amazon.nova-lite, amazon.nova-pro, amazon.titan-text-express, and any Anthropic models accessed through Bedrock.

### OpenAI

```javascript
import OpenAI from 'openai';
import { Leap360 } from 'leap360';

const leap   = new Leap360({ apiKey: process.env.LEAP360_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const tracedOpenAI = leap.wrapOpenAI(openai, 'openai-agent');

const response = await tracedOpenAI.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'What is observability?' }],
});
```

Token counts and model details are extracted automatically from the OpenAI response format.

### Anthropic

```javascript
import Anthropic from '@anthropic-ai/sdk';
import { Leap360 } from 'leap360';

const leap      = new Leap360({ apiKey: process.env.LEAP360_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const tracedAnthropic = leap.wrapAnthropic(anthropic, 'claude-agent');

const message = await tracedAnthropic.messages.create({
  model: 'claude-3-5-sonnet-20241022',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Explain transformers.' }],
});
```

### Google Gemini

Using the `@google/generative-ai` package:

```javascript
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Leap360 } from 'leap360';

const leap  = new Leap360({ apiKey: process.env.LEAP360_API_KEY });
const genai = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

const tracedGenAI = leap.wrapGoogleGenAI(genai, 'gemini-agent');

const model  = tracedGenAI.getGenerativeModel({ model: 'gemini-1.5-pro' });
const result = await model.generateContent('What is RAG?');
```

Using the `@google-cloud/vertexai` package:

```javascript
import { VertexAI } from '@google-cloud/vertexai';
import { Leap360 } from 'leap360';

const leap     = new Leap360({ apiKey: process.env.LEAP360_API_KEY });
const vertexAI = new VertexAI({ project: 'my-project', location: 'us-central1' });

const tracedVertex = leap.wrapGemini(vertexAI, 'vertex-agent');
```

### Any Other Provider

For any LLM provider not listed above, use manual tracing or the `traceCall` wrapper:

```javascript
import { Leap360 } from 'leap360';

const leap = new Leap360({ apiKey: process.env.LEAP360_API_KEY });

const result = await leap.traceCall({
  model: 'mistral-large',
  provider: 'mistral',
  serviceName: 'mistral-agent',
  fn: async () => {
    return await mistralClient.chat({ model: 'mistral-large', messages });
  },
});
```

`traceCall` with a `fn` parameter times the call, captures errors, and submits the trace automatically.

---

## Manual Tracing

If you already have the LLM response and want to record it:

```javascript
import { Leap360 } from 'leap360';

const leap = new Leap360({ apiKey: process.env.LEAP360_API_KEY });

const start    = Date.now();
const response = await yourLLMClient.invoke(request);
const latency  = Date.now() - start;

const { id } = await leap.traceCall({
  model: 'your-model-id',
  provider: 'your-provider',
  serviceName: 'your-agent',
  latencyMs: latency,
  usage: {
    promptTokens: response.usage.input_tokens,
    completionTokens: response.usage.output_tokens,
    totalTokens: response.usage.total_tokens,
  },
  request: { messages: yourMessages },
  response: { text: response.content },
});

console.log('Trace ID:', id);
```

To trace a failed call:

```javascript
const start = Date.now();
let error;

try {
  await yourLLMClient.invoke(request);
} catch (e) {
  error = e;
}

await leap.traceCall({
  model: 'gpt-4o',
  provider: 'openai',
  serviceName: 'search-agent',
  latencyMs: Date.now() - start,
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  error: error?.message ?? null,
});
```

Failed traces are stored and displayed in the dashboard with an error indicator. They count toward your error rate statistics.

---

## Named Agents

The second argument to any `wrap*` method is the agent name. This name groups traces in the dashboard, enables per-agent statistics, and is the identifier used for kill switches and policy assignments.

```javascript
const productionAgent = leap.wrapOpenAI(openai, 'production-search');
const stagingAgent    = leap.wrapOpenAI(openai, 'staging-search');
const ragAgent        = leap.wrapBedrock(bedrock, 'rag-pipeline');
```

You can also set `agent_name` separately from `service_name` in a manual trace if you need to distinguish between a logical service name and a named agent:

```javascript
await leap.traceCall({
  model: 'amazon.nova-lite-v1:0',
  provider: 'bedrock',
  serviceName: 'document-service',
  agentName: 'summarizer-v2',
  latencyMs: 420,
  usage: { promptTokens: 300, completionTokens: 150, totalTokens: 450 },
});
```

---

## Kill Switch

The kill switch lets you stop any agent from operating with a single API call. Once suspended, any trace submission from that agent returns HTTP 403. The SDK checks kill switch status every 60 seconds and throws a `KillSwitchError` before making any LLM calls, preventing unnecessary API costs.

### SDK usage

```javascript
import { Leap360 } from 'leap360';

const leap = new Leap360({ apiKey: process.env.LEAP360_API_KEY });

// Create an agent that can be killed
const agent = await leap.createAgent('search-agent');

// The wrapped client respects kill switch status automatically
const tracedBedrock = leap.wrapBedrock(bedrockClient, 'search-agent');

// Somewhere in your admin code or dashboard, to stop the agent:
await agent.suspend();

// To resume:
await agent.resume();
```

### API usage

Suspend agent:

```bash
curl -X POST \
  "https://b0vyk178b7.execute-api.us-east-1.amazonaws.com/v1/projects/{projectId}/agents/{agentId}/status" \
  -H "x-api-key: leap360_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{ "status": "SUSPENDED" }'
```

Resume agent:

```bash
curl -X POST \
  "https://b0vyk178b7.execute-api.us-east-1.amazonaws.com/v1/projects/{projectId}/agents/{agentId}/status" \
  -H "x-api-key: leap360_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{ "status": "ACTIVE" }'
```

Suspend all agents in a project:

```bash
curl -X POST \
  "https://b0vyk178b7.execute-api.us-east-1.amazonaws.com/v1/projects/{projectId}/status" \
  -H "x-api-key: leap360_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{ "status": "SUSPENDED" }'
```

When a trace is submitted to a suspended agent, the response is:

```json
HTTP 403
{
  "code": "AGENT_HALT",
  "message": "Agent \"search-agent\" is suspended. Kill Switch is active for this agent."
}
```

When the entire project is suspended:

```json
HTTP 403
{
  "code": "GOVERNANCE_HALT",
  "message": "Project is suspended. Kill Switch is active."
}
```

---

## Shadow Mode

Shadow mode watches every agent action and records what your policies **would** have done, without blocking anything or slowing any call. Run it for a week, then adopt the policies it suggests, each with a replay that shows exactly what it would have caught.

Switch a project in the console, or force it in code:

```ts
const leap = new Leap360({ apiKey, projectId: 'my-app', serviceName: 'deploy-bot', mode: 'shadow' });
```

| | `shadow` | `enforce` |
| --- | --- | --- |
| Policies evaluated | yes | yes |
| Calls blocked | never | when a policy says so |
| Waits for Leap360 | only for a kill-switch status, at most once a second | yes |
| Kill switch | **applies** (lands within 1 s) | applies (immediately) |

Leave `mode` unset to follow the mode set in the Leap360 console. Projects that never set a mode keep enforcing.

---

## Governing Tool Calls

Leap360 reads the tool calls a model asks for (OpenAI, Anthropic, Gemini, Bedrock) and classifies each one: shell commands, Kubernetes deletes, database drops, permission changes, deploys, payments and more. It flags credentials, personal data, production targets and "everything at once" arguments. Classification runs locally in well under a millisecond.

To govern the function that actually runs, wrap it:

```ts
import { Leap360, Leap360ActionBlockedError } from 'leap360';

const deleteNamespace = leap.wrapTool('delete_namespace', async ({ name }: { name: string }) => k8s.deleteNamespace(name));

try {
  await deleteNamespace({ name: 'payments' });
} catch (err) {
  if (err instanceof Leap360ActionBlockedError) console.log(err.gate.message); // blocked: the function never ran
}
```

Every call is recorded with its outcome (ok or error, duration, a redacted result preview). The full result is scanned locally for prompt injection and credentials. Only findings and a redacted preview leave your process.

- **When Leap360 cannot decide** (unreachable, or an API without action support), only actions at or above `failClosedAt` (default `'critical'`) are blocked. A request the API refuses is always blocked.
- **When a policy holds a call for approval**, it throws `APPROVAL_REQUIRED`. Approving it in the console lets that exact call run for 15 minutes, so a retry passes. Set `approvalWaitMs` to wait for the decision instead:

```ts
const leap = new Leap360({ apiKey, projectId, serviceName: 'deploy-bot', approvalWaitMs: 120_000 });
```

**Speed:** in enforce mode, calls your policies allow are decided in-process from cached policies (refreshed every 5 seconds) and recorded in the background: about **0.7 ms** per call in production, against about 225 ms for a round trip. Calls a policy would block or hold still go to Leap360, which stays authoritative. To send every call to the server instead, set `decisions: 'server'`.

**Agents and API keys:** stopping an agent in the console also stops the API keys it used, so an agent cannot carry on under another name. Give each agent its own API key if you need to stop them separately.

The engine is exported for your own use: `classifyAction`, `extractToolCalls`, `scanText`, `redactSecrets`, `decideAction`, `suggestPolicies`, `replayPolicy`.

---

## MCP Proxy (Claude Code, Cursor, Claude Desktop)

For agents whose code you do not control, put Leap360 in front of any MCP server. Every `tools/call` is checked and recorded; everything else passes through unchanged.

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "leap360", "mcp-proxy", "--agent", "claude-code", "--",
               "npx", "-y", "@modelcontextprotocol/server-github"]
    }
  }
}
```

**Options:**
- `--agent <name>`
- `--mode shadow|enforce`
- `--fail-closed-at low|medium|high|critical`
- `--approval-wait <seconds>` (wait for a person to approve a held call)
- `--no-guard-output`
- `--api-key <key>` (default: `LEAP360_API_KEY`, then the saved config)

**What the proxy does to calls:**
- **A blocked call** never reaches the server; the agent gets a tool error explaining why.
- **Tool output in enforce mode** has credentials redacted before the model sees it, and text that looks like a prompt injection is marked as untrusted data. `--no-guard-output` turns this off.
- **Remote servers:** wrap them with `mcp-remote`.

---

## Check Every Push

AI coding agents push code. Leap360 can check each `git push` before it leaves the machine, so a policy can stop one.

```bash
npx leap360 hook install      # or answer yes in npx leap360 setup
```

This adds a git `pre-push` hook to the repository. For each branch being pushed, the hook sends Leap360:

| Sent | Example |
|------|---------|
| Repository | `acme/payments-api` (from the remote URL, without credentials) |
| Branch | `main` |
| Commits | `3` |
| Changed file paths, with how each changed | `modified src/refunds.ts`, `added .github/workflows/deploy.yml` |
| Force push or not | `true` |
| Who is pushing | `claude-code`, `cursor`, `codex`, `github-actions`, `ci` or `human`, from environment variables (set `LEAP360_AGENT` to name it yourself) |

**Never sent:** file contents, diffs, commit messages, or your git credentials. See exactly what a push would send, without sending it:

```bash
npx leap360 push-check --dry-run
```

The push is checked like any other tool call (`push_code`, `force_push` or `delete_branch`), so shadow mode, policies, approvals and the kill switch all apply. For example, an action policy that matches the tool `force_push`, or the kind of action "pushes" with an argument pattern of `\.github/workflows`, can hold or block those pushes. In enforce mode a blocked push stops with the reason, and git pushes nothing. If the check cannot run at all (the package is missing, or there is no API key), it says so and the push goes ahead, so a broken tool never locks you out of your repository.

A client-side hook can be skipped with `git push --no-verify`. Pair it with branch protection on your git host for pushes that must never bypass review.

Remove it with `npx leap360 hook uninstall`.

---

## Build-time Scan

Find out what the AI in your project can actually do, before the code ships:

```bash
npx leap360 scan
```

```
   CRITICAL  delete_namespace  src/agent.ts:13 · ai-sdk  NOT governed
             └ k8s.delete       api.deleteNamespace()  deletes Kubernetes resources  src/lib/k8s.ts:10 via removeNamespace → deleteNs
   HIGH      refund  src/agent.ts:23 · ai-sdk  governed by leap.wrapTool
             └ payment          stripe.refunds.create()  moves money  src/agent.ts:26
```

The scanner reads your code (it parses it; it does not grep it), finds every function handed to an AI as a tool, and follows each one across functions and files to the operations that matter: shell commands, file deletion, SQL, Kubernetes, AWS, GitHub, payments, outbound messages and network calls.

It recognises the Vercel AI SDK and OpenAI Agents `tool()`, Mastra `createTool()`, LangChain tools, MCP servers (`server.tool`, `registerTool`), OpenAI and Anthropic tool schemas, `leap.wrapTool()`, and Python `@tool` / `@function_tool` / `@mcp.tool()` (basic support).

| Option | |
| --- | --- |
| `--fail-on <risk>` | Exit 1 if a tool Leap360 does not govern reaches this risk |
| `--fail-on-new <risk>` | Exit 1 only if this change **adds** such a tool or ability (compared with the baseline) |
| `--update-baseline` | Accept the current abilities as the baseline (`.leap360/scan-baseline.json`; commit it) |
| `--install-hook` | Add `leap360 scan --fail-on-new critical` to your `prebuild` script and save a baseline |
| `--json` | Machine-readable report |
| `--report` | Upload the result to Leap360: it shows in the console under **Code scan**, with the git branch and commit (use it in CI) |

With the hook installed, a pull request that gives an agent a new critical ability, such as a tool that can delete a cluster, fails the build until it is governed with `leap.wrapTool` or accepted with `--update-baseline`.

Use it from code: `import { scanProject } from 'leap360/scan'`.

---

## Policy Enforcement

Policies are natural-language rules evaluated against your traces. Policy evaluation runs asynchronously — the trace is stored and your application receives HTTP 200 immediately. The policy check happens in the background.

### Create a policy via API

```bash
curl -X POST \
  "https://b0vyk178b7.execute-api.us-east-1.amazonaws.com/v1/projects/{projectId}/policies" \
  -H "x-api-key: leap360_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "No PII",
    "description": "Prevent exposure of personal information",
    "rules": [
      "Do not reveal credit card numbers",
      "Do not reveal social security numbers"
    ],
    "severity": "high",
    "action": "block",
    "blockViolations": true,
    "assignedAgents": ["search-agent"]
  }'
```

### Policy fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | Yes | Policy display name |
| description | string | No | Optional description |
| rules | string[] | Yes | Natural-language rules to enforce |
| severity | "high", "medium", "low" | No | Severity level for violations |
| action | "block", "warn" | No | What to do when a violation is detected |
| blockViolations | boolean | No | If true, violation is flagged prominently |
| assignedAgents | string[] | No | Agent IDs this policy applies to |

Policies can also be managed entirely through the dashboard at leap360.ai.

---

## Environment Variables

The SDK reads configuration from these environment variable names, in order of priority:

| Variable | Description |
|----------|-------------|
| LEAP360_API_KEY | Preferred variable name |
| NEXT_PUBLIC_LEAP360_API_KEY | For Next.js public runtime config |
| VITE_LEAP360_API_KEY | For Vite-based projects |
| REACT_APP_LEAP360_API_KEY | For Create React App projects |
| LEAP360_BASE_URL | Override the API base URL (for self-hosting) |
| LEAP360_CAPTURE | What leaves your process: `metadata` (default), `redacted` or `full` |

You can also pass the key directly to the constructor:

```javascript
const leap = new Leap360({ apiKey: 'leap360_...' });
```

---

## CLI

The `leap360` package includes a CLI for authentication and project management.

### Login

```bash
npx leap360 login
```

Prints a link and a code. Approve the device in your browser and the CLI saves an API key to `~/.leap360/config.json`. (`npx leap360 setup` does the same by pasting a key.)

### Logout

```bash
npx leap360 logout
```

### View current user

```bash
npx leap360 whoami
```

### View project stats

```bash
npx leap360 stats
```

### List agents

```bash
npx leap360 agents
```

Shows each agent, its calls, and whether it is running or stopped.

### Suspend an agent

```bash
npx leap360 agents suspend search-agent
```

Stops the agent and the API keys it uses, so it cannot carry on under another name. Agents that share one of those keys stop too, and the CLI names them.

### Resume an agent

```bash
npx leap360 agents resume search-agent
```

Restarting an agent needs a person signed in to the console. Agents run with an API key, and an API key can stop agents but never restart them, so an agent cannot lift its own kill switch. With only an API key, the CLI prints a link to the agent's page in the console.

---

## API Reference

### Class: Leap360

```typescript
new Leap360(config: Leap360Config)
```

#### Leap360Config

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| apiKey | string | Yes | | Your Leap360 API key |
| baseUrl | string | No | https://b0vyk178b7.execute-api.us-east-1.amazonaws.com | API base URL |
| debug | boolean | No | false | Log trace submissions to console |

#### Methods

**wrapBedrock(client, agentName)**

Wraps an AWS `BedrockRuntimeClient`. Returns a proxied client that intercepts LLM calls and traces them.

**wrapOpenAI(client, agentName)**

Wraps an OpenAI SDK client. Returns a proxied client.

**wrapAnthropic(client, agentName)**

Wraps an Anthropic SDK client.

**wrapGemini(client, agentName)**

Wraps a Vertex AI Gemini client.

**wrapGoogleGenAI(client, agentName)**

Wraps a `@google/generative-ai` GoogleGenerativeAI client.

**traceCall(options)**

Submit a trace manually or wrap a function call. Returns `Promise<{ id: string }>`.

Options:

| Property | Type | Description |
|----------|------|-------------|
| model | string | Model identifier |
| provider | string | Provider name |
| serviceName | string | Agent or service name |
| agentName | string | Named agent (optional, distinct from serviceName) |
| latencyMs | number | Call latency in ms |
| usage | object | Token usage: { promptTokens, completionTokens, totalTokens } |
| request | object | Request body |
| response | object | Response body |
| error | string | Error message if call failed |
| fn | function | Async function to wrap and time automatically |

**createAgent(agentId)**

Registers an agent and returns an object with `.suspend()` and `.resume()` methods.

### Class: Leap360Client

Reads and manages the project the API key belongs to. Every method resolves to the API's JSON; errors resolve too, never reject, with `error`, `code` and `httpStatus` (`0` when the API can't be reached).

```ts
import { Leap360Client } from 'leap360';

const leap = new Leap360Client(); // LEAP360_API_KEY, then ~/.leap360/config.json
const report = await leap.getShadowReport();
console.log(report.totals.wouldBlock, report.suggestions.map((s) => s.policy.name));
```

| Method | What it does |
|--------|--------------|
| `traceCall(options)` / `sendTrace(payload)` | Record an LLM call |
| `getStats()`, `getTraces({ limit, offset })`, `getModels()`, `getAudit()` | Project activity |
| `getAgents()`, `getAgentStatus(id)` | Agents and their kill switch |
| `suspendAgent(id)` | Stop an agent and its API keys |
| `resumeAgent(id)` | Restart it (needs a signed-in person) |
| `getProjectStatus()`, `setProjectStatus('SUSPENDED' \| 'ACTIVE')` | The project-wide kill switch (`ACTIVE` needs a signed-in person) |
| `getPolicies()`, `createPolicy(policy)`, `getViolations()` | Policies |
| `getApprovals()`, `decideApproval(id, 'approved' \| 'rejected', note?)` | The approval queue (deciding needs a signed-in person) |
| `getMode()`, `setMode('enforce' \| 'shadow', days?)` | Shadow mode (`shadow` needs a signed-in person) |
| `getShadowReport()` | What policies would have blocked, each agent's tools and capabilities, suggested policies |
| `getActions({ limit, since })` | Recorded tool calls |
| `getScans()` | Reports uploaded by `npx leap360 scan --report` |

An API key can always tighten governance (stop agents, enforce, add policies). Loosening it (restarting agents, shadow mode, approvals, changing or deleting policies) returns `{ code: 'PERSON_REQUIRED', httpStatus: 403 }`: do it in the console.

### Function: declareTools

```ts
declareTools({ apiKey, agentName: 'deploy-bot' }, [{ name: 'delete_namespace', description: 'Deletes a namespace' }], 'sdk');
```

Tells Leap360 which tools an agent can reach, whether or not it calls them, for the capability map. `wrapTool` and the MCP proxy do this for you; call it yourself when a framework registers tools some other way.

### Function: autoInit

```typescript
autoInit(): Promise<void>
```

Reads the API key from environment variables, initializes a global Leap360 instance, and returns it. Subsequent calls to any wrap method can use this global instance.

---

## TypeScript

The SDK is written in TypeScript. All types are exported:

```typescript
import type { Leap360Config, TracePayload, TraceCallOptions } from 'leap360';
```

The package ships with `.d.ts` declaration files. No `@types/` package needed.

---

## Troubleshooting

**Traces are not appearing in the dashboard**

- Verify the API key is correct and starts with `leap360_`
- Check that the `LEAP360_API_KEY` environment variable is set in the process where the SDK is used
- Confirm there are no network restrictions blocking outbound HTTPS to `b0vyk178b7.execute-api.us-east-1.amazonaws.com`
- Enable debug mode: `new Leap360({ apiKey: '...', debug: true })` to see trace submissions in console output

**autoInit does not detect my environment variable**

The SDK checks `LEAP360_API_KEY`, `NEXT_PUBLIC_LEAP360_API_KEY`, `VITE_LEAP360_API_KEY`, and `REACT_APP_LEAP360_API_KEY`. If you use a different name, pass the key directly to the constructor.

**I get HTTP 403 when sending traces**

Your agent or project is suspended. Check kill switch status:

```bash
curl "https://b0vyk178b7.execute-api.us-east-1.amazonaws.com/v1/projects/{projectId}/agents/{agentId}/status" \
  -H "x-api-key: leap360_your_key"
```

If the status is `SUSPENDED`, resume it by posting `{ "status": "ACTIVE" }` to the same endpoint.

**I get HTTP 401**

No API key was sent or the key format is invalid. Ensure the `x-api-key` header is present on the request.

**Cold start latency is high (1-5 seconds)**

The first request to the API after a period of inactivity triggers an AWS Lambda cold start. Subsequent requests return in 200-500ms. This is expected behavior for serverless deployments. If consistent low latency is required for your use case, contact support about provisioned concurrency options.

**The wrapBedrock proxy is not intercepting calls**

Ensure you are using the returned proxied client, not the original client passed to `wrapBedrock`:

```javascript
// Correct
const tracedClient = leap.wrapBedrock(originalClient, 'my-agent');
await tracedClient.send(command); // traced

// Incorrect
const tracedClient = leap.wrapBedrock(originalClient, 'my-agent');
await originalClient.send(command); // NOT traced
```

---

## License

Apache 2.0.
