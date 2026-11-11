# leap360 (Python)

The official Python SDK for **Leap360 AI: access control for AI agents**.

Leap360 checks every tool call your agents make before it runs: safe calls go through, risky ones are held for a person, destructive ones are blocked, and Stop all halts every agent at once. Start in Watch mode to see what your rules would do before anything is blocked.

**PyPI:** https://pypi.org/project/leap360  
**Website:** https://leap360.ai  

---

## Table of Contents

- [Installation](#installation)
- [Getting an API Key](#getting-an-api-key)
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
- [Govern Tool Calls](#govern-tool-calls)
- [Policy Enforcement](#policy-enforcement)
- [Environment Variables](#environment-variables)
- [API Reference](#api-reference)
- [Troubleshooting](#troubleshooting)

---

## Installation

```bash
pip install leap360
```

Requires Python 3.8 or higher.

---

## Getting an API Key

Sign up at leap360.ai and copy the API key from your project settings. Alternatively, use the JavaScript CLI to authenticate and generate a key:

```bash
npx leap360 login
```

API keys start with `leap360_`. The API refuses a key it does not know (HTTP 401, "Unknown API key"), and the SDK prints that once, so a mistyped key never sends your traces somewhere you can't see them. New keys come from the console or from `npx leap360 login`.

---

## Privacy: what leaves your process

By default (`capture="metadata"`) Leap360 receives the model name, token counts, timings and the tools offered. No prompts, replies, results or error messages are sent. Tool-call arguments go with the check so Leap360 can classify the call, and the API keeps only their keys and types.

| `capture` | What is sent | Message rules |
|-----------|--------------|---------------|
| `"metadata"` (default) | Keys, types, verdicts, timings, token counts | Not run (they need text) |
| `"redacted"` | Text and values, with credentials, emails, cards, SSNs and phone numbers masked in your process | Run |
| `"full"` | Everything, credentials masked | Run |

```python
tracer = Leap360Tracer(service_name="support-bot", capture="redacted")
gov = Leap360Governor(agent_name="support-bot", capture="redacted")
```

Or set `LEAP360_CAPTURE=redacted` for the whole process.

---

## Quick Start

```python
from leap360 import Leap360

leap = Leap360(api_key="leap360_your_key_here")

leap.trace(
    model="amazon.nova-micro-v1:0",
    provider="bedrock",
    service_name="my-agent",
    latency_ms=312,
    usage={"prompt_tokens": 80, "completion_tokens": 50, "total_tokens": 130},
    request={"messages": [{"role": "user", "content": "Hello"}]},
    response={"text": "Hello back"},
)
```

Using environment variable:

```bash
export LEAP360_API_KEY="leap360_your_key_here"
```

```python
from leap360 import Leap360

leap = Leap360()  # reads LEAP360_API_KEY automatically
```

---

## Provider Integrations

### AWS Bedrock

```python
import boto3
import json
import time
from leap360 import Leap360

leap   = Leap360(api_key="leap360_your_key_here")
client = boto3.client("bedrock-runtime", region_name="us-east-1")

request_body = {
    "messages": [{"role": "user", "content": [{"text": "What is AI observability?"}]}],
    "inferenceConfig": {"max_new_tokens": 200},
}

start = time.time()

response = client.invoke_model(
    modelId="amazon.nova-micro-v1:0",
    contentType="application/json",
    accept="application/json",
    body=json.dumps(request_body),
)

latency_ms = int((time.time() - start) * 1000)
body       = json.loads(response["body"].read())

text          = body.get("output", {}).get("message", {}).get("content", [{}])[0].get("text", "")
input_tokens  = body.get("usage", {}).get("inputTokens", 0)
output_tokens = body.get("usage", {}).get("outputTokens", 0)

leap.trace(
    model="amazon.nova-micro-v1:0",
    provider="bedrock",
    service_name="bedrock-agent",
    latency_ms=latency_ms,
    usage={
        "prompt_tokens": input_tokens,
        "completion_tokens": output_tokens,
        "total_tokens": input_tokens + output_tokens,
    },
    request=request_body,
    response={"text": text},
)
```

### OpenAI

```python
import time
from openai import OpenAI
from leap360 import Leap360

leap   = Leap360(api_key="leap360_your_key_here")
openai = OpenAI(api_key="your-openai-key")

messages = [{"role": "user", "content": "Explain neural networks."}]

start    = time.time()
response = openai.chat.completions.create(model="gpt-4o", messages=messages)
latency  = int((time.time() - start) * 1000)

leap.trace(
    model="gpt-4o",
    provider="openai",
    service_name="openai-agent",
    latency_ms=latency,
    usage={
        "prompt_tokens": response.usage.prompt_tokens,
        "completion_tokens": response.usage.completion_tokens,
        "total_tokens": response.usage.total_tokens,
    },
    request={"messages": messages},
    response={"text": response.choices[0].message.content},
)
```

### Anthropic

```python
import time
import anthropic
from leap360 import Leap360

leap   = Leap360(api_key="leap360_your_key_here")
client = anthropic.Anthropic(api_key="your-anthropic-key")

messages = [{"role": "user", "content": "Write a haiku about observability."}]

start    = time.time()
response = client.messages.create(
    model="claude-3-5-sonnet-20241022",
    max_tokens=1024,
    messages=messages,
)
latency = int((time.time() - start) * 1000)

leap.trace(
    model="claude-3-5-sonnet-20241022",
    provider="anthropic",
    service_name="claude-agent",
    latency_ms=latency,
    usage={
        "prompt_tokens": response.usage.input_tokens,
        "completion_tokens": response.usage.output_tokens,
        "total_tokens": response.usage.input_tokens + response.usage.output_tokens,
    },
    request={"messages": messages},
    response={"text": response.content[0].text},
)
```

### Google Gemini

```python
import time
import google.generativeai as genai
from leap360 import Leap360

leap = Leap360(api_key="leap360_your_key_here")
genai.configure(api_key="your-google-key")

model  = genai.GenerativeModel("gemini-1.5-pro")
prompt = "Describe the benefits of RAG systems."

start    = time.time()
response = model.generate_content(prompt)
latency  = int((time.time() - start) * 1000)

leap.trace(
    model="gemini-1.5-pro",
    provider="gemini",
    service_name="gemini-agent",
    latency_ms=latency,
    usage={
        "prompt_tokens": response.usage_metadata.prompt_token_count,
        "completion_tokens": response.usage_metadata.candidates_token_count,
        "total_tokens": response.usage_metadata.total_token_count,
    },
    request={"contents": [{"parts": [{"text": prompt}]}]},
    response={"text": response.text},
)
```

### Any Other Provider

```python
import time
from leap360 import Leap360

leap = Leap360(api_key="leap360_your_key_here")

start = time.time()
error = None

try:
    response = your_llm_client.complete(prompt=your_prompt)
except Exception as e:
    error = str(e)
    response = None

latency = int((time.time() - start) * 1000)

leap.trace(
    model="your-model-id",
    provider="your-provider",
    service_name="your-agent",
    latency_ms=latency,
    usage={"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    request={"prompt": your_prompt},
    response={"text": response} if response else None,
    error=error,
)
```

---

## Manual Tracing

The `trace()` method accepts all trace fields directly. Only `model` is required.

```python
from leap360 import Leap360

leap = Leap360(api_key="leap360_your_key_here")

result = leap.trace(
    model="amazon.nova-lite-v1:0",
    provider="bedrock",
    service_name="summarizer",
    agent_name="document-summarizer-v2",
    run_id="batch-run-20260603",
    latency_ms=890,
    usage={
        "prompt_tokens": 1200,
        "completion_tokens": 400,
        "total_tokens": 1600,
    },
    request={"messages": [{"role": "user", "content": "Summarize this report."}]},
    response={"text": "The report covers..."},
)

print("Trace ID:", result.get("id"))
```

### Tracing errors

```python
start = time.time()
error_message = None

try:
    response = bedrock_client.invoke_model(...)
except Exception as e:
    error_message = str(e)

leap.trace(
    model="amazon.nova-micro-v1:0",
    provider="bedrock",
    service_name="my-agent",
    latency_ms=int((time.time() - start) * 1000),
    usage={"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    error=error_message,
)
```

Error traces are stored and visible in the dashboard with an error indicator. They contribute to error rate statistics.

---

## Named Agents

Set `service_name` (required for grouping) and optionally `agent_name` (a distinct label for a named agent within a service) on each trace.

```python
# All three traces will appear under different agents in the dashboard
leap.trace(model="gpt-4o", provider="openai", service_name="production-search", ...)
leap.trace(model="gpt-4o", provider="openai", service_name="staging-search", ...)
leap.trace(model="amazon.nova-micro-v1:0", provider="bedrock", service_name="rag-pipeline", ...)
```

---

## Kill Switch

The kill switch suspends an agent or an entire project. Suspended agents return HTTP 403 when a trace is submitted.

### Check, suspend and resume an agent

```python
from leap360 import Leap360

leap = Leap360()

print(leap.get_agent_status("my-agent"))   # {"status": "ACTIVE"} or {"status": "SUSPENDED"}
leap.suspend_agent("my-agent")
leap.resume_agent("my-agent")
```

Use `get_project_status()` and `set_project_status("SUSPENDED")` to stop a whole project.

### Handle suspension in your code

When an agent is suspended, the trace call returns HTTP 403:

```python
result = leap.trace(
    model="amazon.nova-micro-v1:0",
    provider="bedrock",
    service_name="suspended-agent",
    latency_ms=100,
    usage={"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
)

if result.get("code") == "AGENT_HALT":
    print("Agent is suspended. Stopping processing.")
    return

if result.get("code") == "GOVERNANCE_HALT":
    print("Project is suspended. Stopping all processing.")
    return
```

---

## Govern Tool Calls

`Leap360Governor` checks what an agent **does**, not only what it says. Wrap the functions your agent can call; each call is checked against your action policies before it runs, then recorded with its outcome.

```python
from leap360 import Leap360Governor, ActionBlocked

gov = Leap360Governor(agent_name="deploy-bot")  # reads LEAP360_API_KEY

@gov.wrap_tool("delete_namespace")
def delete_namespace(name: str):
    ...

try:
    delete_namespace(name="payments")
except ActionBlocked as e:
    print(e.gate.message)   # the function never ran
```

`wrap_tool` works on sync and `async` functions. Only a redacted preview of the result leaves your process: secrets, card numbers and emails are masked first.

The project's mode, set in the console, decides what happens:

| | `shadow` | `enforce` |
| --- | --- | --- |
| Policies evaluated | yes | yes |
| Calls blocked | never | when a policy says so |
| Waits for Leap360 | only for a kill-switch status, at most once a second | yes |
| Kill switch | applies (within 1 s) | applies |

Shadow mode is for the first week: your agents run as usual, and the console shows what each policy *would* have blocked and suggests policies to add.

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `mode` | from the console | Force `"shadow"` or `"enforce"` |
| `fail_closed_at` | `"critical"` | When Leap360 can't be reached, block calls at this risk or above |
| `approval_wait` | `0` | Seconds to wait for a person to approve a held call |
| `status_ttl` | `1.0` | Seconds a kill-switch status is reused |
| `timeout` | `2.0` | Seconds to wait for Leap360 |

**When Leap360 refuses a request** (a 4xx response), the call is blocked: a call Leap360 won't check must not run unchecked.

**For agents whose code you don't control**, the MCP proxy (`npx leap360 mcp-proxy`) governs any MCP server, whatever its language.

---

## Policy Enforcement

Policies are natural-language rules evaluated asynchronously against trace content. Your application receives HTTP 200 for every trace regardless of policy outcome. Violations are recorded in the dashboard.

### Create a policy

```python
import requests

response = requests.post(
    "https://b0vyk178b7.execute-api.us-east-1.amazonaws.com/v1/projects/{projectId}/policies",
    headers={
        "x-api-key": "leap360_your_key_here",
        "Content-Type": "application/json",
    },
    json={
        "name": "No PII",
        "description": "Prevent exposure of personal information",
        "rules": [
            "Do not reveal credit card numbers",
            "Do not reveal social security numbers",
            "Do not disclose medical records",
        ],
        "severity": "high",
        "action": "block",
        "blockViolations": True,
        "assignedAgents": ["my-agent"],
    },
)
policy_id = response.json()["policy"]["policyId"]
```

### List violations

```python
response = requests.get(
    "https://b0vyk178b7.execute-api.us-east-1.amazonaws.com/v1/projects/{projectId}/violations",
    headers={"x-api-key": "leap360_your_key_here"},
)
print(response.json())
```

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| LEAP360_API_KEY | API key. Read automatically if not passed to the constructor |
| LEAP360_API_URL | Override the API base URL (for self-hosting) |

```python
import os
os.environ["LEAP360_API_KEY"] = "leap360_your_key_here"

from leap360 import Leap360
leap = Leap360()  # reads from environment
```

---

## API Reference

### Class: Leap360

```python
Leap360(api_key: str = None, base_url: str = None, project_id: str = "me", timeout: float = 10.0)
```

If `api_key` is not provided, the constructor reads `LEAP360_API_KEY`, then `~/.leap360/config.json` (written by `npx leap360 login`). `base_url` defaults to `LEAP360_API_URL` or the hosted API.

Every method returns the API's JSON. **Errors are returned, not raised**: the dict carries `error`, `code` and `http_status` (`0` when the API can't be reached), so tracing never crashes your app.

#### Methods

**trace(model, **fields) -> dict**

Submit a trace. Returns the API response as a dictionary containing `id` and `status`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| model | str | Yes | Model identifier |
| provider | str | No | Provider: bedrock, openai, anthropic, gemini, azure, mistral, cohere |
| service_name | str | No | Agent or service name for grouping |
| agent_name | str | No | Named agent (distinct from service_name) |
| run_id | str | No | Group multiple traces into a run |
| latency_ms | int | No | Request latency in milliseconds |
| usage | dict | No | Token usage: prompt_tokens, completion_tokens, total_tokens |
| request | dict | No | The request body sent to the model |
| response | dict | No | The response body received from the model |
| error | str | No | Error message if the call failed |
| timestamp | str | No | ISO 8601 timestamp. Defaults to current UTC time |

**Reading your project**

| Method | Returns |
|--------|---------|
| `get_stats()` | Total traces, tokens, average latency, agent count, model breakdown |
| `get_traces(limit=50, offset=0)` | A page of traces |
| `get_agents()` | Agents with their statistics and kill switch status |
| `get_models()` | Usage per model |
| `get_violations()` | Policy violations |
| `get_policies()` | Your policies |
| `get_approvals()` | Calls waiting for a person to approve |
| `get_audit()` | The audit log |

**Kill switch**

| Method | Effect |
|--------|--------|
| `get_agent_status(agent_id)` | `{"status": "ACTIVE"}` or `{"status": "SUSPENDED"}` |
| `suspend_agent(agent_id)` / `resume_agent(agent_id)` | Stop or restart one agent |
| `get_project_status()` / `set_project_status(status)` | The same for the whole project |

An API key can always **stop** agents. Restarting them, like every other change that loosens governance, needs a person signed in to the console: with an API key alone it returns `{"code": "PERSON_REQUIRED", "http_status": 403}`. Agents run with the API key, so an agent can never lift its own kill switch, approve its own held calls, switch the project to shadow mode or delete a policy.

**Shadow mode, actions and code scans**

| Method | Returns |
|--------|---------|
| `get_mode()` | The project status, including `mode`: `"shadow"` or `"enforce"` |
| `set_mode(mode, days=None)` | Switch mode; shadow can run for `days` (1 to 30) |
| `get_shadow_report()` | What policies would have blocked, per-agent activity and suggested policies |
| `get_actions(limit=100, since=None)` | Recorded tool calls (default: the last 7 days) |
| `get_scans()` | Reports uploaded by `npx leap360 scan --report` |

**Writing**

| Method | Effect |
|--------|--------|
| `create_policy(policy)` | Create a policy (same body as the console) |
| `decide_approval(trace_id, decision, note=None)` | `"approved"` or `"rejected"` |

### Class: Leap360Tracer

Wraps an LLM client so every call is traced in the background, with no code changes:

```python
import openai
from leap360 import Leap360Tracer

tracer = Leap360Tracer(service_name="search")      # reads LEAP360_API_KEY
client = tracer.wrap(openai.OpenAI())              # OpenAI, Anthropic, Gemini and Bedrock clients
client.chat.completions.create(model="gpt-4o", messages=[...])
```

For any other provider, `tracer.trace_call(fn, provider=..., model=..., extract_usage=...)` runs `fn` and traces it.

### Class: Leap360Governor

See [Govern Tool Calls](#govern-tool-calls).

---

## Troubleshooting

**Traces are not appearing in the dashboard**

- Verify the API key starts with `leap360_`
- Check that `LEAP360_API_KEY` is set or the key is passed to the constructor
- Confirm outbound HTTPS to `b0vyk178b7.execute-api.us-east-1.amazonaws.com` is not blocked by your network
- Check the return value of `leap.trace()` for error fields

**I receive HTTP 403**

The agent or project is suspended. Use a GET request to check the status and a POST request with `{"status": "ACTIVE"}` to resume it.

**I receive HTTP 401**

The `x-api-key` header was not sent or the key is malformed. Verify the key format and that the constructor received it correctly.

**First request takes 1-5 seconds**

AWS Lambda cold start. Subsequent warm requests complete in 200-500ms. This is expected for serverless deployments.

**trace() raises a connection error**

Check network connectivity. The SDK makes an HTTPS POST to the API endpoint. If operating in a restricted environment (AWS VPC, corporate proxy), ensure outbound HTTPS is permitted to `b0vyk178b7.execute-api.us-east-1.amazonaws.com`.

---

## License

Apache 2.0.
