# Changelog

All notable changes to the `leap360` Python package.

## 1.3.0 (9 Oct 2026)

- **`Leap360` API client.** `trace()`, plus every read and write the console uses: stats, traces, agents, violations, policies, approvals, the audit log, the kill switch, shadow mode (`get_mode`, `set_mode`, `get_shadow_report`), recorded actions and code scans. Errors are returned as dicts, never raised. (The README documented this class before it existed.)
- **`Leap360Governor`** gates tool calls (sync and `async`) in enforce mode and records them in shadow mode; the kill switch applies in both.
- The API URL variable is `LEAP360_API_URL` (the README said `LEAP360_BASE_URL`, which was never read).
- License classifier corrected to Apache 2.0.
- Resuming agents, shadow mode, approvals and policy changes need a signed-in person; with an API key they return `PERSON_REQUIRED` (stopping agents still works).
- `wrap_tool` declares each tool to the capability map when it is wrapped; `Leap360Governor.declare_tools()` declares tools a framework registers.

## 1.1.0 (May 2026)

- `Leap360Tracer.wrap()` auto-detects OpenAI, Anthropic, Gemini and Bedrock clients; `trace_call()` traces any provider.
