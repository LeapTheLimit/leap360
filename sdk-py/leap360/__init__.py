"""
leap360 — Python SDK for Leap360 AI Governance
===============================================

Usage::

    from leap360 import Leap360Tracer
    from openai import OpenAI

    tracer = Leap360Tracer(
        api_key="leap360-dev-secret-key-change-me",
        project_id="00000000-0000-0000-0000-000000000001",
        service_name="my-service",
        # base_url defaults to http://localhost:4000 for local development
    )

    client = tracer.wrap(OpenAI())
    response = client.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": "Hello!"}],
    )
"""

from __future__ import annotations

import os
import uuid
import json
import time
import threading
from datetime import datetime, timezone
from functools import wraps
from typing import Callable, Optional, Any
import contextvars

try:
    import requests as _requests
    _HAS_REQUESTS = True
except ImportError:
    _HAS_REQUESTS = False

# ─── Context vars (supports async and threaded code) ─────────────────────────

_run_id_var: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("run_id", default=None)
_agent_name_var: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("agent_name", default=None)


# ─── Main tracer class ────────────────────────────────────────────────────────

class Leap360Tracer:
    """
    Central tracer.  Wrap any supported LLM client with ``tracer.wrap(client)``
    and every call will be automatically traced and checked against the
    kill-switch on your local Leap360 server.
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        project_id: Optional[str] = None,
        service_name: Optional[str] = None,
        base_url: Optional[str] = None,
        silent: bool = False,
    ) -> None:
        self.api_key = (
            api_key
            or os.environ.get("LEAP360_API_KEY")
            or "leap360-dev-secret-key-change-me"
        )
        self.project_id = (
            project_id
            or os.environ.get("LEAP360_PROJECT_ID")
            or "00000000-0000-0000-0000-000000000001"
        )
        self.service_name = (
            service_name
            or os.environ.get("LEAP360_SERVICE_NAME")
            or "python-service"
        )
        self.base_url = (base_url or os.environ.get("LEAP360_BASE_URL") or "http://localhost:4000").rstrip("/")
        self.silent = silent

    # ── Kill-switch check ─────────────────────────────────────────────────────

    def check_kill_switch(self, agent_name: Optional[str] = None) -> None:
        """
        Query the local Leap360 API to see if this project/agent is suspended.
        Raises ``RuntimeError`` if suspended.  Silently passes if the API is
        unreachable (fail-open behaviour so your app still works offline).
        """
        if not _HAS_REQUESTS:
            return
        try:
            params: dict = {}
            if agent_name:
                params["agent"] = agent_name
            resp = _requests.get(
                f"{self.base_url}/v1/projects/{self.project_id}/killswitch/check",
                params=params,
                headers={"x-leap360-key": self.api_key},
                timeout=2,
            )
            if resp.ok:
                data = resp.json()
                if not data.get("allowed", True):
                    scope = data.get("scope", "unknown")
                    reason = data.get("reason", "suspended")
                    raise RuntimeError(
                        f"[Leap360] KILL_SWITCH_ACTIVE ({scope}): {reason}"
                    )
        except RuntimeError:
            raise
        except Exception:
            if not self.silent:
                pass  # API unreachable — fail open

    # ── Auto-detect & wrap ────────────────────────────────────────────────────

    def wrap(self, client: Any) -> Any:
        """
        Auto-detect the client type and wrap it appropriately.

        Supports: OpenAI, Anthropic, google.generativeai.GenerativeModel,
                  google.genai.Client, boto3 Bedrock runtime client.
        """
        cls_name = type(client).__name__
        module = type(client).__module__ or ""

        if cls_name == "OpenAI" or (hasattr(client, "chat") and hasattr(client.chat, "completions")):
            return self._wrap_openai(client)
        elif cls_name == "Anthropic" or (hasattr(client, "messages") and hasattr(client.messages, "create")):
            return self._wrap_anthropic(client)
        elif cls_name == "GenerativeModel" or "generativeai" in module:
            return self._wrap_gemini(client)
        elif hasattr(client, "converse") and hasattr(client, "invoke_model"):
            return self._wrap_bedrock(client)
        else:
            if not self.silent:
                print(f"[Leap360] Warning: unknown client type '{cls_name}' — use trace_call() for manual tracing.")
            return client

    # ── OpenAI ────────────────────────────────────────────────────────────────

    def _wrap_openai(self, client: Any) -> Any:
        tracer = self
        original_create = client.chat.completions.create

        @wraps(original_create)
        def patched_create(*args: Any, **kwargs: Any) -> Any:
            agent_name = _agent_name_var.get()
            tracer.check_kill_switch(agent_name)

            start = time.time()
            response = None
            error = None
            try:
                response = original_create(*args, **kwargs)
                return response
            except Exception as e:
                error = str(e)
                raise
            finally:
                latency_ms = int((time.time() - start) * 1000)
                usage = getattr(response, "usage", None) or {}
                tracer._post_trace_bg(
                    run_id=_run_id_var.get() or str(uuid.uuid4()),
                    agent_name=agent_name,
                    provider="openai",
                    model=kwargs.get("model") or (args[0] if args else "unknown"),
                    request={"messages": kwargs.get("messages", []), "model": kwargs.get("model", "")},
                    response=_safe_dict(response),
                    latency_ms=latency_ms,
                    usage={
                        "prompt_tokens": getattr(usage, "prompt_tokens", 0) or usage.get("prompt_tokens", 0) if isinstance(usage, dict) else getattr(usage, "prompt_tokens", 0),
                        "completion_tokens": getattr(usage, "completion_tokens", 0) or usage.get("completion_tokens", 0) if isinstance(usage, dict) else getattr(usage, "completion_tokens", 0),
                        "total_tokens": getattr(usage, "total_tokens", 0) or usage.get("total_tokens", 0) if isinstance(usage, dict) else getattr(usage, "total_tokens", 0),
                    },
                    error=error,
                )

        client.chat.completions.create = patched_create
        return client

    # ── Anthropic ─────────────────────────────────────────────────────────────

    def _wrap_anthropic(self, client: Any) -> Any:
        tracer = self
        original_create = client.messages.create

        @wraps(original_create)
        def patched_create(*args: Any, **kwargs: Any) -> Any:
            agent_name = _agent_name_var.get()
            tracer.check_kill_switch(agent_name)

            start = time.time()
            response = None
            error = None
            try:
                response = original_create(*args, **kwargs)
                return response
            except Exception as e:
                error = str(e)
                raise
            finally:
                latency_ms = int((time.time() - start) * 1000)
                usage = getattr(response, "usage", None) or {}
                inp = getattr(usage, "input_tokens", 0) or (usage.get("input_tokens", 0) if isinstance(usage, dict) else 0)
                out = getattr(usage, "output_tokens", 0) or (usage.get("output_tokens", 0) if isinstance(usage, dict) else 0)
                tracer._post_trace_bg(
                    run_id=_run_id_var.get() or str(uuid.uuid4()),
                    agent_name=agent_name,
                    provider="anthropic",
                    model=kwargs.get("model", "unknown"),
                    request={"messages": kwargs.get("messages", []), "model": kwargs.get("model", "")},
                    response=_safe_dict(response),
                    latency_ms=latency_ms,
                    usage={"prompt_tokens": inp, "completion_tokens": out, "total_tokens": inp + out},
                    error=error,
                )

        client.messages.create = patched_create
        return client

    # ── Gemini ────────────────────────────────────────────────────────────────

    def _wrap_gemini(self, model: Any) -> Any:
        tracer = self
        original_generate = model.generate_content

        @wraps(original_generate)
        def patched_generate(*args: Any, **kwargs: Any) -> Any:
            agent_name = _agent_name_var.get()
            tracer.check_kill_switch(agent_name)

            start = time.time()
            response = None
            error = None
            try:
                response = original_generate(*args, **kwargs)
                return response
            except Exception as e:
                error = str(e)
                raise
            finally:
                latency_ms = int((time.time() - start) * 1000)
                meta = getattr(getattr(response, "response", None), "usage_metadata", None) or {}
                tracer._post_trace_bg(
                    run_id=_run_id_var.get() or str(uuid.uuid4()),
                    agent_name=agent_name,
                    provider="google",
                    model=getattr(model, "model_name", "gemini"),
                    request={"prompt": args[0] if args else kwargs},
                    response=_safe_dict(response),
                    latency_ms=latency_ms,
                    usage={
                        "prompt_tokens": getattr(meta, "prompt_token_count", 0) or 0,
                        "completion_tokens": getattr(meta, "candidates_token_count", 0) or 0,
                        "total_tokens": getattr(meta, "total_token_count", 0) or 0,
                    },
                    error=error,
                )

        model.generate_content = patched_generate
        return model

    # ── AWS Bedrock ───────────────────────────────────────────────────────────

    def _wrap_bedrock(self, client: Any) -> Any:
        tracer = self
        original_converse = client.converse

        @wraps(original_converse)
        def patched_converse(*args: Any, **kwargs: Any) -> Any:
            agent_name = _agent_name_var.get()
            tracer.check_kill_switch(agent_name)

            start = time.time()
            response = None
            error = None
            try:
                response = original_converse(*args, **kwargs)
                return response
            except Exception as e:
                error = str(e)
                raise
            finally:
                latency_ms = int((time.time() - start) * 1000)
                usage = (response or {}).get("usage", {})
                tracer._post_trace_bg(
                    run_id=_run_id_var.get() or str(uuid.uuid4()),
                    agent_name=agent_name,
                    provider="bedrock",
                    model=kwargs.get("modelId", "unknown"),
                    request={"messages": kwargs.get("messages", [])},
                    response=response or {},
                    latency_ms=latency_ms,
                    usage={
                        "prompt_tokens": usage.get("inputTokens", 0),
                        "completion_tokens": usage.get("outputTokens", 0),
                        "total_tokens": usage.get("totalTokens", 0),
                    },
                    error=error,
                )

        client.converse = patched_converse
        return client

    # ── Manual trace_call ─────────────────────────────────────────────────────

    def trace_call(
        self,
        fn: Callable,
        provider: str,
        model: str,
        agent_name: Optional[str] = None,
        extract_usage: Optional[Callable] = None,
    ) -> Any:
        """
        Manually trace any callable::

            tracer.trace_call(
                fn=lambda: my_llm.complete(prompt),
                provider="mistral",
                model="mistral-large-latest",
            )
        """
        resolved_agent = agent_name or _agent_name_var.get()
        self.check_kill_switch(resolved_agent)

        start = time.time()
        result = None
        error = None
        try:
            result = fn()
            return result
        except Exception as e:
            error = str(e)
            raise
        finally:
            latency_ms = int((time.time() - start) * 1000)
            usage = (
                extract_usage(result)
                if result is not None and extract_usage
                else {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
            )
            self._post_trace_bg(
                run_id=_run_id_var.get() or str(uuid.uuid4()),
                agent_name=resolved_agent,
                provider=provider,
                model=model,
                request={},
                response=_safe_dict(result) or {},
                latency_ms=latency_ms,
                usage=usage,
                error=error,
            )

    # ── Agent context manager ─────────────────────────────────────────────────

    def agent(self, name: str):
        """
        Context manager that tags all wrapped calls with an agent name::

            with tracer.agent("Finance-Bot"):
                response = client.chat.completions.create(...)
        """
        return _AgentContext(name)

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _post_trace_bg(self, **kwargs: Any) -> None:
        """Fire-and-forget trace post in a daemon thread."""
        t = threading.Thread(target=self._post_trace, kwargs=kwargs, daemon=True)
        t.start()

    def _post_trace(
        self,
        run_id: str,
        agent_name: Optional[str],
        provider: str,
        model: str,
        request: dict,
        response: dict,
        latency_ms: int,
        usage: dict,
        error: Optional[str],
    ) -> None:
        if not _HAS_REQUESTS:
            return
        payload = {
            "project_id": self.project_id,
            "service_name": self.service_name,
            "agent_name": agent_name,
            "run_id": run_id,
            "provider": provider,
            "model": model,
            "request": request,
            "response": response,
            "latency_ms": latency_ms,
            "usage": usage,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "error": error,
        }
        try:
            _requests.post(
                f"{self.base_url}/v1/traces",
                json=payload,
                headers={
                    "x-leap360-key": self.api_key,
                    "Content-Type": "application/json",
                },
                timeout=5,
            )
        except Exception as exc:
            if not self.silent:
                pass  # Silently ignore — tracing must never break the app


# ─── Agent context manager helper ────────────────────────────────────────────

class _AgentContext:
    def __init__(self, name: str) -> None:
        self._name = name
        self._token_run: Any = None
        self._token_agent: Any = None

    def __enter__(self) -> "_AgentContext":
        self._token_run = _run_id_var.set(str(uuid.uuid4()))
        self._token_agent = _agent_name_var.set(self._name)
        return self

    def __exit__(self, *_: Any) -> None:
        if self._token_run is not None:
            _run_id_var.reset(self._token_run)
        if self._token_agent is not None:
            _agent_name_var.reset(self._token_agent)


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _safe_dict(obj: Any) -> dict:
    """Convert an object to a plain dict for JSON serialization."""
    if obj is None:
        return {}
    if isinstance(obj, dict):
        return obj
    try:
        return json.loads(json.dumps(obj, default=str))
    except Exception:
        return {"__repr__": repr(obj)}


# ─── Backwards-compatible alias ───────────────────────────────────────────────

Leap360 = Leap360Tracer

__all__ = ["Leap360Tracer", "Leap360"]
