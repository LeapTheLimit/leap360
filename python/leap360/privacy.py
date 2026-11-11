"""Leap360 privacy (issue #50): what leaves your process.

Three levels, per tracer or governor, also set by LEAP360_CAPTURE:

  metadata  (default) model name, token counts, timings, the tools offered, and for tool calls their name and
            argument keys and types. No prompts, replies, results or error messages are sent.
            Tool-call arguments are sent with the check so Leap360 can classify the call; the API keeps only
            their keys and types (evaluated, never stored). Message rules need text, so they do not run.
  redacted  text and values with credentials, emails, card numbers, SSNs and phone numbers masked here.
  full      everything, credentials still masked. For debugging.
"""
import json
import os
import re

LEVELS = ("metadata", "redacted", "full")


def capture_level(value=None):
    """The level from the argument, else LEAP360_CAPTURE, else 'metadata'. Anything unknown is 'metadata'."""
    v = value if value is not None else os.environ.get("LEAP360_CAPTURE")
    v = str(v).strip().lower() if v is not None else ""
    return v if v in ("redacted", "full") else "metadata"


def shape_of(value, _depth=0):
    """Keys and types, never values: {"amount": "number", "to": "string", "items": "array(3)"}"""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, (list, tuple, set)):
        return f"array({len(value)})"
    if isinstance(value, dict):
        if _depth >= 4:
            return "object"
        out = {}
        for i, (k, v) in enumerate(value.items()):
            if i >= 50:
                out["…"] = f"{len(value) - 50} more keys"
                break
            out[str(k)[:100]] = shape_of(v, _depth + 1)
        return out
    return "object"


def _luhn(digits):
    total, alt = 0, False
    for ch in reversed(digits):
        d = int(ch)
        if alt:
            d *= 2
            if d > 9:
                d -= 9
        total += d
        alt = not alt
    return total % 10 == 0


_CARD = re.compile(r"\b(?:\d[ -]?){13,19}\b")
_SSN = re.compile(r"\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(\d{4})\b")
_EMAIL = re.compile(r"\b([A-Za-z0-9])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b")
_PHONE = re.compile(r"(?<![\w.])(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?)?\d{2,4}[ .-]\d{3,4}[ .-]?\d{2,4}(?!\w|\.\d)")


def _mask_card(m):
    digits = re.sub(r"\D", "", m.group(0))
    return f"[CARD •••• {digits[-4:]}]" if _luhn(digits) else m.group(0)


def _mask_phone(m):
    digits = re.sub(r"\D", "", m.group(0))
    if len(digits) < 9 or len(digits) > 15 or re.match(r"^\d{4}-\d{2}-\d{2}", m.group(0)):
        return m.group(0)
    return f"[PHONE ••{digits[-2:]}]"


def mask_text(text):
    """Credentials and personal details masked, the same way the JavaScript SDK and the API mask them"""
    from .governor import redact  # credentials
    if not isinstance(text, str):
        return text
    text = redact(text)
    text = _CARD.sub(_mask_card, text)
    text = _SSN.sub(lambda m: f"[SSN •••-••-{m.group(1)}]", text)
    text = _EMAIL.sub(lambda m: f"{m.group(1)}•••@{m.group(2)}", text)
    return _PHONE.sub(_mask_phone, text)


def redact_deep(value, text=mask_text, _depth=0):
    if _depth > 12 or value is None:
        return value
    if isinstance(value, str):
        return text(value)
    if isinstance(value, (list, tuple)):
        return [redact_deep(v, text, _depth + 1) for v in value]
    if isinstance(value, dict):
        return {k: redact_deep(v, text, _depth + 1) for k, v in value.items()}
    return value


def captured(level, value):
    """The content to send at this level: None at 'metadata', masked at 'redacted', credentials masked at 'full'"""
    from .governor import redact
    if value is None or level == "metadata":
        return None
    if level == "redacted":
        return redact_deep(value)
    return redact_deep(value, redact)


def tool_definitions(request):
    """The tools a request offered the model: names and descriptions (written by the developer, not end users)"""
    if not isinstance(request, dict):
        return []
    out, seen = [], set()
    for t in request.get("tools") or []:
        if not isinstance(t, dict):
            continue
        fn = t.get("function") if isinstance(t.get("function"), dict) else t.get("toolSpec") if isinstance(t.get("toolSpec"), dict) else t
        name, desc = fn.get("name"), fn.get("description")
        if isinstance(name, str) and name and name not in seen and len(out) < 200:
            seen.add(name)
            out.append({"type": "function", "name": name, **({"description": desc[:200]} if isinstance(desc, str) and desc else {})})
    return out


def tool_calls(response):
    """The tool calls a model asked for, from OpenAI or Anthropic shaped responses (dicts)"""
    calls = []
    if not isinstance(response, dict):
        return calls
    for ch in response.get("choices") or []:
        msg = (ch or {}).get("message") or {}
        for tc in msg.get("tool_calls") or []:
            fn = (tc or {}).get("function") or {}
            args = fn.get("arguments")
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except ValueError:
                    args = {"value": args}
            if isinstance(fn.get("name"), str):
                calls.append({"name": fn["name"], "args": args if isinstance(args, dict) else {"value": args}})
    for block in response.get("content") or []:
        if isinstance(block, dict) and block.get("type") == "tool_use" and isinstance(block.get("name"), str):
            inp = block.get("input")
            calls.append({"name": block["name"], "args": inp if isinstance(inp, dict) else {"value": inp}})
    return calls[:50]


def trace_at_capture(payload, level):
    """The trace payload at this level. At 'metadata' no prompt or reply text is sent."""
    from .governor import redact
    if level == "full":
        return {**payload, "capture": level, "request": redact_deep(payload.get("request"), redact), "response": redact_deep(payload.get("response"), redact)}
    if level == "redacted":
        return {**payload, "capture": level, "request": redact_deep(payload.get("request")), "response": redact_deep(payload.get("response")), "error": mask_text(payload.get("error"))}
    req = payload.get("request") if isinstance(payload.get("request"), dict) else {}
    msgs = req.get("messages") if isinstance(req.get("messages"), list) else req.get("contents") if isinstance(req.get("contents"), list) else None
    tools = tool_definitions(req)
    request = {"captured": "metadata", **({"messages": len(msgs)} if msgs is not None else {}), **({"tools": tools} if tools else {})}
    calls = tool_calls(payload.get("response"))
    # Tool-call arguments go with the check, for classification; the API keeps only their keys and types
    response = {"captured": "metadata", "tool_calls": calls} if calls else ({"captured": "metadata"} if payload.get("response") else None)
    err = payload.get("error")
    return {**payload, "capture": "metadata", "request": request, "response": response,
            "error": mask_text(err)[:300] if isinstance(err, str) else err}
