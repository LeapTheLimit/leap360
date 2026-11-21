# Changelog

All notable changes to the `leap360` Python package.

## 1.5.0 (21 Nov 2026)

- **Local mode: run Leap360 on your own device with no cloud, account or API key.** Set `LEAP360_LOCAL=1`, or pass `local=True` to `Leap360Governor`, `Leap360Tracer` or `Leap360`. Tool calls are classified on the device (a port of the TypeScript classifier) and decided from `~/.leap360/local/rules.json`, created with the safe default rules. Stop all, approvals and the activity log are files in the same folder, shared with the TypeScript SDK and CLI. Nothing is sent over the network.
- `python -m leap360.local` manages it: `status`, `stop [agent]`, `resume [agent]`, `approvals`, `approve <id>`, `reject <id>`, `mode watch|enforce`, `rules`, `log`.

## 1.4.0 (11 Nov 2026)

- Privacy by default (issue #50): `capture` (`metadata`, `redacted`, `full`) on the tracer and governor, `end_user_id`, and the project's setting from the console.

## 1.3.0 (9 Oct 2026)

- **`Leap360` API client.** `trace()`, plus every read and write the console uses: stats, traces, agents, violations, policies, approvals, the audit log, the kill switch, shadow mode (`get_mode`, `set_mode`, `get_shadow_report`), recorded actions and code scans. Errors are returned as dicts, never raised. (The README documented this class before it existed.)
- **`Leap360Governor`** gates tool calls (sync and `async`) in enforce mode and records them in shadow mode; the kill switch applies in both.
- The API URL variable is `LEAP360_API_URL` (the README said `LEAP360_BASE_URL`, which was never read).
- License classifier corrected to Apache 2.0.
- Resuming agents, shadow mode, approvals and policy changes need a signed-in person; with an API key they return `PERSON_REQUIRED` (stopping agents still works).
- `wrap_tool` declares each tool to the capability map when it is wrapped; `Leap360Governor.declare_tools()` declares tools a framework registers.

## 1.1.0 (May 2026)

- `Leap360Tracer.wrap()` auto-detects OpenAI, Anthropic, Gemini and Bedrock clients; `trace_call()` traces any provider.
