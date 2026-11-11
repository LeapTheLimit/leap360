"""
Leap360 Python SDK — Universal AI Tracing

Supported providers (all auto-detected via wrap()):
  ✅ openai          — openai.OpenAI()
  ✅ anthropic       — anthropic.Anthropic()
  ✅ google-gemini   — google.generativeai / google.genai
  ✅ aws-bedrock     — boto3 bedrock-runtime client
  ✅ any provider    — use trace_call() for manual tracing

Quick start:
    from leap360 import Leap360Tracer

    tracer = Leap360Tracer(api_key="leap360_...", project_id="my-project")

    # Auto-wrap (zero code change):
    import openai
    client = tracer.wrap(openai.OpenAI())
    client.chat.completions.create(model="gpt-4o", messages=[...])

    # Manual trace (works with ANY provider):
    result = tracer.trace_call(
        fn=lambda: my_llm_call(),
        provider="anthropic",
        model="claude-3-5-sonnet-20241022",
        extract_usage=lambda r: {
            "prompt_tokens": r.usage.input_tokens,
            "completion_tokens": r.usage.output_tokens,
            "total_tokens": r.usage.input_tokens + r.usage.output_tokens,
        }
    )
"""

import os
import time
import uuid
import json
import requests
from functools import wraps
import threading


class Leap360Tracer:
    _warned_unknown_key = False

    def __init__(self, api_key=None, service_name="python-sdk", project_id="default", capture=None):
        from .privacy import capture_level
        self.api_key = api_key or self._load_api_key()
        # What leaves this process (issue #50): 'metadata' (default), 'redacted' or 'full'. See leap360.privacy.
        self.capture = capture_level(capture)
        self.service_name = service_name
        self.project_id = project_id
        self.api_url = os.environ.get(
            "LEAP360_API_URL",
            "https://b0vyk178b7.execute-api.us-east-1.amazonaws.com"
        )

    def _load_api_key(self):
        """Loads the Leap360 API key from environment variables or local CLI config."""
        key = os.environ.get("LEAP360_API_KEY")
        if key:
            return key
        config_path = os.path.expanduser("~/.leap360/config.json")
        if os.path.exists(config_path):
            try:
                with open(config_path, "r", encoding="utf-8") as f:
                    return json.load(f).get("apiKey")
            except Exception:
                pass
        return None

    def _build_payload(self, *, provider, model, request, response, latency_ms,
                       usage=None, error=None, agent_name=None, run_id=None):
        """Build a Leap360-compatible trace payload."""
        return {
            "project_id":   self.project_id,
            "service_name": self.service_name,
            "agent_name":   agent_name or self.service_name,
            "run_id":       run_id or str(uuid.uuid4()),
            "provider":     provider,
            "model":        model,
            "request":      request or {},
            "response":     response,
            "latency_ms":   latency_ms,
            "usage":        usage or {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
            "timestamp":    time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "error":        error,
        }

    def _send_trace_async(self, payload):
        """Send trace in a background thread — never blocks the LLM call."""
        if not self.api_key:
            return  # Silent drop if not authenticated
        from .privacy import trace_at_capture
        payload = trace_at_capture(payload, self.capture)

        def _post():
            try:
                res = requests.post(
                    f"{self.api_url}/v1/traces",
                    headers={
                        "Content-Type": "application/json",
                        # Accept both header names for compatibility
                        "x-api-key": self.api_key,
                    },
                    json=payload,
                    timeout=5,
                )
                # An unknown key is a setup mistake, not a transient error: say so once
                if res.status_code == 401 and not Leap360Tracer._warned_unknown_key:
                    Leap360Tracer._warned_unknown_key = True
                    try:
                        msg = res.json().get("error")
                    except ValueError:
                        msg = None
                    print(f"[Leap360] {msg or 'The API key was not accepted.'} Traces are not being recorded.", flush=True)
            except Exception:
                pass  # Fail silently — tracing must never break the app

        threading.Thread(target=_post, daemon=True).start()

    # ─── Universal wrap() — auto-detects provider ────────────────────────

    def wrap(self, client):
        """
        Auto-detects the client type and wraps it for zero-code tracing.

        Supported:
          openai.OpenAI()                   → provider='openai'
          anthropic.Anthropic()             → provider='anthropic'
          google.generativeai client        → provider='google'
          boto3 bedrock-runtime client      → provider='bedrock'

        Returns the same client object, now patched.
        """
        client_type_str = str(type(client)).lower()
        module_str = getattr(type(client), "__module__", "").lower()

        if ("openai" in client_type_str or "openai" in module_str) and hasattr(client, "chat"):
            return self._wrap_openai(client)

        if "anthropic" in client_type_str or "anthropic" in module_str:
            return self._wrap_anthropic(client)

        if "google" in module_str or "generativeai" in module_str or "genai" in module_str:
            return self._wrap_gemini(client)

        # AWS Bedrock: boto3 client with service_name == 'bedrock-runtime'
        meta = getattr(client, "meta", None)
        service = getattr(meta, "service_model", None)
        service_name = getattr(service, "service_name", "") if service else ""
        if "bedrock" in service_name or "bedrock" in client_type_str:
            return self._wrap_bedrock(client)

        # Unknown client — return as-is with a warning
        print(
            f"[Leap360] ⚠️  wrap() could not detect provider for {type(client).__name__}. "
            "Use trace_call() for manual tracing."
        )
        return client

    # ─── OpenAI ──────────────────────────────────────────────────────────

    def _wrap_openai(self, client):
        original_create = client.chat.completions.create
        tracer = self

        @wraps(original_create)
        def patched_create(*args, **kwargs):
            start_time = time.time()
            error_str = None
            response = None
            try:
                response = original_create(*args, **kwargs)
                return response
            except Exception as e:
                error_str = str(e)
                raise
            finally:
                latency_ms = int((time.time() - start_time) * 1000)
                usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
                if response and hasattr(response, "usage") and response.usage:
                    usage = {
                        "prompt_tokens": getattr(response.usage, "prompt_tokens", 0),
                        "completion_tokens": getattr(response.usage, "completion_tokens", 0),
                        "total_tokens": getattr(response.usage, "total_tokens", 0),
                    }
                model = kwargs.get("model", args[0] if args else "unknown")
                resp_data = response.model_dump() if hasattr(response, "model_dump") else (str(response) if response else None)
                payload = tracer._build_payload(
                    provider="openai",
                    model=model,
                    request={"messages": kwargs.get("messages", [])},
                    response=resp_data,
                    latency_ms=latency_ms,
                    usage=usage,
                    error=error_str,
                )
                tracer._send_trace_async(payload)

        client.chat.completions.create = patched_create
        return client

    # ─── Anthropic ───────────────────────────────────────────────────────

    def _wrap_anthropic(self, client):
        """
        Wraps anthropic.Anthropic().messages.create
        Anthropic uses input_tokens / output_tokens (not prompt_tokens / completion_tokens).
        """
        original_create = client.messages.create
        tracer = self

        @wraps(original_create)
        def patched_create(*args, **kwargs):
            start_time = time.time()
            error_str = None
            response = None
            try:
                response = original_create(*args, **kwargs)
                return response
            except Exception as e:
                error_str = str(e)
                raise
            finally:
                latency_ms = int((time.time() - start_time) * 1000)
                usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
                if response and hasattr(response, "usage") and response.usage:
                    inp = getattr(response.usage, "input_tokens", 0) or 0
                    out = getattr(response.usage, "output_tokens", 0) or 0
                    usage = {
                        "prompt_tokens": inp,
                        "completion_tokens": out,
                        "total_tokens": inp + out,
                    }
                model = kwargs.get("model", getattr(response, "model", "unknown"))
                # Extract text from response content blocks
                resp_text = None
                if response and hasattr(response, "content"):
                    try:
                        resp_text = " ".join(
                            block.text for block in response.content
                            if hasattr(block, "text")
                        )
                    except Exception:
                        resp_text = str(response)
                payload = tracer._build_payload(
                    provider="anthropic",
                    model=model,
                    request={
                        "messages": kwargs.get("messages", []),
                        "system": kwargs.get("system"),
                    },
                    response={"text": resp_text} if resp_text else None,
                    latency_ms=latency_ms,
                    usage=usage,
                    error=error_str,
                )
                tracer._send_trace_async(payload)

        client.messages.create = patched_create
        return client

    # ─── Google Gemini ───────────────────────────────────────────────────

    def _wrap_gemini(self, client):
        """
        Wraps google-generativeai GenerativeModel.generate_content
        or google-genai models.generate_content.
        Supports both old (@google/generativeai) and new (@google/genai) SDKs.
        """
        tracer = self

        # New SDK: google.genai — client.models.generate_content(model=..., contents=...)
        models_obj = getattr(client, "models", None)
        if models_obj is not None:
            orig_generate = getattr(models_obj, "generate_content", None)
            if orig_generate:
                @wraps(orig_generate)
                def patched_genai_generate(*args, **kwargs):
                    start_time = time.time()
                    error_str = None
                    response = None
                    try:
                        response = orig_generate(*args, **kwargs)
                        return response
                    except Exception as e:
                        error_str = str(e)
                        raise
                    finally:
                        latency_ms = int((time.time() - start_time) * 1000)
                        model_name = kwargs.get("model", "gemini")
                        usage = tracer._extract_gemini_usage(response)
                        payload = tracer._build_payload(
                            provider="google",
                            model=model_name,
                            request={"contents": kwargs.get("contents", kwargs.get("prompt", ""))},
                            response={"text": tracer._extract_gemini_text(response)},
                            latency_ms=latency_ms,
                            usage=usage,
                            error=error_str,
                        )
                        tracer._send_trace_async(payload)
                models_obj.generate_content = patched_genai_generate
            return client

        # Old SDK: GenerativeModel instance with generate_content method
        orig_generate = getattr(client, "generate_content", None)
        if orig_generate:
            model_name = getattr(client, "model_name", "gemini")

            @wraps(orig_generate)
            def patched_gemini_generate(*args, **kwargs):
                start_time = time.time()
                error_str = None
                response = None
                try:
                    response = orig_generate(*args, **kwargs)
                    return response
                except Exception as e:
                    error_str = str(e)
                    raise
                finally:
                    latency_ms = int((time.time() - start_time) * 1000)
                    usage = tracer._extract_gemini_usage(response)
                    contents = args[0] if args else kwargs.get("contents", "")
                    payload = tracer._build_payload(
                        provider="google",
                        model=model_name,
                        request={"contents": contents if isinstance(contents, str) else str(contents)},
                        response={"text": tracer._extract_gemini_text(response)},
                        latency_ms=latency_ms,
                        usage=usage,
                        error=error_str,
                    )
                    tracer._send_trace_async(payload)
            client.generate_content = patched_gemini_generate
        return client

    def _extract_gemini_usage(self, response):
        """Extract token counts from a Gemini response (handles both SDK versions)."""
        if not response:
            return {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        # New SDK: response.usage_metadata
        um = getattr(response, "usage_metadata", None)
        if um:
            return {
                "prompt_tokens": getattr(um, "prompt_token_count", 0) or 0,
                "completion_tokens": getattr(um, "candidates_token_count", 0) or 0,
                "total_tokens": getattr(um, "total_token_count", 0) or 0,
            }
        # Old SDK: response.response.usageMetadata (nested)
        inner = getattr(response, "response", None)
        um2 = getattr(inner, "usageMetadata", None) if inner else None
        if um2:
            return {
                "prompt_tokens": getattr(um2, "promptTokenCount", 0) or 0,
                "completion_tokens": getattr(um2, "candidatesTokenCount", 0) or 0,
                "total_tokens": getattr(um2, "totalTokenCount", 0) or 0,
            }
        return {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}

    def _extract_gemini_text(self, response):
        """Extract text from a Gemini response."""
        if not response:
            return None
        try:
            return response.text
        except Exception:
            pass
        try:
            return str(response)
        except Exception:
            return None

    # ─── AWS Bedrock ─────────────────────────────────────────────────────

    def _wrap_bedrock(self, client):
        """
        Wraps boto3 bedrock-runtime client.invoke_model and
        converse (the new unified API).

        Works with any model hosted on Bedrock:
          - anthropic.claude-* 
          - amazon.titan-*
          - meta.llama*
          - mistral.*
          - cohere.*
        """
        tracer = self

        # Wrap converse() — the recommended modern Bedrock API
        orig_converse = getattr(client, "converse", None)
        if orig_converse:
            @wraps(orig_converse)
            def patched_converse(*args, **kwargs):
                start_time = time.time()
                error_str = None
                response = None
                try:
                    response = orig_converse(*args, **kwargs)
                    return response
                except Exception as e:
                    error_str = str(e)
                    raise
                finally:
                    latency_ms = int((time.time() - start_time) * 1000)
                    model_id = kwargs.get("modelId", "unknown-bedrock-model")
                    usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
                    if response:
                        meta = response.get("usage", {})
                        inp = meta.get("inputTokens", 0) or 0
                        out = meta.get("outputTokens", 0) or 0
                        usage = {
                            "prompt_tokens": inp,
                            "completion_tokens": out,
                            "total_tokens": inp + out,
                        }
                    payload = tracer._build_payload(
                        provider="bedrock",
                        model=model_id,
                        request={
                            "messages": kwargs.get("messages", []),
                            "system": kwargs.get("system"),
                        },
                        response=response,
                        latency_ms=latency_ms,
                        usage=usage,
                        error=error_str,
                    )
                    tracer._send_trace_async(payload)
            client.converse = patched_converse

        # Also wrap invoke_model() — the lower-level API
        orig_invoke = getattr(client, "invoke_model", None)
        if orig_invoke:
            @wraps(orig_invoke)
            def patched_invoke(*args, **kwargs):
                start_time = time.time()
                error_str = None
                response = None
                try:
                    response = orig_invoke(*args, **kwargs)
                    return response
                except Exception as e:
                    error_str = str(e)
                    raise
                finally:
                    latency_ms = int((time.time() - start_time) * 1000)
                    model_id = kwargs.get("modelId", "unknown-bedrock-model")
                    # Parse response body to extract usage if available
                    usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
                    resp_body = None
                    if response and "body" in response:
                        try:
                            import json as _json
                            body_bytes = response["body"].read()
                            resp_body = _json.loads(body_bytes)
                            # Anthropic on Bedrock
                            if "usage" in resp_body:
                                u = resp_body["usage"]
                                inp = u.get("input_tokens", 0) or 0
                                out = u.get("output_tokens", 0) or 0
                                usage = {"prompt_tokens": inp, "completion_tokens": out, "total_tokens": inp + out}
                            # Amazon Titan
                            elif "inputTextTokenCount" in resp_body:
                                inp = resp_body.get("inputTextTokenCount", 0) or 0
                                out = resp_body.get("results", [{}])[0].get("tokenCount", 0) or 0
                                usage = {"prompt_tokens": inp, "completion_tokens": out, "total_tokens": inp + out}
                        except Exception:
                            pass
                    payload = tracer._build_payload(
                        provider="bedrock",
                        model=model_id,
                        request={"body": kwargs.get("body")},
                        response=resp_body,
                        latency_ms=latency_ms,
                        usage=usage,
                        error=error_str,
                    )
                    tracer._send_trace_async(payload)
            client.invoke_model = patched_invoke

        return client

    # ─── Manual trace_call() — works with ANY provider ───────────────────

    def trace_call(self, fn, *, provider, model, agent_name=None,
                   extract_usage=None, extract_request=None, extract_response=None):
        """
        Manually trace any LLM call. Works with any provider.

        Args:
            fn: A callable (no args) that makes the LLM call and returns the response.
            provider: e.g. 'openai', 'anthropic', 'google', 'bedrock', 'mistral'
            model: e.g. 'gpt-4o', 'claude-3-5-sonnet-20241022'
            agent_name: Optional agent label shown in dashboard.
            extract_usage: Optional callable(response) → dict with
                           prompt_tokens, completion_tokens, total_tokens.
            extract_request: Optional callable(response) → dict
            extract_response: Optional callable(response) → dict

        Returns:
            The original response from fn(), unchanged.

        Example (Anthropic):
            result = tracer.trace_call(
                fn=lambda: client.messages.create(
                    model="claude-3-5-sonnet-20241022",
                    max_tokens=1024,
                    messages=[{"role": "user", "content": "Hello!"}],
                ),
                provider="anthropic",
                model="claude-3-5-sonnet-20241022",
                extract_usage=lambda r: {
                    "prompt_tokens": r.usage.input_tokens,
                    "completion_tokens": r.usage.output_tokens,
                    "total_tokens": r.usage.input_tokens + r.usage.output_tokens,
                },
            )
        """
        start_time = time.time()
        error_str = None
        response = None
        try:
            response = fn()
            return response
        except Exception as e:
            error_str = str(e)
            raise
        finally:
            latency_ms = int((time.time() - start_time) * 1000)
            usage = None
            if extract_usage and response is not None:
                try:
                    usage = extract_usage(response)
                except Exception:
                    pass
            req = None
            if extract_request and response is not None:
                try:
                    req = extract_request(response)
                except Exception:
                    pass
            resp = None
            if extract_response and response is not None:
                try:
                    resp = extract_response(response)
                except Exception:
                    pass
            payload = self._build_payload(
                provider=provider,
                model=model,
                request=req or {},
                response=resp,
                latency_ms=latency_ms,
                usage=usage,
                error=error_str,
                agent_name=agent_name,
            )
            self._send_trace_async(payload)
