"""
Leap360 local mode: runs on this device with no cloud, no account and no API key.

Turn it on with LEAP360_LOCAL=1, or Leap360Governor(local=True) / Leap360Tracer(local=True) / Leap360(local=True).

It shares one folder with the TypeScript SDK and CLI (LEAP360_HOME, default ~/.leap360/local), as plain files:
    rules.json      the mode ("enforce" or "watch") and the action rules. Created with the safe defaults.
    state.json      Stop all, and the agents that are stopped
    approvals.json  tool calls held for a person, and their decisions
    activity.jsonl  one line per checked tool call, outcome and LLM call

Manage it with `python -m leap360.local status|stop|resume|approvals|approve|reject|mode|rules|log`
(or `npx leap360 local ...`: same files). Nothing here opens a network connection.

The classifier is a port of the TypeScript one (leap360/src/actions.ts): the tool name, what its arguments would
run, production and wildcard targets, and credentials in the arguments.
"""

import base64
import datetime
import fnmatch
import json
import os
import random
import re
import string
import sys
import threading
import time
import unicodedata

RISKS = ["none", "low", "medium", "high", "critical"]
VERDICT_RANK = {"allow": 0, "warn": 1, "review": 2, "block": 3}
APPROVAL_TTL = 15 * 60  # an approved call may run again for this long, as in the cloud

# The safe defaults the console adds at onboarding (src/console/safeDefaults.ts): keep the lists the same
SAFE_DEFAULT_RULES = [
    {"name": "Block destructive actions", "action": "block", "severity": "critical",
     "match": {"categories": ["db.destructive", "infra.destroy", "k8s.delete", "fs.delete"]}},
    {"name": "Hold payments and refunds", "action": "ask_admin", "severity": "high", "match": {"categories": ["payment"]}},
    {"name": "Hold permission and secret changes", "action": "ask_admin", "severity": "high",
     "match": {"categories": ["iam.change", "secrets.read"]}},
    {"name": "Hold deploys and releases", "action": "ask_admin", "severity": "high",
     "match": {"categories": ["deploy", "release.publish", "infra.apply"]}},
]


def _truthy(v):
    return bool(v) and v.strip().lower() not in ("0", "false", "no", "off", "")


def is_local(url=None):
    """True when this URL (or, with none, LEAP360_LOCAL) means "run on this device" """
    if isinstance(url, str) and url:
        return url == "local" or url.startswith("local:")
    return _truthy(os.environ.get("LEAP360_LOCAL"))


def local_home():
    return os.environ.get("LEAP360_HOME") or os.path.join(os.path.expanduser("~"), ".leap360", "local")


def _rank(risk):
    return RISKS.index(risk) if risk in RISKS else 2


# ─── Classify a tool call (port of classifyAction) ───────────────────────────

I = re.IGNORECASE
_COMMAND_RULES = [
    ("shell.exec", "critical", re.compile(r"\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b", I), "pipes a download straight into a shell"),
    ("shell.exec", "critical", re.compile(r"\b(?:(?:ba|z)?sh|source|\.)\s+<\(\s*(?:curl|wget)\b|\beval\s+[\"']?\$\(\s*(?:curl|wget)\b|\b(?:python3?|node|perl|ruby)\s+-[ce]\s+[\"']?\$\(\s*(?:curl|wget)\b", I), "runs a download straight into a shell"),
    ("shell.exec", "critical", re.compile(r"\bbase64\s+(?:-d|--decode|-D)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b|\bxxd\s+-r\b[^\n]*\|\s*(?:ba|z)?sh\b", I), "runs an encoded command"),
    ("shell.exec", "critical", re.compile(r"(?:\b(?:(?:ba|z)?sh|eval|exec|source|\.)\s+(?:-c\s+)?[\"']?)(?:\$\(|`)[^)`\n]*\b(?:base64\s+(?:-d|--decode|-D)|xxd\s+-r|openssl\s+(?:base64|enc)\s+-d)\b", I), "runs an encoded command"),
    ("fs.delete", "critical", re.compile(r"\brm\s+-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)\b|\bRemove-Item\b[^\n]*-Recurse", I), "recursive force delete"),
    ("fs.delete", "critical", re.compile(r"\b(?:mkfs(?:\.\w+)?|dd\s+if=|shred|format\s+[a-z]:)", I), "wipes a disk or filesystem"),
    ("k8s.delete", "critical", re.compile(r"\b(?:kubectl|oc)\s+delete\b|\bhelm\s+(?:uninstall|delete)\b", I), "deletes Kubernetes resources"),
    ("k8s.scale", "high", re.compile(r"\b(?:kubectl|oc)\s+(?:scale|drain|cordon|rollout\s+(?:restart|undo))\b", I), "changes Kubernetes capacity or rollout"),
    ("k8s.exec", "high", re.compile(r"\b(?:kubectl|oc)\s+exec\b", I), "opens a shell inside a running container"),
    ("infra.destroy", "critical", re.compile(r"\b(?:terraform|tofu)\s+destroy\b|\b(?:terraform|tofu)\s+apply\b[^\n]*\s-destroy\b|\bpulumi\s+destroy\b|\baws\s+cloudformation\s+delete-stack\b", I), "destroys infrastructure"),
    ("infra.apply", "high", re.compile(r"\b(?:terraform|tofu)\s+apply\b|\bpulumi\s+up\b|\bcdk\s+deploy\b", I), "applies infrastructure changes"),
    ("iam.change", "critical", re.compile(r"\baws\s+iam\s+(?:create|attach|put|update|delete|add)|\bgcloud\b[^\n]*\badd-iam-policy-binding\b|\baz\s+role\s+assignment\s+create\b", I), "changes cloud permissions"),
    ("git.push", "critical", re.compile(r"\bgit\s+push\b[^\n]*(?:--force\b|-f\b|--force-with-lease\b)", I), "force-pushes and can rewrite history"),
    ("git.push", "high", re.compile(r"\bgit\s+push\b", I), "pushes code"),
    ("git.merge", "high", re.compile(r"\bgh\s+pr\s+merge\b|\bgit\s+merge\b", I), "merges code"),
    ("release.publish", "high", re.compile(r"\b(?:npm|pnpm|yarn)\s+publish\b|\bgh\s+release\s+create\b|\bdocker\s+push\b|\btwine\s+upload\b", I), "publishes a release"),
    ("db.destructive", "critical", re.compile(r"\b(?:drop|truncate)\s+(?:table|database|schema|index)\b", I), "drops or truncates data"),
    ("db.destructive", "critical", re.compile(r"\btruncate\s+(?:only\s+)?[\w.\"`\[\]]+\s*(?:;|,|$|\s+(?:cascade|restart|continue)\b)", I | re.M), "drops or truncates data"),
    ("db.destructive", "critical", re.compile(r"\bdelete\s+from\s+[\w.\"`\[\]]+\s*(?:;|$)", I | re.M), "DELETE with no WHERE clause"),
    ("db.destructive", "critical", re.compile(r"\bdb\.\w+\.(?:drop|deleteMany\(\s*\{\s*\}\s*\))|\bFLUSHALL\b|\bFLUSHDB\b", I), "wipes a collection or cache"),
    ("shell.exec", "high", re.compile(r"\b(?:chmod\s+(?:-R\s+)?777|chown\s+-R|sudo\s|systemctl\s+(?:stop|disable)|iptables\s+-F)\b", I), "changes system permissions or services"),
]

_SQL_WRITE = re.compile(r"\b(?:insert\s+into|update\s+\w+\s+set|delete\s+from|alter\s+table|create\s+table|grant\s|revoke\s)", I)

_NAME_RULES = [
    ("db.write", "medium", re.compile(r"(?:execute|exec|run)[_.\-]?(?:sql|query|statement)", I), "runs database statements"),
    ("shell.exec", "high", re.compile(r"(?:^|[_.\-\s])(?:shell|bash|zsh|powershell|terminal|exec(?:ute)?_?(?:command|cmd|shell|code)?|run_?(?:command|cmd|shell|script|code)|subprocess|spawn|eval)(?:$|[_.\-\s])", I), "runs arbitrary commands"),
    ("k8s.delete", "critical", re.compile(r"(?:delete|remove|destroy|uninstall)[_.\-]?(?:namespace|pod|deployment|cluster|node|service|statefulset|daemonset|helm|release|k8s|kube)", I), "deletes Kubernetes resources"),
    ("k8s.scale", "high", re.compile(r"(?:scale|drain|cordon|restart)[_.\-]?(?:deployment|statefulset|replica|node|pod|cluster)", I), "changes Kubernetes capacity"),
    ("infra.destroy", "critical", re.compile(r"(?:terraform|tofu|pulumi|stack)[_.\-]?destroy|destroy[_.\-]?(?:stack|infra|environment)", I), "destroys infrastructure"),
    ("infra.apply", "high", re.compile(r"(?:terraform|tofu|pulumi)[_.\-]?(?:apply|up)|apply[_.\-]?(?:plan|terraform|infra)", I), "applies infrastructure changes"),
    ("iam.change", "critical", re.compile(r"(?:create|attach|put|update|delete|add|grant|revoke)[_.\-]?(?:iam|role|policy|permission|access[_.\-]?key|user[_.\-]?policy|binding)|(?:iam|role)[_.\-]?(?:create|attach|grant|update)", I), "changes permissions"),
    ("git.merge", "high", re.compile(r"merge[_.\-]?(?:pull[_.\-]?request|pr|branch)|(?:pull[_.\-]?request|pr)[_.\-]?merge", I), "merges code"),
    ("git.push", "high", re.compile(r"(?:push[_.\-]?(?:files?|commit|branch|code)|create[_.\-]?or[_.\-]?update[_.\-]?file|delete[_.\-]?(?:branch|file[_.\-]?from[_.\-]?repo)|force[_.\-]?push)", I), "writes to a repository"),
    ("release.publish", "high", re.compile(r"(?:create|publish)[_.\-]?(?:release|tag|package)|publish[_.\-]?(?:npm|pypi|image)", I), "publishes a release"),
    ("deploy", "high", re.compile(r"(?:^|[_.\-])(?:deploy|rollout|promote|rollback)(?:$|[_.\-])", I), "deploys or rolls back"),
    ("payment", "high", re.compile(r"(?:refund|payment|charge|payout|transfer[_.\-]?(?:funds|money)|send[_.\-]?money|invoice|subscription[_.\-]?cancel|issue[_.\-]?credit)", I), "moves money"),
    ("secrets.read", "high", re.compile(r"(?:get|read|fetch|list|export)[_.\-]?(?:secret|credential|password|token|api[_.\-]?key|env(?:ironment)?[_.\-]?var)|vault|secrets?[_.\-]?manager", I), "reads secrets"),
    ("db.destructive", "critical", re.compile(r"(?:drop|truncate|purge|wipe)[_.\-]?(?:table|database|db|collection|schema|index|cache)", I), "drops data"),
    ("db.write", "medium", re.compile(r"(?:execute|run)[_.\-]?(?:sql|query)|(?:sql|db|database)[_.\-]?(?:query|execute|write|update)|(?:insert|update|upsert|delete)[_.\-]?(?:row|record|document|item)s?", I), "writes to a database"),
    ("fs.delete", "high", re.compile(r"(?:delete|remove|unlink|rm)[_.\-]?(?:file|dir|directory|folder|path)", I), "deletes files"),
    ("fs.write", "medium", re.compile(r"(?:write|create|edit|save|overwrite|append|move|rename)[_.\-]?(?:file|dir|directory|folder)|(?:file|fs)[_.\-]?(?:write|edit)|str_replace|apply[_.\-]?patch", I), "writes files"),
    ("message.send", "medium", re.compile(r"(?:send|post|reply)[_.\-]?(?:email|mail|message|sms|text|slack|tweet|notification|dm)|(?:email|slack|sms)[_.\-]?send", I), "sends a message to people"),
    ("network.request", "medium", re.compile(r"(?:http|fetch|request|curl|browse|navigate|webhook|download|upload)(?:$|[_.\-])|(?:^|[_.\-])(?:get|fetch|open)[_.\-]?url", I), "makes a network request"),
    ("read", "low", re.compile(r"^(?:[\w-]+[_.\-])?(?:get|list|read|search|find|describe|view|show|query|lookup|fetch|retrieve|count|check|inspect|status)(?:$|[_.\-A-Z])", I), "reads data"),
]

_DESTRUCTIVE_VERB = re.compile(r"(?:^|[_.\-])(?:delete|remove|destroy|drop|purge|terminate|wipe|kill|revoke|disable|reset|cancel)(?:$|[_.\-A-Z])", I)
_EXEC_KEYS = re.compile(r"^(?:command|cmd|commands|script|shell|exec|run|sql|statement|stmt|argv)$", I)
_LOOSE_KEYS = re.compile(r"^(?:args|input|query|code|line)$", I)
_SECRET_KEYS = re.compile(r"(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|credential)", I)
_DESTRUCTIVE_CATEGORIES = {"fs.delete", "db.destructive", "k8s.delete", "k8s.scale", "infra.destroy", "iam.change", "git.push", "shell.exec"}
_ENV_KEYS = re.compile(r"^(?:namespace|ns|env|environment|stage|cluster|context|kube_?context|branch|base|target|account|project|region|workspace|database|db|host|bucket)$", I)
_PROD_VALUE = re.compile(r"^(?:prod|production|prd|live|main|master|release)$|(?:^|[-_./:])(?:prod|production|prd)(?:$|[-_./:])", I)
_WILDCARD_VALUE = re.compile(r"^(?:\*|all|--all|-A|--all-namespaces|%|\.\*)$", I)
_READ_COMMAND = re.compile(r"^(?:(?:kubectl|oc)\s+(?:get|describe|logs|top|explain|version|api-resources)\b|git\s+(?:status|log|diff|show|branch|remote|rev-parse)\b|(?:ls|cat|head|tail|grep|rg|find|pwd|echo|wc|which|whoami|date|env)\b|aws\s+\S+\s+(?:describe|list|get)-|(?:terraform|tofu)\s+(?:plan|show|output|validate|version)\b|(?:npm|pnpm|yarn)\s+(?:test|ls|outdated|run\s+(?:test|lint|build))\b|(?:pytest|go\s+test|cargo\s+test)\b|docker\s+(?:ps|images|logs|inspect)\b|helm\s+(?:list|status|get)\b)", I)
_TARGET_FLAG = re.compile(r"(?:^|\s)(--context|--kube-context|--namespace|-n|--env|--environment|--stage|--cluster|--profile|--workspace|--project|--account|--target|-var\s+env)[=\s]+[\"']?([^\s\"']+)", I)


def _unconfuse(value):
    """Full-width and other look-alike characters folded to plain text; invisible format characters dropped"""
    if value.isascii():
        return value
    v = unicodedata.normalize("NFKC", value[:65536])
    return "".join(c for c in v if unicodedata.category(c) != "Cf")


def _decode_hidden(value):
    out = []
    for m in re.finditer(r"[A-Za-z0-9+/_-]{16,8192}={0,2}", value[:65536]):
        if len(out) >= 5:
            break
        s = m.group(0).replace("-", "+").replace("_", "/").rstrip("=")
        try:
            text = base64.b64decode(s + "=" * (-len(s) % 4)).decode("utf-8", "replace")
        except Exception:
            continue
        printable = sum(1 for c in text if c in string.printable)
        if len(text) >= 8 and printable / len(text) > 0.95 and re.search(r"[a-z]{3}", text, I) and text != m.group(0):
            out.append(text)
    return out


def _flatten(v, path, out, depth=0):
    if depth > 6 or len(out) > 200 or v is None:
        return
    key = path.split(".")[-1]
    if isinstance(v, str):
        out.append((path, key, v[:65536]))
    elif isinstance(v, (bool, int, float)):
        out.append((path, key, str(v)))
    elif isinstance(v, (list, tuple)):
        if all(isinstance(x, str) for x in v):
            out.append((path, key, " ".join(v)))
        for i, x in enumerate(v):
            _flatten(x, f"{path}[{i}]", out, depth + 1)
    elif isinstance(v, dict):
        for k, x in v.items():
            _flatten(x, f"{path}.{k}", out, depth + 1)


def _disguises(args, strings):
    out = []
    for path, key, value in strings:
        plain = _unconfuse(value)
        if plain != value:
            out.append((f"{path} (normalized)", key, plain))
        for d in _decode_hidden(value):
            out.append((f"{path} (decoded)", key, d))
        if "/*" in value or "--" in value:
            clean = re.sub(r"/\*[\s\S]*?\*/", " ", value)
            if re.match(r"^(?:query|sql|statement|stmt)$", key, I):
                clean = re.sub(r"--[^\n]*", " ", clean)
            clean = re.sub(r"\s+", " ", clean).strip()
            if clean != re.sub(r"\s+", " ", value).strip():
                out.append((path, key, clean))
    top = list(args.values()) if isinstance(args, dict) else []
    parts = []
    for v in top:
        if isinstance(v, str):
            parts.append(v)
        elif isinstance(v, list) and all(isinstance(x, str) for x in v):
            parts.extend(v)
    if len(top) > 1 and len(parts) > 1:
        out.append(("args", "args", " ".join(parts)[:4000]))
    return out


def classify(name, args, hints=None):
    """Category, risk, reasons and findings for one tool call. Pure: no I/O."""
    from .governor import _SECRET_PATTERNS  # credential detectors shared with the redactor
    hints = hints or {}
    state = {"category": "unknown", "risk": "medium", "decided": False}
    reasons, findings = [], []

    def set_(c, r, why):
        more_specific = _rank(r) == _rank(state["risk"]) and state["category"] == "shell.exec" and c != "shell.exec"
        if not state["decided"] or _rank(r) > _rank(state["risk"]) or more_specific:
            state["category"], state["risk"] = c, r
        state["decided"] = True
        if why not in reasons:
            reasons.append(why)

    n = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", _unconfuse(name))
    for c, r, rx, why in _NAME_RULES:
        if rx.search(n):
            set_(c, r, f"tool name: {why}")
            break
    if not state["decided"] and _DESTRUCTIVE_VERB.search(n):
        set_("unknown", "high", "tool name uses a destructive verb")

    strings = []
    _flatten(args, "args", strings)
    strings += _disguises(args, strings)
    runs_things = not state["decided"] or state["category"] in ("shell.exec", "unknown", "db.write")
    command_like = [s for s in strings if _EXEC_KEYS.match(s[1]) or (runs_things and (_LOOSE_KEYS.match(s[1]) or len(s[2]) > 12))]
    command_hit = False
    for path, key, value in command_like:
        for c, r, rx, why in _COMMAND_RULES:
            if rx.search(value):
                command_hit = True
                set_(c, r, f"{path}: {why}")
                if "download straight into a shell" in why:
                    findings.append({"kind": "remote-code", "detail": "Runs code downloaded from the internet", "severity": "critical", "path": path})
        if re.match(r"^(?:query|sql|statement|stmt)$", key, I) and _SQL_WRITE.search(value) and _rank(state["risk"]) < _rank("medium"):
            set_("db.write", "medium", f"{path}: SQL that writes")

    if state["category"] == "shell.exec" and not command_hit:
        cmds = [s[2].strip() for s in strings if _EXEC_KEYS.match(s[1])]
        if cmds and all(_READ_COMMAND.match(v) and not re.search(r"[;&|`>]|\$\(", v) for v in cmds):
            state["category"], state["risk"] = "read", "low"
            reasons.append("read-only command")

    category = state["category"]
    destructive = category in _DESTRUCTIVE_CATEGORIES or bool(_DESTRUCTIVE_VERB.search(n))
    if destructive or category not in ("read", "unknown"):
        prod = next(((p, k, v) for p, k, v in strings if _ENV_KEYS.match(k) and _PROD_VALUE.search(v.strip())), None)
        if not prod:
            for p, _k, v in command_like:
                for m in _TARGET_FLAG.finditer(v):
                    if _PROD_VALUE.search(m.group(2)):
                        prod = (p, m.group(1), m.group(2))
                        break
                if prod:
                    break
        if prod:
            findings.append({"kind": "prod-target", "detail": f"Targets production ({prod[1]}={prod[2][:40]})", "severity": "high", "path": prod[0]})
            state["risk"] = RISKS[min(4, _rank(state["risk"]) + 1)]
            reasons.append("targets production")
    if destructive:
        wild = next(((p, k, v) for p, k, v in strings if _WILDCARD_VALUE.match(v.strip()) or re.search(r"\s(?:--all|-A|--all-namespaces)\b", v)), None)
        if wild:
            findings.append({"kind": "wildcard", "detail": f"Applies to everything ({wild[1]}={wild[2][:40]})", "severity": "critical", "path": wild[0]})
            state["risk"] = "critical"
            reasons.append("applies to everything at once")

    for path, key, value in strings:
        if _SECRET_KEYS.search(key) and len(value) >= 8 and not value.startswith("[REDACTED"):
            findings.append({"kind": "secret", "detail": f'Credential passed as "{key}"', "severity": "high", "path": path})
        elif any(rx.search(value) for rx, _l in _SECRET_PATTERNS):
            findings.append({"kind": "secret", "detail": "Credential in the arguments", "severity": "high", "path": path})
    if any(f["kind"] == "secret" for f in findings):
        state["risk"] = RISKS[max(_rank(state["risk"]), _rank("high"))]
        reasons.append("arguments contain a credential")
        if category == "network.request":
            findings.append({"kind": "exfil", "detail": "Sends sensitive data over the network", "severity": "critical"})
            state["risk"] = "critical"

    if hints.get("destructiveHint") is True and _rank(state["risk"]) < _rank("high"):
        state["risk"] = "high"
        reasons.append("tool declares itself destructive")
    if hints.get("readOnlyHint") is True and not state["decided"] and not findings:
        state["category"], state["risk"] = "read", "low"
        reasons.append("tool declares itself read-only")

    if not state["decided"] and not reasons:
        reasons.append("unrecognised tool")
    return {"name": name, "args": args, "category": state["category"], "risk": state["risk"], "reasons": reasons, "findings": findings}


# ─── Decide with action rules (port of decideAction) ─────────────────────────

def _safe_pattern(p):
    if not isinstance(p, str) or len(p) > 200:
        return False
    try:
        re.compile(p)
    except re.error:
        return False
    return not re.search(r"\([^)]*[*+][^)]*\)[*+{]", p)


def matches(policy, action, agent=None):
    m = policy.get("match") or {}
    if not m:
        return False
    if any(e.get("tool") == action["name"] and (not e.get("agent") or e.get("agent") == agent) for e in policy.get("exceptions") or []):
        return False
    hit = False
    if m.get("categories"):
        hit = True
        if action["category"] not in m["categories"]:
            return False
    if m.get("tools"):
        hit = True
        if not any(fnmatch.fnmatch(action["name"].lower(), g.lower()) for g in m["tools"]):
            return False
    if m.get("minRisk"):
        hit = True
        if _rank(action["risk"]) < _rank(m["minRisk"]):
            return False
    if m.get("findings"):
        hit = True
        if not any(f["kind"] in m["findings"] for f in action["findings"]):
            return False
    if m.get("argPattern"):
        hit = True
        if not _safe_pattern(m["argPattern"]):
            return False
        if not re.search(m["argPattern"], json.dumps(action.get("args") or {}, default=str)[:4000], I):
            return False
    return hit


def _verdict(action):
    return {"block": "block", "ask_admin": "review", "review": "review", "hold": "review", "warn": "warn"}.get(action, "warn")


def decide(action, policies, agent=None):
    """The strictest verdict among the action rules that match. No match means allow."""
    best = {"verdict": "allow", "policy": None, "reason": None}
    for p in policies:
        if p.get("kind", "action") != "action":
            continue
        assigned = p.get("assignedAgents") or []
        if assigned and agent not in assigned:
            continue
        if not matches(p, action, agent):
            continue
        v = _verdict(p.get("action"))
        if VERDICT_RANK[v] > VERDICT_RANK[best["verdict"]]:
            best = {"verdict": v, "policy": {"policyId": p.get("policyId"), "name": p.get("name")}, "reason": f'matched policy "{p.get("name")}"'}
    return best


# ─── The files ───────────────────────────────────────────────────────────────

def _norm_mode(m):
    return "shadow" if m in ("shadow", "watch") else "enforce" if m in ("enforce", "block") else None


def _default_rules():
    return {"mode": "enforce", "capture": "redacted",
            "policies": [{"policyId": f"default-{i + 1}", "kind": "action", **r} for i, r in enumerate(SAFE_DEFAULT_RULES)]}


class LocalStore:
    """Rules, Stop all, approvals and the activity log as files in one folder. Same format as the TypeScript SDK."""

    def __init__(self, directory=None):
        self.dir = directory or local_home()
        self._rules_cache = None
        self._lock = threading.Lock()

    def _file(self, name):
        return os.path.join(self.dir, name)

    def _read(self, name, fallback):
        try:
            with open(self._file(name), "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return fallback

    def _write(self, name, value):
        os.makedirs(self.dir, exist_ok=True)
        tmp = self._file(f"{name}.{os.getpid()}.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(value, f, indent=2)
            f.write("\n")
        os.replace(tmp, self._file(name))
        if name == "rules.json":
            self._rules_cache = None

    def init(self):
        if os.path.exists(self._file("rules.json")):
            return False
        self._write("rules.json", _default_rules())
        return True

    def rules(self):
        try:
            mtime = os.stat(self._file("rules.json")).st_mtime_ns
        except OSError:
            try:
                self.init()
                mtime = os.stat(self._file("rules.json")).st_mtime_ns
            except OSError:
                return self._rules_cache[1] if self._rules_cache else _default_rules()
        if self._rules_cache and self._rules_cache[0] == mtime:
            return self._rules_cache[1]
        raw = self._read("rules.json", None)
        if not isinstance(raw, dict):
            return self._rules_cache[1] if self._rules_cache else _default_rules()
        policies = [p for p in raw.get("policies") or [] if isinstance(p, dict) and isinstance(p.get("name"), str)]
        rules = {
            "mode": _norm_mode(raw.get("mode")) or "enforce",
            "capture": raw.get("capture") if raw.get("capture") in ("metadata", "redacted", "full") else "redacted",
            "policies": [{"policyId": p.get("policyId") or f"rule-{i + 1}", **p, "kind": p.get("kind", "action")} for i, p in enumerate(policies)],
        }
        self._rules_cache = (mtime, rules)
        return rules

    def mode(self):
        return self.rules()["mode"]

    def set_mode(self, mode):
        m = _norm_mode(mode)
        if not m:
            raise ValueError(f'mode must be "enforce" or "watch" (got "{mode}")')
        self._write("rules.json", {**self.rules(), "mode": m})
        return m

    def policies(self):
        return self.rules()["policies"]

    def add_policy(self, policy):
        r = self.rules()
        p = {"policyId": f"rule-{int(time.time() * 1000):x}", "kind": "action", **policy}
        self._write("rules.json", {**r, "policies": r["policies"] + [p]})
        return p

    # Stop all

    def status(self):
        s = self._read("state.json", {})
        return {"stopped": s.get("stopped") is True, "stoppedAgents": [a for a in s.get("stoppedAgents") or [] if isinstance(a, str)]}

    def halted(self, agent=None):
        s = self.status()
        if s["stopped"]:
            return {"code": "GOVERNANCE_HALT", "message": "Stopped on this device (Stop all is on). Do not retry."}
        if agent and agent in s["stoppedAgents"]:
            return {"code": "AGENT_HALT", "message": f'Stopped on this device: the agent "{agent}" is stopped. Do not retry.'}
        return None

    def stop(self, agent=None):
        s = self.status()
        if agent:
            if agent not in s["stoppedAgents"]:
                s["stoppedAgents"].append(agent)
        else:
            s["stopped"] = True
        self._write("state.json", s)

    def resume(self, agent=None):
        s = self.status()
        if agent:
            s["stoppedAgents"] = [a for a in s["stoppedAgents"] if a != agent]
        else:
            s = {"stopped": False, "stoppedAgents": []}
        self._write("state.json", s)

    # Approvals

    def approvals(self):
        a = self._read("approvals.json", [])
        return a if isinstance(a, list) else []

    def hold(self, agent, tool, category, risk, policy=None, args_key=None):
        with self._lock:
            items = self.approvals()
            for a in items:
                if a.get("status") == "PENDING" and a.get("agent") == agent and a.get("tool") == tool and a.get("argsKey") == args_key:
                    return a
            a = {"id": "".join(random.choices(string.ascii_lowercase + string.digits, k=6)),
                 "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
                 "status": "PENDING", "agent": agent, "tool": tool, "category": category, "risk": risk, "policy": policy, "argsKey": args_key}
            self._write("approvals.json", (items + [a])[-500:])
            return a

    def decide(self, approval_id, decision):
        items = self.approvals()
        for a in items:
            if a.get("id") == approval_id:
                a["status"] = decision
                a["decidedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
                self._write("approvals.json", items)
                return a
        return None

    def decision(self, approval_id):
        return next((a.get("status") for a in self.approvals() if a.get("id") == approval_id), None)

    def is_approved(self, agent, tool, args_key):
        now = time.time()
        for a in self.approvals():
            if a.get("status") == "APPROVED" and a.get("agent") == agent and a.get("tool") == tool and a.get("argsKey") == args_key and a.get("decidedAt"):
                try:
                    t = datetime.datetime.fromisoformat(a["decidedAt"].replace("Z", "+00:00")).timestamp()
                except ValueError:
                    continue
                if now - t < APPROVAL_TTL:
                    return True
        return False

    # Activity log

    def log(self, entry):
        try:
            os.makedirs(self.dir, exist_ok=True)
            line = json.dumps({"time": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"), **entry}, default=str)
            with self._lock, open(self._file("activity.jsonl"), "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except Exception:
            pass  # the log must never break a call

    def activity(self, limit=50):
        try:
            with open(self._file("activity.jsonl"), "r", encoding="utf-8") as f:
                lines = f.read().splitlines()[-limit:]
        except OSError:
            return []
        out = []
        for line in lines:
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
        return out

    def request(self, method, path, body=None, params=None):
        """Answers the Leap360 client API on this device, for the parts that make sense without the cloud"""
        parts = [p for p in path.split("?")[0].split("/") if p]
        resource = parts[3] if len(parts) > 3 else None
        ident = parts[4] if len(parts) > 4 else None
        sub = parts[5] if len(parts) > 5 else None
        body = body or {}
        if parts[:2] == ["v1", "traces"] and method == "POST":
            self.log({"kind": "trace", **body})
            return {"status": "recorded", "local": True}
        if resource == "status":
            if method == "POST":
                self.stop() if body.get("status") == "SUSPENDED" else self.resume() if body.get("status") == "ACTIVE" else None
            return {"status": "SUSPENDED" if self.halted() else "ACTIVE", "mode": self.mode(), "local": True}
        if resource == "agents" and ident and sub == "status":
            if method == "POST":
                self.stop(ident) if body.get("status") == "SUSPENDED" else self.resume(ident) if body.get("status") == "ACTIVE" else None
            return {"agentId": ident, "status": "SUSPENDED" if self.halted(ident) else "ACTIVE"}
        if resource == "policies":
            if method == "POST":
                return self.add_policy(body)
            return {"policies": self.policies()}
        if resource == "mode":
            if method == "POST":
                try:
                    self.set_mode(body.get("mode"))
                except ValueError as e:
                    return {"error": str(e), "http_status": 400}
            return {"mode": self.mode(), "local": True}
        if resource == "approvals":
            if not ident:
                return {"approvals": [a for a in self.approvals() if a.get("status") == "PENDING"]}
            if sub == "decision" and method == "POST":
                d = str(body.get("decision", "")).upper()
                if d not in ("APPROVED", "REJECTED"):
                    return {"error": "decision must be APPROVED or REJECTED", "http_status": 400}
                return self.decide(ident, d) or {"error": "No such approval", "http_status": 404}
        if resource == "actions" and method == "GET":
            limit = int((params or {}).get("limit") or 100)
            return {"actions": [e for e in self.activity(limit * 3) if e.get("phase") == "pre"][-limit:]}
        if resource == "traces" and method == "GET":
            limit = int((params or {}).get("limit") or 50)
            return {"traces": [e for e in self.activity(limit * 3) if e.get("kind") == "trace"][-limit:]}
        return {"error": f"{method} {path} needs the Leap360 cloud; it is not available in local mode", "code": "LOCAL_UNSUPPORTED", "http_status": 501}


_shared = {}


def local_store():
    """One store per folder for the whole process"""
    d = local_home()
    if d not in _shared:
        _shared[d] = LocalStore(d)
    return _shared[d]


# ─── python -m leap360.local ─────────────────────────────────────────────────

def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    cmd = argv.pop(0) if argv else "status"
    s = local_store()
    s.init()
    if cmd == "status":
        st = s.status()
        held = [a for a in s.approvals() if a.get("status") == "PENDING"]
        print(f"\n   Folder      {s.dir}")
        print(f"   Mode        {'watch (nothing is blocked; the log shows what would be)' if s.mode() == 'shadow' else 'enforce (rules apply)'}")
        print(f"   Stop all    {'ON: every agent is stopped' if st['stopped'] else 'off'}{'   stopped agents: ' + ', '.join(st['stoppedAgents']) if st['stoppedAgents'] else ''}")
        print(f"   Rules       {len(s.policies())} (rules.json)")
        print(f"   Held calls  {len(held)}\n")
    elif cmd == "stop":
        s.stop(argv[0] if argv else None)
        print(f"\n   {argv[0]} is stopped.\n" if argv else "\n   Stop all is on: every agent on this device is stopped.\n")
    elif cmd == "resume":
        s.resume(argv[0] if argv else None)
        print(f"\n   {argv[0]} is running again.\n" if argv else "\n   Stop all is off. Every agent is running.\n")
    elif cmd == "mode" and argv:
        try:
            m = s.set_mode(argv[0])
        except ValueError as e:
            print(f"\n   {e}\n")
            return 1
        print(f"\n   Mode is now {'watch' if m == 'shadow' else 'enforce'}.\n")
    elif cmd == "rules":
        for p in s.policies():
            print(f"   {'hold' if p.get('action') == 'ask_admin' else p.get('action'):<6} {p.get('name')}  {json.dumps(p.get('match') or {})}")
    elif cmd == "approvals":
        held = [a for a in s.approvals() if a.get("status") == "PENDING"]
        if not held:
            print("\n   Nothing is waiting for approval.\n")
        for a in held:
            print(f"   {a['id']}  {a['createdAt'][:19].replace('T', ' ')}  {a['agent']}  {a['tool']}  ({a['category']}, {a['risk']})")
    elif cmd in ("approve", "reject") and argv:
        a = s.decide(argv[0], "APPROVED" if cmd == "approve" else "REJECTED")
        if not a:
            print(f"\n   No held call with id {argv[0]}.\n")
            return 1
        print(f"\n   {'Approved' if cmd == 'approve' else 'Rejected'}: {a['tool']} for {a['agent']}.\n")
    elif cmd == "log":
        for e in s.activity(int(argv[0]) if argv else 20):
            print(json.dumps(e))
    else:
        print("usage: python -m leap360.local [status | stop [agent] | resume [agent] | mode watch|enforce | rules | approvals | approve <id> | reject <id> | log [n]]")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
