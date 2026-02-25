import os
import uuid
import json
import time
import getpass
import threading
from datetime import datetime, timezone
import requests
import contextvars
from functools import wraps

# Context variables for tracking run state
run_id_var = contextvars.ContextVar('run_id', default=None)
agent_name_var = contextvars.ContextVar('agent_name', default=None)

class Leap360:
    def __init__(self, api_key: str, project_id: str, service_name: str, base_url: str = None):
        self.api_key = api_key
        self.project_id = project_id
        self.service_name = service_name
        self.base_url = (base_url or 'https://api.leap360.ai').rstrip('/')
        self._wrapped_client = None

    def wrap_openai(self, client):
        original_create = client.chat.completions.create

        @wraps(original_create)
        def patched_create(*args, **kwargs):
            start_time = time.time()
            run_id = run_id_var.get()
            agent_name = agent_name_var.get()
            
            response = None
            error = None
            
            try:
                response = original_create(*args, **kwargs)
                return response
            except Exception as e:
                error = e
                raise e
            finally:
                latency_ms = int((time.time() - start_time) * 1000)
                
                # Extract requested model and body
                body = kwargs
                if not body and args:
                    body = args[0] if isinstance(args[0], dict) else {"content": str(args)}
                elif not body:
                    body = {}
                    
                model = body.get('model', 'unknown')
                usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
                
                response_dict = None
                
                if response:
                    # Depending on if it's a Pydantic model (OpenAI v1) or dict
                    response_dict = getattr(response, "model_dump", lambda: response)() if hasattr(response, "model_dump") else (response.__dict__ if hasattr(response, "__dict__") else response)
                    
                    if isinstance(response_dict, dict):
                        model = response_dict.get('model', model)
                        resp_usage = response_dict.get('usage', {})
                        if resp_usage:
                            usage = {
                                "prompt_tokens": resp_usage.get('prompt_tokens', 0),
                                "completion_tokens": resp_usage.get('completion_tokens', 0),
                                "total_tokens": resp_usage.get('total_tokens', 0)
                            }
                
                payload = {
                    "project_id": self.project_id,
                    "service_name": self.service_name,
                    "agent_name": agent_name,
                    "run_id": run_id or str(uuid.uuid4()),
                    "provider": "openai",
                    "model": model,
                    "request": body,
                    "response": response_dict,
                    "latency_ms": latency_ms,
                    "usage": usage,
                    "timestamp": datetime.fromtimestamp(start_time, tz=timezone.utc).isoformat(),
                    "error": str(error) if error else None
                }
                
                self._send_trace(payload)

        client.chat.completions.create = patched_create
        self._wrapped_client = client
        return client

    def _send_trace(self, payload: dict):
        url = f"{self.base_url}/v1/traces"
        headers = {
            "Content-Type": "application/json",
            "x-leap360-key": self.api_key
        }
        
        def post():
            try:
                requests.post(url, json=payload, headers=headers, timeout=5)
            except Exception as e:
                print(f"[Leap360] Error sending trace event: {e}")
                
        # Fire and forget
        threading.Thread(target=post, daemon=True).start()

    def create_agent(self, name: str):
        class AgentRunContext:
            def __init__(self, leap360_instance, agent_name):
                self.instance = leap360_instance
                self.agent_name = agent_name
                
            def run(self, fn):
                run_id = str(uuid.uuid4())
                
                # We need to run inside the context
                def run_with_context(*args, **kwargs):
                    token_run = run_id_var.set(run_id)
                    token_agent = agent_name_var.set(self.agent_name)
                    try:
                        # If fn takes 1 arg, pass the client
                        import inspect
                        sig = inspect.signature(fn)
                        if len(sig.parameters) >= 1:
                            return fn(self.instance._wrapped_client)
                        return fn()
                    finally:
                        run_id_var.reset(token_run)
                        agent_name_var.reset(token_agent)
                        
                return run_with_context()

        return AgentRunContext(self, name)
