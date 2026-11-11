"""
leap360.governor — govern what a Python agent DOES, not only what it says.

Every tool call goes through the gate:

    from leap360 import Leap360Governor, ActionBlocked

    gov = Leap360Governor(agent_name="deploy-bot")

    @gov.wrap_tool("delete_namespace")
    def delete_namespace(name: str):
        ...

    try:
        delete_namespace(name="payments")
    except ActionBlocked as e:
        print(e.gate.message)          # the function never ran

Modes (set in the Leap360 console, or forced with ``mode=``):
    shadow   the call always runs; Leap360 records what policy WOULD have done. Never waits on Leap360,
             except for a kill-switch status no older than ``status_ttl`` (1 s).
    enforce  Leap360 decides before the call runs. A call the policies block raises ActionBlocked.

The kill switch applies in both modes. When Leap360 cannot be reached in enforce mode, calls that look
destructive at or above ``fail_closed_at`` (default "critical") are blocked and the rest run.
A request the API refuses (4xx) is always blocked: a call Leap360 will not check must not run unchecked.
Only the standard library is used.
"""

import asyncio
import dataclasses
import datetime
import decimal
import functools
import inspect
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
import uuid

# Same default as the tracer; both API addresses are served by one function since 2026-10-07
DEFAULT_API_URL = "https://b0vyk178b7.execute-api.us-east-1.amazonaws.com"
RISKS = ["none", "low", "medium", "high", "critical"]


# ─── Safe serialisation ─────────────────────────────────────────────────────

def to_plain(value, _depth=0, _seen=None):
    """A JSON-safe copy of anything a tool might receive. Never raises: a value that could not be
    serialised must not let the call skip its policy check."""
    if _seen is None:
        _seen = set()
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        return value if abs(value) < 2 ** 53 else str(value)
    if isinstance(value, float):
        return value if value == value and value not in (float("inf"), float("-inf")) else str(value)
    if isinstance(value, decimal.Decimal):
        return str(value)
    if isinstance(value, (datetime.datetime, datetime.date)):
        return value.isoformat()
    if isinstance(value, (bytes, bytearray, memoryview)):
        return f"[binary {len(value)} bytes]"
    if callable(value) and not hasattr(value, "model_dump"):
        return f"[function {getattr(value, '__name__', 'anonymous')}]"
    if _depth > 12:
        return "[too deep]"
    if id(value) in _seen:
        return "[circular]"
    _seen = _seen | {id(value)}
    if isinstance(value, dict):
        return {str(k): to_plain(v, _depth + 1, _seen) for k, v in list(value.items())[:1000]}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [to_plain(v, _depth + 1, _seen) for v in list(value)[:1000]]
    if hasattr(value, "model_dump"):  # pydantic v2, OpenAI SDK objects
        try:
            return to_plain(value.model_dump(), _depth + 1, _seen)
        except Exception:
            pass
    if dataclasses.is_dataclass(value):
        return to_plain(dataclasses.asdict(value), _depth + 1, _seen)
    if isinstance(value, BaseException):
        return {"name": type(value).__name__, "message": str(value)}
    if hasattr(value, "__dict__"):
        return to_plain(vars(value), _depth + 1, _seen)
    return str(value)


# ─── Redaction (what leaves the process is redacted first) ──────────────────

_SECRET_PATTERNS = [
    (re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"), "AWS access key"),
    (re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b"), "GitHub token"),
    (re.compile(r"\bsk-ant-[A-Za-z0-9_\-]{20,}"), "Anthropic API key"),
    (re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_\-]{32,}"), "OpenAI API key"),
    (re.compile(r"\b[rs]k_live_[A-Za-z0-9]{16,}\b"), "Stripe live key"),
    (re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"), "Slack token"),
    (re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----"), "Private key"),
    (re.compile(r"\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*"), "Bearer token"),
]
_CONN_PASSWORD = re.compile(r"\b([a-z][a-z0-9+.-]*://[^\s:@/]+:)([^\s@/]{3,})@", re.IGNORECASE)


def redact(text):
    """Credentials replaced by a marker; a connection string keeps its shape with the password masked"""
    if not isinstance(text, str):
        return text
    text = _CONN_PASSWORD.sub(lambda m: f"{m.group(1)}[REDACTED]@", text)
    for pattern, label in _SECRET_PATTERNS:
        text = pattern.sub(lambda m, l=label: f"[REDACTED {l}: {m.group(0)[:4]}…]", text)
    return text


# ─── Offline risk (only used when Leap360 cannot decide) ────────────────────

_CRITICAL = re.compile(
    r"kubectl\s+delete|helm\s+(?:uninstall|delete)|rm\s+-[a-z]*r[a-z]*f|terraform\s+destroy|drop\s+(?:table|database|schema)"
    r"|delete\s+from\s+\w+\s*(?:;|$)|git\s+push\b.*--force|aws\s+iam\s+(?:create|attach|put|delete)|curl\b[^|]*\|\s*(?:ba)?sh"
    r"|delete[_.-]?(?:namespace|cluster|database|bucket|stack)|(?:attach|put|create)[_.-]?(?:role|user)?[_.-]?policy|drop[_.-]?(?:table|database)",
    re.IGNORECASE)
_HIGH = re.compile(
    r"(?:^|[_.-])(?:shell|bash|exec|run_?command|terminal|subprocess)(?:$|[_.-])|deploy|rollout|merge|push|release|terraform\s+apply"
    r"|refund|payment|charge|payout|transfer|secret|credential|password|token|delete|remove|destroy|purge|wipe",
    re.IGNORECASE)
_MEDIUM = re.compile(r"write|create|update|send|post|email|slack|message|http|request|upload|sql|query", re.IGNORECASE)
_READ = re.compile(r"^(?:[\w-]+[_.-])?(?:get|list|read|search|find|describe|view|show|fetch|lookup|count|check|status)(?:$|[_.-])", re.IGNORECASE)


def offline_risk(name, args):
    """A conservative guess at how risky a call is, from its name and its arguments"""
    text = f"{name} {json.dumps(args)[:4000]}"
    if _CRITICAL.search(text):
        return "critical"
    if _HIGH.search(name) or _HIGH.search(text):
        return "high"
    if _READ.search(name):
        return "low"
    if _MEDIUM.search(name):
        return "medium"
    return "medium"


# ─── Gate ───────────────────────────────────────────────────────────────────

WOULD_BE = {"allow": "allowed", "warn": "warned", "review": "held", "block": "blocked"}


@dataclasses.dataclass
class GateResult:
    allowed: bool
    action_id: str
    mode: str
    verdict: str            # what actually happens: allow, warn, review, block
    would_be: str           # what the policies say (differs from verdict in shadow mode)
    category: str = "unknown"
    risk: str = "medium"
    message: str = None
    policy: dict = None
    offline: bool = False


class ActionBlocked(Exception):
    """Raised by a governed tool that Leap360 blocked or held. The tool did not run."""

    def __init__(self, gate, code="ACTION_BLOCKED"):
        super().__init__(f"[Leap360] {code}: {gate.message or 'the call was blocked'}")
        self.code = code
        self.gate = gate


class _NoDecision(Exception):
    def __init__(self, kind, message):
        super().__init__(message)
        self.kind = kind  # offline, unsupported, unauthorized, refused


def _new_action_id():
    now = datetime.datetime.now(datetime.timezone.utc)
    return f"{now.strftime('%Y-%m-%dT%H:%M:%S.')}{now.microsecond // 1000:03d}Z~{uuid.uuid4()}"


class Leap360Governor:
    def __init__(self, api_key=None, agent_name="python-agent", api_url=None, mode=None, fail_closed_at="critical",
                 timeout=2.0, status_ttl=1.0, approval_wait=0.0, log=None, capture=None):
        if mode not in (None, "shadow", "enforce"):
            raise ValueError("mode must be 'shadow', 'enforce' or None (follow the console)")
        if fail_closed_at not in RISKS[1:]:
            raise ValueError(f"fail_closed_at must be one of {RISKS[1:]}")
        self.api_key = api_key or os.environ.get("LEAP360_API_KEY") or self._saved_key()
        self.agent_name = agent_name
        self.api_url = (api_url or os.environ.get("LEAP360_API_URL") or DEFAULT_API_URL).rstrip("/")
        self.forced_mode = mode
        self.fail_closed_at = fail_closed_at
        self.timeout = timeout
        self.status_ttl = status_ttl
        self.approval_wait = approval_wait
        self.log = log or (lambda m: print(m, flush=True))
        # What leaves this process (issue #50): 'metadata' (default), 'redacted' or 'full'. See leap360.privacy.
        from .privacy import capture_level
        self.capture = capture_level(capture)
        self._server_mode = None
        self._status = {"halted": None, "at": 0.0}
        self._status_lock = threading.Lock()
        self._pending_pre = {}
        self._warned = set()
        self._declared = set()

    # ── public ──────────────────────────────────────────────────────────

    @property
    def mode(self):
        return self.forced_mode or self._server_mode or "enforce"

    def wrap_tool(self, name=None, hints=None):
        """Decorator: the wrapped function runs only if Leap360 allows the call. Works for sync and async functions."""
        def decorate(fn):
            # Only None means "use the function's name": an empty name is an error, not a fallback
            tool = fn.__name__ if name is None else name
            if not isinstance(tool, str) or not tool.strip() or len(tool) > 200:
                raise TypeError("[Leap360] wrap_tool: the tool name must be 1 to 200 characters")
            sig = inspect.signature(fn)
            # Wrapping a tool declares that the agent can call it: recorded for the capability map, used or not
            doc = (inspect.getdoc(fn) or "").strip().splitlines()[:1]
            doc = doc[0] if doc else ""
            self.declare_tools([{"name": tool, "description": doc, "hints": hints}])

            def args_of(a, kw):
                try:
                    bound = sig.bind_partial(*a, **kw)
                    return dict(bound.arguments)
                except TypeError:
                    return {**{f"arg{i}": v for i, v in enumerate(a)}, **kw}

            if asyncio.iscoroutinefunction(fn):
                @functools.wraps(fn)
                async def awrapper(*a, **kw):
                    gate = await asyncio.to_thread(self.check, tool, args_of(a, kw), "sdk", hints)
                    self._raise_if_blocked(gate, tool)
                    t = time.monotonic()
                    try:
                        result = await fn(*a, **kw)
                    except BaseException as err:
                        self.record(gate.action_id, False, (time.monotonic() - t) * 1000, error=err)
                        raise
                    self.record(gate.action_id, True, (time.monotonic() - t) * 1000, result=result)
                    return result
                return awrapper

            @functools.wraps(fn)
            def wrapper(*a, **kw):
                return self.run(tool, args_of(a, kw), lambda: fn(*a, **kw), hints)
            return wrapper
        return decorate

    def declare_tools(self, tools, source="sdk", server=None):
        """Tells Leap360 which tools this agent can reach, whether or not it calls them. Once per tool, in the background."""
        batch = []
        for t in tools:
            tool = t.get("name") if isinstance(t, dict) else None
            key = (source, server or "", tool)
            if not isinstance(tool, str) or not tool or len(tool) > 200 or key in self._declared:
                continue
            self._declared.add(key)
            row = {"tool": tool, "source": source}
            if server:
                row["server"] = server
            if t.get("description"):
                row["description"] = str(t["description"])[:200]
            if t.get("hints"):
                row["hints"] = t["hints"]
            batch.append(row)
        if not batch or not self.api_key:
            return

        def post():
            try:
                self._post("/v1/capabilities", {"agent_name": self.agent_name, "tools": batch[:200]}, 10)
            except Exception:
                pass  # an API without /v1/capabilities answers 404: the map is a nice-to-have
        self._background(post)

    def run(self, name, args, fn, hints=None):
        """Runs fn behind the gate. Raises ActionBlocked (and fn never runs) when Leap360 blocks or holds the call."""
        gate = self.check(name, args, "sdk", hints)
        self._raise_if_blocked(gate, name)
        t = time.monotonic()
        try:
            result = fn()
        except BaseException as err:
            self.record(gate.action_id, False, (time.monotonic() - t) * 1000, error=err)
            raise
        self.record(gate.action_id, True, (time.monotonic() - t) * 1000, result=result)
        return result

    def check(self, name, args, source="sdk", hints=None):
        """Decides whether a call may run. Never raises: check .allowed."""
        name = name if isinstance(name, str) else str(name)
        plain = to_plain(args if args is not None else {})
        if not isinstance(plain, dict):
            plain = {"value": plain}
        action_id = _new_action_id()
        if not name.strip() or len(name) > 200:
            return GateResult(False, action_id, self.mode, "block", "block", message=f'"{name[:40]}" is not a valid tool name (1 to 200 characters), so it cannot be checked')
        from .privacy import redact_deep
        # At 'metadata' the arguments go with the check only: the API classifies them and keeps their keys and types
        sent = redact_deep(plain) if self.capture == "redacted" else plain
        body = {"phase": "pre", "id": action_id, "source": source, "agent_name": self.agent_name, "tool": name, "args": sent, "hints": hints, "capture": self.capture}

        if self.mode == "shadow":
            halted = self._current_status()["halted"]
            if halted:
                self._background(lambda: self._post("/v1/actions", body, 10))
                return GateResult(False, action_id, "shadow", "block", "block", message=halted["message"])
            done = threading.Event()
            self._pending_pre[action_id] = done

            def pre():
                try:
                    r = self._post("/v1/actions", body, 10)
                    self._learn(r)
                    if r and r.get("wouldBe") not in (None, "allow"):
                        self.log(f"[Leap360] watch: {name} ({r.get('category')}, {r.get('risk')} risk) would be {WOULD_BE.get(r.get('wouldBe'), r.get('wouldBe'))}; it ran")
                except Exception:
                    pass
                finally:
                    done.set()
                    self._pending_pre.pop(action_id, None)
            self._background(pre)
            return GateResult(True, action_id, "shadow", "allow", "allow")

        try:
            res = self._post("/v1/actions", body, self.timeout)
        except _NoDecision as nd:
            return self._no_decision(action_id, name, plain, nd)
        self._learn(res)
        halted = res.get("code") in ("GOVERNANCE_HALT", "AGENT_HALT")
        verdict = "block" if halted else (res.get("decision") or "allow")
        message = res.get("message")
        if verdict == "review" and self.approval_wait > 0 and res.get("approvalId"):
            self.log(f"[Leap360] {name} is waiting for approval in the Leap360 console (up to {int(self.approval_wait)} s)")
            decided = self._wait_for_approval(res["approvalId"])
            if decided == "APPROVED":
                verdict, message = "allow", "Approved in the Leap360 console"
            elif decided == "REJECTED":
                verdict, message = "block", "Rejected in the Leap360 console"
        return GateResult(verdict in ("allow", "warn"), action_id, res.get("mode") or "enforce", verdict, res.get("wouldBe") or verdict,
                          category=res.get("category", "unknown"), risk=res.get("risk", "medium"), message=message, policy=res.get("policy"))

    def record(self, action_id, ok, duration_ms, result=None, error=None):
        """Reports how the call went, in the background. Only a redacted preview of the result leaves the process."""
        def text_of(v):
            if v is None:
                return None
            s = v if isinstance(v, str) else json.dumps(to_plain(v))
            return redact(s[:500] + ("…" if len(s) > 500 else ""))
        from .privacy import mask_text
        if self.capture == "metadata":
            # No result or error text: only whether it worked, and the type of error
            body = {
                "phase": "post", "id": action_id, "agent_name": self.agent_name, "ok": bool(ok), "duration_ms": int(duration_ms),
                "capture": "metadata", "error": type(error).__name__ if error is not None else None,
            }
        else:
            mask = mask_text if self.capture == "redacted" else (lambda s: s)
            body = {
                "phase": "post", "id": action_id, "agent_name": self.agent_name, "ok": bool(ok), "duration_ms": int(duration_ms),
                "capture": self.capture,
                "result_preview": mask(text_of(result)) if ok else None,
                "error": mask(text_of(f"{type(error).__name__}: {error}")) if error is not None else None,
            }
        pending = self._pending_pre.get(action_id)

        def post():
            if pending is not None:
                pending.wait(10)  # the "after" report never overtakes its "before" report
            try:
                self._post("/v1/actions", body, 10)
            except Exception:
                pass
        self._background(post)

    # ── internals ───────────────────────────────────────────────────────

    def _raise_if_blocked(self, gate, name):
        if not gate.allowed:
            self.log(f"[Leap360] blocked {name} ({gate.category}, {gate.risk}): {gate.message or gate.verdict}")
            raise ActionBlocked(gate, "APPROVAL_REQUIRED" if gate.verdict == "review" else "ACTION_BLOCKED")

    def _no_decision(self, action_id, name, args, nd):
        if nd.kind == "refused":
            return GateResult(False, action_id, "enforce", "block", "block", message=f'Leap360 refused to check "{name}": {nd}', offline=True)
        halted = self._status["halted"]
        if halted:
            return GateResult(False, action_id, "enforce", "block", "block", message=halted["message"], offline=True)
        why = {"unsupported": "this Leap360 API does not support action checks yet (deploy the latest API)",
               "unauthorized": "the Leap360 API key was rejected"}.get(nd.kind, f"Leap360 is unreachable ({nd})")
        if nd.kind not in self._warned:
            self._warned.add(nd.kind)
            self.log(f"[Leap360] {why}; blocking {self.fail_closed_at}-risk calls and above until it is resolved")
        risk = offline_risk(name, args)
        block = RISKS.index(risk) >= RISKS.index(self.fail_closed_at)
        return GateResult(not block, action_id, "enforce", "block" if block else "allow", "block" if block else "allow",
                          risk=risk, message=f"{why[0].upper()}{why[1:]}, and \"{name}\" looks {risk} risk" if block else None, offline=True)

    def _learn(self, res):
        if not isinstance(res, dict):
            return
        if res.get("mode") in ("shadow", "enforce"):
            self._server_mode = res["mode"]
        if res.get("code") in ("GOVERNANCE_HALT", "AGENT_HALT"):
            with self._status_lock:
                self._status = {"halted": {"code": res["code"], "message": res.get("message", "Stopped by your team in Leap360. Do not retry.")}, "at": time.monotonic()}
        if self._warned:
            self._warned.clear()
            self.log("[Leap360] reconnected")

    def _current_status(self):
        with self._status_lock:
            if time.monotonic() - self._status["at"] < self.status_ttl:
                return self._status
        try:
            project = self._get("/v1/projects/default/status")
            agent = self._get(f"/v1/projects/default/agents/{urllib.request.quote(self.agent_name, safe='')}/status?caller=sdk")
            if project and project.get("mode") in ("shadow", "enforce"):
                self._server_mode = project["mode"]
            halted = None
            if project and project.get("status") == "SUSPENDED":
                halted = {"code": "GOVERNANCE_HALT", "message": "Stopped by your team in Leap360 (Stop all is on). Do not retry."}
            elif agent and agent.get("status") == "SUSPENDED":
                halted = {"code": "AGENT_HALT", "message": agent.get("reason") or f'Stopped by your team in Leap360: the agent "{self.agent_name}" is stopped. Do not retry.'}
            elif not project or not agent:
                halted = self._status["halted"]  # a failed read keeps the last known state
            with self._status_lock:
                self._status = {"halted": halted, "at": time.monotonic()}
        except Exception:
            with self._status_lock:
                self._status = {**self._status, "at": time.monotonic()}
        return self._status

    def _wait_for_approval(self, approval_id):
        until = time.monotonic() + self.approval_wait
        while time.monotonic() < until:
            time.sleep(min(2.0, max(0.0, until - time.monotonic())))
            try:
                r = self._get(f"/v1/projects/default/approvals/{urllib.request.quote(approval_id, safe='')}/poll")
                if r and r.get("decision") in ("APPROVED", "REJECTED"):
                    return r["decision"]
            except Exception:
                pass
        return None

    @staticmethod
    def _saved_key():
        path = os.path.expanduser("~/.leap360/config.json")
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f).get("apiKey")
        except Exception:
            return None

    @staticmethod
    def _background(fn):
        threading.Thread(target=fn, daemon=True).start()

    def _get(self, path, timeout=1.5):
        req = urllib.request.Request(f"{self.api_url}{path}", headers={"x-api-key": self.api_key or ""})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode() or "null")
        except urllib.error.HTTPError:
            return None

    def _post(self, path, body, timeout):
        data = json.dumps(to_plain(body)).encode()
        req = urllib.request.Request(f"{self.api_url}{path}", data=data, method="POST",
                                     headers={"Content-Type": "application/json", "x-api-key": self.api_key or ""})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode() or "{}")
        except urllib.error.HTTPError as e:
            raw = e.read().decode(errors="replace")
            try:
                payload = json.loads(raw or "{}")
            except ValueError:
                payload = {}
            if e.code == 403:
                return payload or {"code": "AGENT_HALT", "decision": "block"}
            detail = payload.get("error") or payload.get("message") or ""
            if e.code in (404, 405):
                raise _NoDecision("unsupported", f"HTTP {e.code}")
            if e.code == 401:
                raise _NoDecision("unauthorized", f"HTTP 401 {detail}".strip())
            if 400 <= e.code < 500:
                raise _NoDecision("refused", f"HTTP {e.code} {detail}".strip())
            raise _NoDecision("offline", f"HTTP {e.code}")
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise _NoDecision("offline", str(getattr(e, "reason", e)))
