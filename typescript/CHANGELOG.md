# Changelog

All notable changes to the `leap360` npm package.

## 1.10.0 (11 Nov 2026)

- **Privacy by default** (issue #50). New option `capture` (also `LEAP360_CAPTURE`, and `--capture` on `mcp-proxy`):
  - `'metadata'` (the new default): model name, token counts, timings, the tools offered, and for each tool call its name, argument keys and types and the risk classified in your process. No prompts, replies, argument values, results or error messages leave your process. Argument patterns in tool rules are tested locally, and an approval matches the exact call by a salted fingerprint. Message rules ("what agents say") need text, so they do not run at this level; the API records that.
  - `'redacted'`: text and values with credentials, emails, card numbers, SSNs and phone numbers masked before sending.
  - `'full'`: everything, credentials still masked (the behaviour before 1.10).
  - **Upgrading:** if you rely on message rules, or want prompts and arguments in the console, set `capture: 'redacted'`.
- **One vocabulary with the console** (issue #51): an agent that is stopped gets "Stopped by your team in Leap360. Do not retry." (codes `GOVERNANCE_HALT` and `AGENT_HALT` are unchanged); logs say watch, held and Blocking; `leap360 agents stop` (alias `suspend`).
- `Leap360Client` manages tool rules: `listToolRules()`, `createToolRule()`, `deletePolicy()` (needs a signed-in person) and `addSafeDefaults()`, which adds the same safe defaults as onboarding. `SAFE_DEFAULT_RULES` is exported.
- **Check every push** (`npx leap360 hook install`): a git pre-push hook sends the repository, branch, commit count, changed file paths and who is pushing (never file contents), and the push is checked like any tool call. A blocked push stops before git sends anything. `npx leap360 push-check --dry-run` shows what would be sent.
- **Verify Authority Receipts** offline: `verifyReceipts()` from `leap360/receipts`, and `npx leap360 verify receipts.json`.
- Policy exceptions (added with "Update policies" after an approval) are honoured by local decisions.
- `replayDrafts()` in the engine: Authority Replay of draft policies over recorded tool calls.
- An unknown API key is reported once, clearly, instead of failing silently.
- Includes 1.9.1 (never published): `Leap360Client` reads and manages the project, and the CLI gained `login`, `logout`, `whoami`, `stats` and `agents`.

## 1.9.1 (not published)

- **`Leap360Client` reads and manages the project**, like the Python client: stats, traces, agents, the kill switch, policies, approvals, shadow mode (`getMode`, `setMode`, `getShadowReport`), recorded actions and code scans. Errors resolve, never reject.
- **The CLI commands the README listed now exist:** `login` (sign in through the browser), `logout`, `whoami`, `stats`, `agents`, `agents suspend` and `agents resume`. Resuming with only an API key explains that it needs a signed-in person and links to the agent in the console.

## 1.9.0 (9 Oct 2026)

- **Capability map.** The MCP proxy reports every tool a server lists, and `wrapTool` reports each tool when it is wrapped, whether or not the agent ever calls it. Tool lists in model requests are recorded by the API. The console shows what each agent can reach next to what it used, and suggests holding risky tools it never used.
- Shadow report: each suggested policy carries up to five of the calls it would have caught, per-agent tool counts include risk, and each agent lists the hosts, repositories and environments its calls targeted.
- `declareTools()` is exported for frameworks that register tools themselves.
- Disguised calls are now classified like the plain ones: argument arrays, base64-encoded commands and keys, `terraform apply -destroy`, `bash <(curl …)`, SQL comments, `TRUNCATE`, and keys split across arguments.
- The API refuses governance changes from an agent's API key (see the red-team report): approvals, shadow mode, lifting a kill switch and editing or deleting policies need a signed-in person.

## 1.8.0 (7 Oct 2026)

- **Local decisions in enforce mode.** Allowed tool calls are decided in the SDK from cached policies (p50 0.7 ms instead of a server round trip) and still recorded. Blocks and reviews still go to Leap360.
- **`leap360 scan --report`** uploads the scan to your project; the console's Code scan page shows it.
- Shadow logs read "would be blocked" / "held for review".

## 1.7.0 (7 Oct 2026)

- Fixes from the QA pass: the kill switch applies in shadow mode within a second, held calls can wait for approval (`approvalWait`), a 4xx from Leap360 blocks the call instead of letting it run unchecked, and secrets, card numbers and emails are masked before a result leaves your process.

## 1.6.0 (6 Oct 2026)

- **Shadow mode.** Every tool call is checked against your action policies and recorded with what would have happened; nothing is blocked. Turn it on per project in the console.
- **`leap.wrapTool()` and `Governor`** gate tool calls before they run (enforce mode) and record the outcome.
- **`npx leap360 mcp-proxy -- <server>`** governs any MCP server by gating `tools/call`.
- **`npx leap360 scan`** finds LLM calls and tools in your codebase at build time.

## 1.5.3 (23 Aug 2026)

- ScamBank demo app support.

## 1.5.2 (1 Jun 2026)

- `traceCall`-first docs, clearer `autoInit` warnings, environment variable guide per framework.

## 1.5.1 (26 May 2026)

- Bedrock model table and Nova examples.

## 1.5.0 (16 May 2026)

- Anthropic and AWS Bedrock support documented across the SDKs.

Earlier releases (1.1.0 to 1.4.1, April to May 2026) added tracing, the kill switch, global auto-wrap, `npx leap360 setup` and Gemini support.
