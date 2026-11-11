#!/usr/bin/env node
/**
 * leap360 — CLI entry point
 *
 * Commands:
 *   leap360 setup    — interactive setup to configure API key
 *   leap360 status   — show current configuration
 *   leap360 mcp-proxy — put an MCP server behind Leap360
 *   leap360 scan      — find what the AI in this project can do, before it ships
 *   leap360 --version
 */

import { Command } from 'commander';
import { saveCredentials, loadCredentials, clearCredentials, startDeviceAuth, pollForApproval } from './auth.js';
import { Leap360Client } from './sdk.js';
import { verifyReceipts, type SignedReceipt } from './receipts.js';
import * as readline from 'readline';
import { runMcpProxy } from './mcp-proxy.js';
import { scanProject, formatReport, readBaseline, writeBaseline, diffBaseline, newRiskAtOrAbove, installPrebuildHook, DEFAULT_BASELINE } from './scan.js';
import { riskRank, type RiskLevel } from './actions.js';
import * as nodePath from 'node:path';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync as writeFileSyncNode } from 'node:fs';
import { installPushHook, pushCheck } from './pushcheck.js';
import { CLOUD_API_URL } from './config.js';

const program = new Command();

program
  .name('leap360')
  .description('Leap360 AI Governance SDK CLI')
  .version('1.10.0')
  .enablePositionalOptions();

// ─── Command: setup ────────────────────────────────────────────────────────
program
  .command('setup')
  .description('Interactive setup: configure your Leap360 API key')
  .action(async () => {
    console.log('\n🔐  Leap360 Setup\n');
    console.log('   Welcome! Let\'s configure your API key.\n');
    console.log('   Get your API key from: \x1b[1m\x1b[34mhttps://leap360.ai/dashboard/\x1b[0m → Settings\n');

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const askQuestion = (query: string): Promise<string> => {
      return new Promise((resolve) => {
        rl.question(query, (answer) => resolve(answer.trim()));
      });
    };

    try {
      const apiKey = await askQuestion('   Enter your API key: ');
      
      if (!apiKey || !apiKey.startsWith('leap360_')) {
        console.error('\n❌  Invalid API key. It should start with "leap360_"\n');
        rl.close();
        process.exit(1);
      }

      const projectId = await askQuestion('   Enter project ID (default: default): ') || 'default';
      const serviceName = await askQuestion('   Enter service name (default: my-service): ') || 'my-service';

      // Generate a userId from the API key hash
      const crypto = await import('crypto');
      const userId = crypto.createHash('sha256').update(apiKey).digest('hex').substring(0, 32);

      saveCredentials({
        apiKey,
        userId,
        projectId,
        serviceName,
      });

      // Also save to .env file for the project
      const fs = await import('fs');
      const path = await import('path');
      const envPath = path.join(process.cwd(), '.env');
      
      let envContent = '';
      if (fs.existsSync(envPath)) {
        envContent = fs.readFileSync(envPath, 'utf8');
      }

      // ── Auto-detect bundler/framework to write the correct env var prefix ──
      // Vite requires VITE_, Next.js requires NEXT_PUBLIC_, CRA requires REACT_APP_
      let browserPrefix = '';
      let bundlerName = 'Node.js / backend';
      const cwd = process.cwd();
      const packageJsonPath = path.join(cwd, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
          const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
          if (allDeps['vite'] || allDeps['@vitejs/plugin-react']) {
            browserPrefix = 'VITE_';
            bundlerName = 'Vite';
          } else if (allDeps['next']) {
            browserPrefix = 'NEXT_PUBLIC_';
            bundlerName = 'Next.js';
          } else if (allDeps['react-scripts']) {
            browserPrefix = 'REACT_APP_';
            bundlerName = 'Create React App';
          }
        } catch { /* ignore parse errors */ }
      }

      // Always write the plain LEAP360_ vars (for server-side / Node use)
      const leapVars = [
        `LEAP360_API_KEY=${apiKey}`,
        `LEAP360_PROJECT_ID=${projectId}`,
        `LEAP360_SERVICE_NAME=${serviceName}`,
        `LEAP360_USER_ID=${userId}`,
      ];

      // If a browser bundler was detected, also write the prefixed vars
      const browserVars = browserPrefix ? [
        `${browserPrefix}LEAP360_API_KEY=${apiKey}`,
        `${browserPrefix}LEAP360_PROJECT_ID=${projectId}`,
        `${browserPrefix}LEAP360_SERVICE_NAME=${serviceName}`,
        `${browserPrefix}LEAP360_USER_ID=${userId}`,
      ] : [];

      const allVars = [...leapVars, ...browserVars];
      
      for (const v of allVars) {
        const key = v.split('=')[0];
        if (envContent.includes(key + '=')) {
          envContent = envContent.replace(new RegExp(`${key}=.*`, 'g'), v);
        } else {
          envContent += '\n' + v;
        }
      }
      
      // Note: Customers should provide their own GEMINI_API_KEY via their environment
      
      fs.writeFileSync(envPath, envContent.trim() + '\n');
      
      if (browserPrefix) {
        console.log(`\n   \x1b[36m📦 Detected ${bundlerName} — also wrote ${browserPrefix}LEAP360_* vars for browser bundle\x1b[0m`);
      }

      console.log('\n✅  Configuration saved!\n');
      console.log(`   → ~/.leap360/config.json (SDK config)`);
      console.log(`   → ${envPath} (environment variables)\n`);

      // ── Generate .leap360/ folder with integration guides ──────────────
      const guideDir = path.join(process.cwd(), '.leap360');
      try { fs.mkdirSync(guideDir, { recursive: true }); } catch { /* exists */ }

      // README.md — main guide
      const envVarNote = browserPrefix
        ? `# Browser bundle (${bundlerName}) — use these in your frontend code\n${browserPrefix}LEAP360_API_KEY=${apiKey}\n${browserPrefix}LEAP360_PROJECT_ID=${projectId}\n${browserPrefix}LEAP360_SERVICE_NAME=${serviceName}\n\n# Server-side / Node — use these in backend/functions\nLEAP360_API_KEY=${apiKey}\nLEAP360_PROJECT_ID=${projectId}\nLEAP360_SERVICE_NAME=${serviceName}`
        : `LEAP360_API_KEY=${apiKey}\nLEAP360_PROJECT_ID=${projectId}\nLEAP360_SERVICE_NAME=${serviceName}`;

      const envVarRef = browserPrefix
        ? `import.meta.env.${browserPrefix}LEAP360_API_KEY`
        : 'process.env.LEAP360_API_KEY';
      const envVarProjectRef = browserPrefix
        ? `import.meta.env.${browserPrefix}LEAP360_PROJECT_ID`
        : 'process.env.LEAP360_PROJECT_ID';
      const envVarServiceRef = browserPrefix
        ? `import.meta.env.${browserPrefix}LEAP360_SERVICE_NAME`
        : 'process.env.LEAP360_SERVICE_NAME';

      const readme = `# Leap360 AI Governance — Integration Guide

Your project is connected to Leap360. Every AI call is now traced, governed,
and monitored in real time — **across all LLM providers and models**.

**Dashboard:** https://leap360.ai/dashboard/
**API Key:**   ${apiKey.substring(0, 20)}...
**Project:**   ${projectId}
**Service:**   ${serviceName}
**Bundler:**   ${bundlerName}

---

## 🚀 Quick Start: Add Leap360 to Your App in 30 Seconds

### Copy this prompt and send it to your AI assistant (GitHub Copilot, Claude, ChatGPT, etc.)

\`\`\`
I need to integrate Leap360 AI Governance into my application.
Leap360 traces, governs, and monitors all AI calls in real time
across any LLM provider (OpenAI, Anthropic, Google Gemini, Mistral, etc.).

Steps:
1. The SDK is already installed: npm install leap360
2. The env vars are already in .env.
3. Wrap every LLM call with Leap360Client.traceCall() — this works with ANY provider.

Example pattern:
   import { Leap360Client } from 'leap360';
   const leap = new Leap360Client({
     apiKey: ${envVarRef},
     projectId: ${envVarProjectRef},
   });

   // Wrap your existing LLM call:
   const result = await leap.traceCall({
     agentName: '${serviceName}',
     provider: 'google',      // or 'openai', 'anthropic', 'mistral', etc.
     model: 'gemini-2.0-flash',
     fn: () => yourExistingLLMCall(),
   });

Please find all LLM API calls in the codebase and wrap them with leap.traceCall().
\`\`\`

---

## 🔐 Environment Variables

\`\`\`env
${envVarNote}
\`\`\`

### Bundler prefix reference

| Bundler | Correct prefix | Example |
|---------|---------------|---------|
| **Vite** | \`VITE_\` | \`VITE_LEAP360_API_KEY\` |
| **Next.js** | \`NEXT_PUBLIC_\` | \`NEXT_PUBLIC_LEAP360_API_KEY\` |
| **Create React App** | \`REACT_APP_\` | \`REACT_APP_LEAP360_API_KEY\` |
| **Node / backend** | *(none)* | \`LEAP360_API_KEY\` |

---

## 📚 Integration Examples

### ✅ Method 1: traceCall() — Works with ANY LLM (Recommended)

This is the **universal method** that works with every LLM SDK without exceptions.

\`\`\`typescript
import { Leap360Client } from 'leap360';

const leap = new Leap360Client({
  apiKey: ${envVarRef},
  projectId: '${projectId}',
});

// \u2500\u2500 Google Gemini (@google/genai \u2014 new SDK) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
import { GoogleGenAI } from '@google/genai';
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const geminiResult = await leap.traceCall({
  agentName: '${serviceName}',
  provider: 'google',
  model: 'gemini-2.0-flash',
  fn: () => ai.models.generateContent({
    model: 'gemini-2.0-flash',
    contents: 'Hello!',
  }),
});

// \u2500\u2500 Google Gemini (@google/generative-ai \u2014 older SDK) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
import { GoogleGenerativeAI } from '@google/generative-ai';
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

const geminiResult2 = await leap.traceCall({
  agentName: '${serviceName}',
  provider: 'google',
  model: 'gemini-2.0-flash',
  fn: () => model.generateContent('Hello!'),
});

// \u2500\u2500 OpenAI \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
import OpenAI from 'openai';
const openai = new OpenAI();

const openaiResult = await leap.traceCall({
  agentName: '${serviceName}',
  provider: 'openai',
  model: 'gpt-4o',
  fn: () => openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Hello!' }],
  }),
});

// \u2500\u2500 Anthropic Claude \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
import Anthropic from '@anthropic-ai/sdk';
const anthropic = new Anthropic();

const claudeResult = await leap.traceCall({
  agentName: '${serviceName}',
  provider: 'anthropic',
  model: 'claude-3-5-sonnet-20241022',
  fn: () => anthropic.messages.create({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Hello!' }],
  }),
});
\`\`\`

---

### ⚡ Method 2: autoInit() — Zero-code for OpenAI & @google/generative-ai only

\`\`\`typescript
import { Leap360 } from 'leap360';

// Initialize ONCE at app entry point (main.tsx / index.ts)
Leap360.autoInit({
  apiKey: ${envVarRef},
  projectId: '${projectId}',
  serviceName: '${serviceName}',
});
// ✅ Console: [Leap360] Tracing active \u2014 project: ${projectId}, service: ${serviceName}

// Now use your LLM client normally \u2014 calls are auto-traced:
import OpenAI from 'openai';
const openai = new OpenAI();
const res = await openai.chat.completions.create({ model: 'gpt-4o', messages: [...] });
\`\`\`

> **Compatibility:**
> | SDK | autoInit() | One-line wrap | traceCall() |
> |-----|-----------|---------------|-------------|
> | \`openai\` | ✅ Auto | \`wrapOpenAI()\` | ✅ Manual |
> | \`@google/generative-ai\` | ✅ Auto | \`wrapGemini()\` | ✅ Manual |
> | \`@google/genai\` (new SDK) | ❌ | \`wrapGoogleGenAI()\` | ✅ Manual |
> | \`@anthropic-ai/sdk\` | ❌ | \`wrapAnthropic()\` ✅ NEW | ✅ Manual |
> | \`@aws-sdk/client-bedrock-runtime\` | ❌ | \`wrapBedrock()\` ✅ NEW | ✅ Manual |
> | Any other LLM | ❌ | — | ✅ Manual |

---

### ⚡ Method 3: One-line wrap — for Anthropic, Bedrock, Gemini (new SDK)

\`\`\`typescript
import { Leap360 } from 'leap360';

const leap = new Leap360({
  apiKey: ${envVarRef},
  projectId: '${projectId}',
  serviceName: '${serviceName}',
});

// ── Anthropic ──────────────────────────────────────────────────────────────
import Anthropic from '@anthropic-ai/sdk';
const anthropic = leap.wrapAnthropic(new Anthropic()); // ✅ NEW in v1.5
const claudeMsg = await anthropic.messages.create({
  model: 'claude-3-5-sonnet-20241022',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello!' }],
});

// ── AWS Bedrock ────────────────────────────────────────────────────────────
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
const bedrock = leap.wrapBedrock(new BedrockRuntimeClient({ region: 'us-east-1' })); // ✅ NEW in v1.5
const bedrockRes = await bedrock.send(new ConverseCommand({
  modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  messages: [{ role: 'user', content: [{ text: 'Hello!' }] }],
}));

// ── Google Gemini (new @google/genai SDK) ──────────────────────────────────
import { GoogleGenAI } from '@google/genai';
const ai = leap.wrapGoogleGenAI(new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }));
const geminiRes = await ai.models.generateContent({
  model: 'gemini-2.0-flash',
  contents: 'Hello!',
});
\`\`\`

---

## 🛑 Kill Switch (Emergency Stop)

**Via dashboard:** Settings → Danger Zone → Suspend All Agents

**Suspend via API:**
\`\`\`bash
curl -X POST https://b0vyk178b7.execute-api.us-east-1.amazonaws.com/v1/projects/${projectId}/status \\
  -H "x-api-key: ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"status":"SUSPENDED"}'
\`\`\`

**Resume:**
\`\`\`bash
curl -X POST https://b0vyk178b7.execute-api.us-east-1.amazonaws.com/v1/projects/${projectId}/status \\
  -H "x-api-key: ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"status":"ACTIVE"}'
\`\`\`

---

## 🎯 Policy Enforcement

Create a policy on the dashboard (Policies & Rules page), then every agent
response is evaluated by the LLM Judge. Actions:

| Action | Behavior |
|--------|----------|
| **warn** | Logs the violation, allows response through |
| **ask_admin** | Flags for human review in Approval Queue |
| **block** | Hard-rejects response \u2014 SDK throws \`POLICY_VIOLATION_BLOCKED\` |

---

Generated by \`npx leap360 setup\` on ${new Date().toISOString().split('T')[0]}
`;

      // sample-node.ts
      const sampleNode = `/**
 * Leap360 sample — Node.js / TypeScript  (generated by npx leap360 setup)
 *
 * Choose the method that matches your LLM SDK:
 *
 *   wrapOpenAI(client)      — openai
 *   wrapAnthropic(client)   — @anthropic-ai/sdk
 *   wrapBedrock(client)     — @aws-sdk/client-bedrock-runtime
 *   wrapGemini(client)      — @google/generative-ai
 *   wrapGoogleGenAI(client) — @google/genai (new SDK)
 *   traceCall({ fn, provider, model }) — any other LLM
 */
import { Leap360 } from 'leap360';

const leap = new Leap360({
  apiKey: process.env.LEAP360_API_KEY!,
  projectId: '${projectId}',
  serviceName: '${serviceName}',
});

// ── Option A: OpenAI ───────────────────────────────────────────────────────
// import OpenAI from 'openai';
// const openai = leap.wrapOpenAI(new OpenAI());
// const res = await openai.chat.completions.create({
//   model: 'gpt-4o',
//   messages: [{ role: 'user', content: 'Hello!' }],
// });
// console.log(res.choices[0].message.content);

// ── Option B: Anthropic ────────────────────────────────────────────────────
// import Anthropic from '@anthropic-ai/sdk';
// const anthropic = leap.wrapAnthropic(new Anthropic());
// const msg = await anthropic.messages.create({
//   model: 'claude-3-5-sonnet-20241022',
//   max_tokens: 1024,
//   messages: [{ role: 'user', content: 'Hello!' }],
// });
// console.log(msg.content[0].text);

// ── Option C: AWS Bedrock ──────────────────────────────────────────────────
// import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
// const bedrock = leap.wrapBedrock(new BedrockRuntimeClient({ region: 'us-east-1' }));
// const bedrockRes = await bedrock.send(new ConverseCommand({
//   modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
//   messages: [{ role: 'user', content: [{ text: 'Hello!' }] }],
// }));
// console.log(bedrockRes.output.message.content[0].text);

// ── Option D: Google Gemini (new @google/genai SDK) ───────────────────────
import { GoogleGenAI } from '@google/genai';
const ai = leap.wrapGoogleGenAI(new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! }));
const geminiRes = await ai.models.generateContent({
  model: 'gemini-2.0-flash',
  contents: 'What is the capital of France?',
});
console.log(geminiRes.text);

// ── Option E: Any other LLM — manual traceCall ────────────────────────────
// import { Leap360Client } from 'leap360';
// const leapClient = new Leap360Client({ apiKey: process.env.LEAP360_API_KEY! });
// const result = await leapClient.traceCall({
//   provider: 'mistral',
//   model: 'mistral-large-latest',
//   fn: () => mistral.chat({ model: 'mistral-large-latest', messages: [...] }),
// });

// Check your dashboard: https://leap360.ai/dashboard/
`;

      // sample-python.py
      const samplePython = `# Leap360 sample — Python  (generated by npx leap360 setup)
#
# Install:  pip install leap360
# Optional: pip install leap360[anthropic]  pip install leap360[bedrock]  pip install leap360[all]
#
# wrap() auto-detects the provider from the client type:
#   openai.OpenAI()              → provider='openai'
#   anthropic.Anthropic()        → provider='anthropic'
#   google.generativeai model    → provider='google'
#   boto3 bedrock-runtime client → provider='bedrock'
from leap360 import Leap360Tracer
import os

tracer = Leap360Tracer(
    api_key=os.environ["LEAP360_API_KEY"],
    project_id="${projectId}",
    service_name="${serviceName}",
)

# ── Option A: OpenAI ─────────────────────────────────────────────────────
# from openai import OpenAI
# client = tracer.wrap(OpenAI())
# response = client.chat.completions.create(
#     model="gpt-4o",
#     messages=[{"role": "user", "content": "Hello!"}],
# )
# print(response.choices[0].message.content)

# ── Option B: Anthropic ───────────────────────────────────────────────────
# import anthropic
# client = tracer.wrap(anthropic.Anthropic())
# message = client.messages.create(
#     model="claude-3-5-sonnet-20241022",
#     max_tokens=1024,
#     messages=[{"role": "user", "content": "Hello!"}],
# )
# print(message.content[0].text)

# ── Option C: AWS Bedrock ─────────────────────────────────────────────────
# import boto3
# bedrock = tracer.wrap(boto3.client("bedrock-runtime", region_name="us-east-1"))
# response = bedrock.converse(
#     modelId="anthropic.claude-3-5-sonnet-20241022-v2:0",
#     messages=[{"role": "user", "content": [{"text": "Hello!"}]}],
# )
# print(response["output"]["message"]["content"][0]["text"])

# ── Option D: Any provider — manual trace_call() ──────────────────────────
# result = tracer.trace_call(
#     fn=lambda: my_llm_call(),
#     provider="mistral",
#     model="mistral-large-latest",
# )

# Check your dashboard: https://leap360.ai/dashboard/
`;


      try {
        fs.writeFileSync(path.join(guideDir, 'README.md'), readme.trim() + '\n');
        fs.writeFileSync(path.join(guideDir, 'sample-node.ts'), sampleNode.trim() + '\n');
        fs.writeFileSync(path.join(guideDir, 'sample-python.py'), samplePython.trim() + '\n');
        console.log(`   → .leap360/README.md        (integration guide)`);
        console.log(`   → .leap360/sample-node.ts   (Node.js / TypeScript sample)`);
        console.log(`   → .leap360/sample-python.py (Python sample)\n`);
      } catch { /* ignore write errors */ }

      // Offer the push check in a git repository (issue #10)
      let inRepo = false;
      try { execFileSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' }); inRepo = true; } catch { /* not a repository */ }
      if (inRepo) {
        const answer = (await askQuestion('   Check every git push from this repository with Leap360? Sends file paths, never contents. (y/N) ')).toLowerCase();
        if (answer === 'y' || answer === 'yes') {
          try { const h = installPushHook(process.cwd()); console.log(`   → ${h.hookPath} (pre-push check)\n`); } catch (e: any) { console.log(`   The push check was not installed: ${e?.message ?? e}\n`); }
        } else console.log('   Skipped. Add it later with: npx leap360 hook install\n');
      }

      console.log('   \x1b[36mSetup complete! Open your dashboard:\x1b[0m');
      console.log('   \x1b[1m\x1b[34m  https://leap360.ai/dashboard/\x1b[0m\n');
    } catch (err: any) {
      console.error('\n❌  Setup failed:', err.message);
      process.exit(1);
    } finally {
      rl.close();
    }
  });

// ─── Command: status ───────────────────────────────────────────────────────
program
  .command('status')
  .description('Show your current Leap360 configuration')
  .action(() => {
    const creds = loadCredentials();
    if (!creds) {
      console.log('\n⚠️  Not configured.  Run: \x1b[36mnpx leap360 setup\x1b[0m\n');
      return;
    }
    console.log('\n✅  Leap360 Configuration\n');
    console.log(`   API Key:    ${creds.apiKey.substring(0, 20)}...`);
    console.log(`   Project ID: ${creds.projectId || 'default'}`);
    console.log(`   Service:    ${creds.serviceName || 'my-service'}`);
    console.log(`   User ID:    ${creds.userId}`);
    console.log(`   Saved:      ${creds.savedAt}\n`);
  });

// ─── Command: reset ────────────────────────────────────────────────────────
program
  .command('reset')
  .description('Remove saved configuration')
  .action(() => {
    const creds = loadCredentials();
    if (!creds) {
      console.log('\n⚠️  No configuration to reset.\n');
      return;
    }
    clearCredentials();
    console.log('\n✅  Configuration removed.\n');
  });

// ─── Commands: login, logout, whoami ───────────────────────────────────────
const DASHBOARD_URL = (process.env['LEAP360_DASHBOARD_URL'] || 'https://leap360.ai').replace(/\/$/, '');

program
  .command('login')
  .description('Sign in through the browser and save an API key to ~/.leap360/config.json')
  .action(async () => {
    try {
      const start = await startDeviceAuth();
      console.log('\n🔐  Sign in to Leap360\n');
      console.log(`   Open:  \x1b[1m\x1b[34m${start.verificationUrl}\x1b[0m`);
      console.log(`   Code:  \x1b[1m${start.userCode}\x1b[0m   (type it on that page to approve)\n`);
      console.log('   Never type a code someone else sent you: approving gives this terminal your API key.\n');
      console.log('   Waiting for you to approve this device…');
      const r = await pollForApproval(start.deviceCode);
      if (r.status !== 'approved' || !r.apiKey) {
        console.error('\n❌  The sign-in expired before it was approved. Run npx leap360 login again.\n');
        process.exit(1);
      }
      await saveCredentials({ apiKey: r.apiKey, userId: r.userId || '' });
      console.log(`\n✅  Signed in${r.email ? ` as ${r.email}` : ''}. The API key is saved; the SDK and CLI use it from now on.\n`);
    } catch (err: any) {
      console.error(`\n❌  ${err?.message ?? err}\n`);
      process.exit(1);
    }
  });

program
  .command('logout')
  .description('Remove the saved API key')
  .action(async () => {
    await clearCredentials();
    console.log('\n✅  Signed out. The saved API key was removed from this machine.\n');
  });

program
  .command('whoami')
  .description('Show who the saved API key belongs to')
  .action(() => {
    const creds = loadCredentials();
    if (!creds) { console.log('\n⚠️  Not signed in. Run: \x1b[36mnpx leap360 login\x1b[0m\n'); return; }
    console.log(`\n   User:    ${creds.userId || 'unknown'}\n   API key: ${creds.apiKey.slice(0, 12)}…\n`);
  });

// ─── Commands: stats and agents (the kill switch) ──────────────────────────
function cliClient(): Leap360Client {
  const apiKey = process.env['LEAP360_API_KEY'] || loadCredentials()?.apiKey;
  if (!apiKey) { console.error('\n⚠️  Not signed in. Run: \x1b[36mnpx leap360 login\x1b[0m\n'); process.exit(1); }
  return new Leap360Client({ apiKey, apiUrl: process.env['LEAP360_API_URL'] || CLOUD_API_URL });
}
const failed = (r: any): boolean => {
  if (!r?.httpStatus) return false;
  console.error(`\n❌  ${r.error || `HTTP ${r.httpStatus}`}\n`);
  process.exitCode = 1;
  return true;
};

program
  .command('stats')
  .description("Show the project's traces, tokens, agents and mode")
  .action(async () => {
    const c = cliClient();
    const [s, m]: any[] = await Promise.all([c.getStats(), c.getMode()]);
    if (failed(s)) return;
    const rows: [string, unknown][] = [['Traces', s.totalTraces], ['Tokens', s.totalTokens], ['Average latency', s.avgLatencyMs != null ? `${Math.round(s.avgLatencyMs)} ms` : undefined], ['Agents', s.totalAgents], ['Errors', s.errors], ['Policy violations', s.policyViolations], ['Mode', m?.mode ? `${m.mode}${m.mode === 'shadow' && m.day ? ` (day ${m.day} of ${m.days})` : ''}` : undefined]];
    console.log('');
    for (const [k, v] of rows) if (v !== undefined && v !== null) console.log(`   ${k.padEnd(18)} ${v}`);
    console.log('');
  });

const agents = program.command('agents').description('List agents, or stop and restart them');
agents
  .command('list', { isDefault: true })
  .description('List agents and whether each one is running')
  .action(async () => {
    const r: any = await cliClient().getAgents();
    if (failed(r)) return;
    const list: any[] = Array.isArray(r) ? r : r.agents || [];
    if (!list.length) { console.log('\n   No agents yet. They appear after their first trace or tool call.\n'); return; }
    console.log('');
    for (const a of list) console.log(`   ${a.killStatus === 'SUSPENDED' ? '⏸ ' : '▶ '} ${String(a.name ?? a.agentId).padEnd(28)} ${String(a.calls ?? 0).padStart(7)} calls   ${a.killStatus === 'SUSPENDED' ? 'stopped' : 'running'}`);
    console.log('');
  });
agents
  .command('stop <name>')
  .alias('suspend')
  .description('Stop an agent and the API keys it uses (agents get "Stopped by your team in Leap360")')
  .action(async (name: string) => {
    const r: any = await cliClient().suspendAgent(name);
    if (failed(r)) return;
    console.log(`\n⏸  ${name} is stopped.${r.keysStopped ? ` Its API key${r.keysStopped > 1 ? 's are' : ' is'} stopped too, so it cannot carry on under another name.` : ''}`);
    if (r.alsoStops?.length) console.log(`   Agents sharing that key stop as well: ${r.alsoStops.join(', ')}`);
    console.log('');
  });
agents
  .command('resume <name>')
  .description('Restart a stopped agent (needs you signed in to the console)')
  .action(async (name: string) => {
    const r: any = await cliClient().resumeAgent(name);
    if (r?.code === 'PERSON_REQUIRED') {
      console.log(`\n🔒  Restarting an agent needs a person signed in to the console, so an agent's API key can never undo its own stop.\n   Restart it here: \x1b[34m${DASHBOARD_URL}/dashboard/agents?agent=${encodeURIComponent(name)}\x1b[0m\n`);
      process.exitCode = 1;
      return;
    }
    if (failed(r)) return;
    console.log(`\n▶  ${name} is running again.\n`);
  });

// ─── Commands: hook and push-check (issue #10) ─────────────────────────────
const hook = program.command('hook').description('Check every git push with Leap360 before it leaves this machine');
hook
  .command('install')
  .description('Add a git pre-push hook to this repository')
  .action(() => {
    try {
      const r = installPushHook(process.cwd());
      console.log(r.changed
        ? `\nPushes from this repository are now checked by Leap360 (${r.hookPath}).\nEach push sends the repository, branch, commit count, changed file paths and who is pushing. Never file contents.\nSee exactly what is sent: git push --dry-run, or npx leap360 push-check --dry-run.\n`
        : `\nThe hook is already installed (${r.hookPath}).\n`);
    } catch (err: any) {
      console.error(`\nThe hook was not installed: ${/not a git repository/i.test(String(err?.message)) ? 'this folder is not a git repository' : err?.message ?? err}.\n`);
      process.exitCode = 1;
    }
  });
hook
  .command('uninstall')
  .description('Remove the Leap360 lines from the pre-push hook')
  .action(() => {
    try {
      const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], { encoding: 'utf8' }).trim();
      const file = nodePath.resolve(gitDir, 'hooks', 'pre-push');
      const lines = readFileSync(file, 'utf8').split('\n');
      const start = lines.findIndex((l) => l.startsWith('# leap360 push-check'));
      if (start < 0) { console.log('\nThe Leap360 hook is not installed here.\n'); return; }
      lines.splice(start, 5);
      writeFileSyncNode(file, lines.join('\n'));
      console.log('\nPushes from this repository are no longer checked by Leap360.\n');
    } catch { console.log('\nThe Leap360 hook is not installed here.\n'); }
  });

program
  .command('push-check')
  .description('Used by the pre-push hook: checks what a push changes. --dry-run prints what would be sent')
  .argument('[remote]', 'remote name (git passes it)')
  .argument('[url]', 'remote URL (git passes it)')
  .option('--dry-run', 'print what would be sent to Leap360, and send nothing')
  .action(async (_remote: string | undefined, url: string | undefined, o: { dryRun?: boolean }) => {
    const apiKey = process.env['LEAP360_API_KEY'] || loadCredentials()?.apiKey;
    let remoteUrl = url || '';
    if (!remoteUrl) { try { remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim(); } catch { remoteUrl = ''; } }
    let stdin = '';
    if (!process.stdin.isTTY) { for await (const chunk of process.stdin) stdin += chunk; }
    if (!stdin.trim() && o.dryRun) {
      // Outside a push: show what pushing the current branch would send
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
      let remoteSha = '0'.repeat(40);
      try { remoteSha = execFileSync('git', ['rev-parse', `origin/${branch}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* new branch */ }
      stdin = `refs/heads/${branch} ${sha} refs/heads/${branch} ${remoteSha}\n`;
    }
    if (!apiKey && !o.dryRun) { console.error('[Leap360] No API key, so this push was not checked. Run npx leap360 login.'); return; }
    process.exitCode = await pushCheck({ cwd: process.cwd(), remoteUrl, stdin, apiKey: apiKey || '', baseUrl: process.env['LEAP360_API_URL'] || CLOUD_API_URL, dryRun: o.dryRun });
  });

// ─── Command: verify (Authority Receipts) ──────────────────────────────────
program
  .command('verify')
  .description('Check signed Authority Receipts: every signature, and every agent\'s chain')
  .argument('<file>', 'a JSON file of receipts, as downloaded from Evidence in the console')
  .option('--key <file>', 'the public key (PEM). Default: fetched from the Leap360 API')
  .action(async (file: string, o: { key?: string }) => {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      const receipts = (Array.isArray(raw) ? raw : raw.receipts ?? []) as SignedReceipt[];
      let pem: string;
      if (o.key) pem = readFileSync(o.key, 'utf8');
      else {
        const res = await fetch(`${(process.env['LEAP360_API_URL'] || CLOUD_API_URL).replace(/\/$/, '')}/v1/receipts/public-key`);
        if (!res.ok) throw new Error(`Could not fetch the public key (HTTP ${res.status}). Pass it with --key.`);
        pem = ((await res.json()) as { publicKeyPem: string }).publicKeyPem;
      }
      const r = verifyReceipts(receipts, pem);
      if (r.ok) console.log(`\nVerified ${r.checked} receipts from ${r.agents} agent${r.agents === 1 ? '' : 's'}: every signature is valid and every chain is unbroken.\n`);
      else {
        console.log(`\n${r.problems.length} problem${r.problems.length === 1 ? '' : 's'} in ${r.checked} receipts:\n`);
        for (const p of r.problems.slice(0, 50)) console.log(`   ${p.agent ?? '(no agent)'} #${p.seq ?? '?'} ${p.id}: ${p.problem}`);
        console.log('');
        process.exitCode = 1;
      }
    } catch (err: any) {
      console.error(`\n${err?.message ?? err}\n`);
      process.exitCode = 2;
    }
  });

// ─── Command: mcp-proxy ────────────────────────────────────────────────────
// stdout belongs to the MCP protocol here: everything this command prints goes to stderr.
program
  .command('mcp-proxy')
  .description('Run an MCP server behind Leap360: every tool call is checked and recorded')
  .argument('<command>', 'the MCP server command, e.g. npx')
  .argument('[args...]', 'its arguments (put -- before them)')
  .option('--agent <name>', 'agent name shown in Leap360', 'mcp-agent')
  .option('--mode <mode>', "'shadow' (Watch: record what would be held or blocked) or 'enforce' (Blocking); default: the console's setting")
  .option('--fail-closed-at <risk>', 'when Blocking, block actions at or above this risk while Leap360 is unreachable', 'critical')
  .option('--api-key <key>', 'Leap360 API key (default: LEAP360_API_KEY, then the saved config)')
  .option('--no-guard-output', 'when Blocking, pass tool output through unchanged (default: redact credentials, mark prompt injection)')
  .option('--approval-wait <seconds>', 'wait this long for a person to approve a held tool call (default 0: answer at once)', '0')
  .option('--capture <level>', "what leaves this machine: 'metadata' (default: tool names, argument keys and risk, no values), 'redacted' or 'full'")
  .passThroughOptions()
  .addHelpText('after', `
Example (Claude Code, Cursor or Claude Desktop MCP config):
  { "command": "npx", "args": ["-y", "leap360", "mcp-proxy", "--agent", "claude-code", "--",
                               "npx", "-y", "@modelcontextprotocol/server-github"] }

Remote MCP servers: wrap them with mcp-remote, e.g.
  leap360 mcp-proxy --agent cursor -- npx -y mcp-remote https://example.com/mcp`)
  .action(async (command: string, args: string[], o: { agent: string; mode?: string; failClosedAt: string; apiKey?: string; guardOutput: boolean; approvalWait: string; capture?: string }) => {
    const apiKey = o.apiKey || process.env['LEAP360_API_KEY'] || loadCredentials()?.apiKey;
    if (!apiKey) {
      process.stderr.write('[Leap360] no API key: pass --api-key, set LEAP360_API_KEY, or run `npx leap360 setup`\n');
      process.exit(2);
    }
    if (o.mode && o.mode !== 'shadow' && o.mode !== 'enforce') {
      process.stderr.write("[Leap360] --mode must be 'shadow' (Watch) or 'enforce' (Blocking)\n");
      process.exit(2);
    }
    if (o.capture && !['metadata', 'redacted', 'full'].includes(o.capture)) {
      process.stderr.write("[Leap360] --capture must be 'metadata', 'redacted' or 'full'\n");
      process.exit(2);
    }
    const risks = ['low', 'medium', 'high', 'critical'];
    if (!risks.includes(o.failClosedAt)) {
      process.stderr.write(`[Leap360] --fail-closed-at must be one of ${risks.join(', ')}\n`);
      process.exit(2);
    }
    const code = await runMcpProxy({
      command, args: args ?? [], agentName: o.agent, apiKey,
      mode: o.mode as 'shadow' | 'enforce' | undefined,
      failClosedAt: o.failClosedAt as 'low' | 'medium' | 'high' | 'critical',
      guardOutput: o.guardOutput,
      approvalWaitMs: Math.max(0, Math.min(600, Number(o.approvalWait) || 0)) * 1000,
      capture: o.capture as 'metadata' | 'redacted' | 'full' | undefined,
    });
    process.exit(code);
  });

// ─── Command: scan ─────────────────────────────────────────────────────────
program
  .command('scan')
  .description('Find every tool your agents can call and the dangerous operations each one reaches')
  .argument('[dir]', 'project directory', '.')
  .option('--json', 'print the report as JSON')
  .option('--fail-on <risk>', 'exit 1 if a tool Leap360 does not govern reaches this risk (low|medium|high|critical)')
  .option('--fail-on-new <risk>', 'exit 1 only if this change ADDS such a tool or ability, compared with the baseline')
  .option('--baseline <file>', `baseline to compare with (default: ${DEFAULT_BASELINE})`)
  .option('--update-baseline', 'save this scan as the new baseline')
  .option('--install-hook', 'add `leap360 scan --fail-on-new critical` to the prebuild script and save a baseline')
  .option('--ignore <dirs>', 'comma-separated directory names to skip')
  .option('--no-color', 'plain output')
  .option('--report', 'upload the result to Leap360 so it shows in the console (Code scan)')
  .option('--api-key <key>', 'Leap360 API key for --report (default: LEAP360_API_KEY, then the saved config)')
  .addHelpText('after', `
Examples:
  npx leap360 scan                          report what your agents can reach
  npx leap360 scan --fail-on critical       fail CI when an ungoverned tool can do something critical
  npx leap360 scan --install-hook           check every build for newly added dangerous abilities
  npx leap360 scan --report                 show the result in the Leap360 console (Code scan)`)
  .action(async (dir: string, o: { json?: boolean; failOn?: string; failOnNew?: string; baseline?: string; updateBaseline?: boolean; installHook?: boolean; ignore?: string; color: boolean; report?: boolean; apiKey?: string }) => {
    const risks: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
    for (const [flag, v] of [['--fail-on', o.failOn], ['--fail-on-new', o.failOnNew]] as const) {
      if (v && !risks.includes(v as RiskLevel)) { process.stderr.write(`${flag} must be one of ${risks.join(', ')}\n`); process.exit(2); }
    }
    const root = nodePath.resolve(dir);
    const report = scanProject(root, { ignore: o.ignore ? o.ignore.split(',').map((x) => x.trim()).filter(Boolean) : [] });
    const baselineFile = nodePath.resolve(root, o.baseline ?? DEFAULT_BASELINE);
    const base = readBaseline(baselineFile);
    if (base) report.baseline = diffBaseline(report, base);

    if (o.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else process.stdout.write(`${formatReport(report, o.color && process.stdout.isTTY !== false)}\n`);

    if (o.report) {
      const apiKey = o.apiKey || process.env['LEAP360_API_KEY'] || loadCredentials()?.apiKey;
      if (!apiKey) {
        process.stderr.write('\n  --report needs an API key: pass --api-key, set LEAP360_API_KEY, or run `npx leap360 setup`\n');
      } else {
        const sent = await uploadScan(report, root, apiKey);
        process.stderr.write(sent.ok ? `\n  report sent to Leap360 (Code scan in the console)\n` : `\n  could not send the report: ${sent.error}\n`);
      }
    }

    if (o.installHook) {
      const hook = 'leap360 scan --fail-on-new critical';
      const changed = installPrebuildHook(root, hook);
      writeBaseline(baselineFile, report);
      process.stderr.write(changed ? `\n  prebuild is now: ${changed.after}\n  baseline saved to ${nodePath.relative(root, baselineFile)} (commit it)\n` : `\n  prebuild already runs leap360 scan; baseline refreshed\n`);
      return;
    }
    if (o.updateBaseline) {
      writeBaseline(baselineFile, report);
      process.stderr.write(`\n  baseline saved to ${nodePath.relative(root, baselineFile)} (commit it)\n`);
    }

    let fail = false;
    if (o.failOn) {
      const bad = report.tools.filter((t) => !t.governed && riskRank(t.risk) >= riskRank(o.failOn as RiskLevel));
      if (bad.length) { fail = true; process.stderr.write(`\n  ✖ ${bad.length} ungoverned tool${bad.length === 1 ? '' : 's'} at ${o.failOn} risk or above: ${bad.map((t) => t.name).join(', ')}\n`); }
    }
    if (o.failOnNew) {
      if (!report.baseline) process.stderr.write(`\n  no baseline at ${nodePath.relative(root, baselineFile)}: run \`leap360 scan --update-baseline\` once and commit it\n`);
      else if (newRiskAtOrAbove(report, report.baseline, o.failOnNew as RiskLevel)) {
        fail = true;
        process.stderr.write(`\n  ✖ this change gives an agent a new ${o.failOnNew}-risk ability that Leap360 does not govern.\n    Govern it with leap.wrapTool, or accept it with \`leap360 scan --update-baseline\`.\n`);
      }
    }
    if (fail) process.exit(1);
  });

/** Git branch and commit for a scan report, when the project is a git checkout */
function gitInfo(root: string): { branch: string | null; commit: string | null; dirty: boolean } {
  const run = (args: string[]) => {
    try { return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim(); } catch { return null; }
  };
  return { branch: run(['rev-parse', '--abbrev-ref', 'HEAD']), commit: run(['rev-parse', '--short=12', 'HEAD']), dirty: !!run(['status', '--porcelain']) };
}

async function uploadScan(report: ReturnType<typeof scanProject>, root: string, apiKey: string): Promise<{ ok: boolean; error?: string }> {
  let project: string | null = null;
  try { project = JSON.parse(readFileSync(nodePath.join(root, 'package.json'), 'utf8')).name ?? null; } catch { project = nodePath.basename(root); }
  try {
    const res = await fetch(`${CLOUD_API_URL.replace(/\/$/, '')}/v1/scans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ ...report, root: undefined, project, git: gitInfo(root) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return { ok: true };
    const j = await res.json().catch(() => ({})) as { error?: string };
    return { ok: false, error: `HTTP ${res.status}${j.error ? `: ${j.error}` : ''}` };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

program.parse(process.argv);
