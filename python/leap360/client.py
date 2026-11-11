"""
Leap360 API client: send traces and read your project's data.

    from leap360 import Leap360

    leap = Leap360()  # reads LEAP360_API_KEY
    leap.trace(model="gpt-4o", provider="openai", service_name="my-agent", latency_ms=312)
    print(leap.get_shadow_report()["totals"])

Every method returns the API's JSON as a dict (or list). Errors are returned, not raised:
the dict carries `error`, `code` and `http_status`, so a suspended agent reads as
`{"code": "AGENT_HALT", "http_status": 403, ...}`.

An API key can tighten governance (stop agents, enforce, add policies) but never loosen it:
resuming an agent, switching to shadow mode, approving a held call and changing or deleting a
policy need a person signed in to the console, and return `{"code": "PERSON_REQUIRED", ...}` here.
"""

import json
import os
import time
import uuid

import requests

DEFAULT_API_URL = "https://b0vyk178b7.execute-api.us-east-1.amazonaws.com"


def _load_api_key():
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


class Leap360:
    def __init__(self, api_key=None, base_url=None, project_id="me", timeout=10.0):
        self.api_key = api_key or _load_api_key()
        self.base_url = (base_url or os.environ.get("LEAP360_API_URL") or DEFAULT_API_URL).rstrip("/")
        # The API scopes every project route to the API key; the id in the path is only a label
        self.project_id = project_id
        self.timeout = timeout

    # ─── HTTP ────────────────────────────────────────────────────────────

    def _request(self, method, path, body=None, params=None):
        if not self.api_key:
            return {"error": "No API key. Pass api_key or set LEAP360_API_KEY.", "code": "NO_API_KEY", "http_status": 0}
        try:
            res = requests.request(
                method,
                f"{self.base_url}{path}",
                headers={"x-api-key": self.api_key, "Content-Type": "application/json"},
                json=body,
                params={k: v for k, v in (params or {}).items() if v is not None},
                timeout=self.timeout,
            )
        except requests.RequestException as e:
            return {"error": str(e), "code": "UNREACHABLE", "http_status": 0}
        try:
            data = res.json()
        except ValueError:
            data = {"error": res.text[:500]} if not res.ok else {}
        if not res.ok:
            data = data if isinstance(data, dict) else {"error": data}
            data.setdefault("error", f"HTTP {res.status_code}")
            data["http_status"] = res.status_code
        return data

    def _project(self, *parts):
        return "/".join(["/v1/projects", self.project_id, *[str(p) for p in parts]])

    # ─── Traces ──────────────────────────────────────────────────────────

    def trace(self, model, provider=None, service_name="python-sdk", agent_name=None, run_id=None,
              latency_ms=0, usage=None, request=None, response=None, error=None, timestamp=None):
        """Submit one trace. Returns the API response (`id`, `status`), or an error dict."""
        return self._request("POST", "/v1/traces", {
            "project_id":   self.project_id,
            "service_name": service_name,
            "agent_name":   agent_name or service_name,
            "run_id":       run_id or str(uuid.uuid4()),
            "provider":     provider or "unknown",
            "model":        model,
            "request":      request or {},
            "response":     response,
            "latency_ms":   latency_ms,
            "usage":        usage or {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
            "timestamp":    timestamp or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "error":        error,
        })

    def get_traces(self, project_id=None, limit=50, offset=0):
        return self._request("GET", self._project("traces"), params={"limit": limit, "offset": offset})

    def get_stats(self, project_id=None):
        return self._request("GET", self._project("stats"))

    def get_models(self):
        return self._request("GET", self._project("models"))

    def get_audit(self):
        return self._request("GET", self._project("audit"))

    # ─── Agents and the kill switch ──────────────────────────────────────

    def get_agents(self, project_id=None):
        return self._request("GET", self._project("agents"))

    def get_agent_status(self, agent_id):
        return self._request("GET", self._project("agents", agent_id, "status"))

    def suspend_agent(self, agent_id):
        return self._request("POST", self._project("agents", agent_id, "status"), {"status": "SUSPENDED"})

    def resume_agent(self, agent_id):
        return self._request("POST", self._project("agents", agent_id, "status"), {"status": "ACTIVE"})

    def get_project_status(self):
        return self._request("GET", self._project("status"))

    def set_project_status(self, status):
        return self._request("POST", self._project("status"), {"status": status})

    # ─── Policies and violations ─────────────────────────────────────────

    def get_policies(self):
        return self._request("GET", self._project("policies"))

    def create_policy(self, policy):
        return self._request("POST", self._project("policies"), policy)

    def get_violations(self):
        return self._request("GET", self._project("violations"))

    def get_approvals(self):
        return self._request("GET", self._project("approvals"))

    def decide_approval(self, trace_id, decision, note=None):
        """decision: "approved" or "rejected" (any case)"""
        return self._request("POST", self._project("approvals", trace_id, "decision"), {"decision": str(decision).upper(), "adminNote": note})

    # ─── Shadow mode, actions and code scans ─────────────────────────────

    def get_mode(self):
        """The project's status, including `mode`: "shadow" or "enforce"."""
        return self._request("GET", self._project("mode"))

    def set_mode(self, mode, days=None):
        """mode: "shadow" (optionally for `days`, 1 to 30) or "enforce" """
        return self._request("POST", self._project("mode"), {"mode": mode, "days": days})

    def get_shadow_report(self):
        """What policies would have blocked, per-agent activity and suggested policies."""
        return self._request("GET", self._project("shadow"))

    def get_actions(self, limit=100, since=None):
        """Recorded tool calls, newest first. `since` is an ISO time (default: the last 7 days)."""
        return self._request("GET", self._project("actions"), params={"limit": limit, "since": since})

    def get_scans(self):
        """Reports uploaded by `leap360 scan --report`."""
        return self._request("GET", self._project("scans"))
