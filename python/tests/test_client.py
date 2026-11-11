"""Tests for leap360.Leap360 (the API client) against a fake Leap360 API.
Run: python -m unittest discover -s tests -v   (from leap360-python-sdk/)"""
import json
import os
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from leap360 import Leap360  # noqa: E402


class FakeApi:
    """Records each request; suspends the agent named "halted" like the real API does"""

    def __init__(self):
        self.seen = []
        api = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _handle(self, method):
                url = urlparse(self.path)
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"null") if length else None
                api.seen.append({"method": method, "path": url.path, "query": parse_qs(url.query),
                                 "body": body, "key": self.headers.get("x-api-key")})
                if self.headers.get("x-api-key") != "leap360_test":
                    return self._send(401, {"error": "Unauthorized"})
                if url.path == "/v1/traces" and (body or {}).get("agent_name") == "halted":
                    return self._send(403, {"error": "Agent suspended", "code": "AGENT_HALT"})
                if url.path == "/v1/traces":
                    return self._send(200, {"id": "t1", "status": "OK"})
                if url.path.endswith("/shadow"):
                    return self._send(200, {"mode": "shadow", "totals": {"actions": 3, "wouldBlock": 1}})
                return self._send(200, {"ok": True, "path": url.path})

            def _send(self, code, payload):
                data = json.dumps(payload).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                self._handle("GET")

            def do_POST(self):
                self._handle("POST")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def last(self):
        return self.seen[-1]


class ClientTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api = FakeApi()

    @classmethod
    def tearDownClass(cls):
        cls.api.server.shutdown()

    def leap(self, key="leap360_test"):
        return Leap360(api_key=key, base_url=self.api.url)

    def test_trace_sends_the_trace_and_returns_the_response(self):
        r = self.leap().trace(model="gpt-4o", provider="openai", service_name="search", latency_ms=12,
                              usage={"prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 3})
        self.assertEqual(r, {"id": "t1", "status": "OK"})
        sent = self.api.last()
        self.assertEqual(sent["path"], "/v1/traces")
        self.assertEqual(sent["key"], "leap360_test")
        self.assertEqual(sent["body"]["model"], "gpt-4o")
        self.assertEqual(sent["body"]["agent_name"], "search")  # defaults to service_name
        self.assertEqual(sent["body"]["usage"]["total_tokens"], 3)

    def test_suspended_agent_is_returned_not_raised(self):
        r = self.leap().trace(model="m", agent_name="halted")
        self.assertEqual(r["code"], "AGENT_HALT")
        self.assertEqual(r["http_status"], 403)

    def test_bad_key_returns_401(self):
        r = self.leap(key="leap360_wrong").get_stats()
        self.assertEqual(r["http_status"], 401)

    def test_no_key_never_calls_the_api(self):
        before = len(self.api.seen)
        old = os.environ.pop("LEAP360_API_KEY", None)
        try:
            leap = Leap360(base_url=self.api.url)
            leap.api_key = None  # ignore any ~/.leap360/config.json on this machine
            r = leap.trace(model="m")
        finally:
            if old is not None:
                os.environ["LEAP360_API_KEY"] = old
        self.assertEqual(r["code"], "NO_API_KEY")
        self.assertEqual(len(self.api.seen), before)

    def test_unreachable_api_is_returned_not_raised(self):
        r = Leap360(api_key="leap360_test", base_url="http://127.0.0.1:1", timeout=1).get_stats()
        self.assertEqual(r["code"], "UNREACHABLE")

    def test_read_routes(self):
        leap = self.leap()
        for call, path in [
            (leap.get_stats, "/v1/projects/me/stats"),
            (leap.get_agents, "/v1/projects/me/agents"),
            (leap.get_violations, "/v1/projects/me/violations"),
            (leap.get_policies, "/v1/projects/me/policies"),
            (leap.get_approvals, "/v1/projects/me/approvals"),
            (leap.get_mode, "/v1/projects/me/mode"),
            (leap.get_scans, "/v1/projects/me/scans"),
            (lambda: leap.get_agent_status("bot"), "/v1/projects/me/agents/bot/status"),
        ]:
            call()
            self.assertEqual((self.api.last()["method"], self.api.last()["path"]), ("GET", path))

    def test_traces_and_actions_pass_paging(self):
        leap = self.leap()
        leap.get_traces(limit=10, offset=20)
        self.assertEqual(self.api.last()["query"], {"limit": ["10"], "offset": ["20"]})
        leap.get_actions(limit=5)
        self.assertEqual(self.api.last()["query"], {"limit": ["5"]})  # since=None is not sent

    def test_shadow_report(self):
        r = self.leap().get_shadow_report()
        self.assertEqual(r["totals"]["wouldBlock"], 1)

    def test_writes(self):
        leap = self.leap()
        leap.set_mode("shadow", days=7)
        self.assertEqual(self.api.last()["body"], {"mode": "shadow", "days": 7})
        leap.suspend_agent("bot")
        self.assertEqual((self.api.last()["path"], self.api.last()["body"]), ("/v1/projects/me/agents/bot/status", {"status": "SUSPENDED"}))
        leap.resume_agent("bot")
        self.assertEqual(self.api.last()["body"], {"status": "ACTIVE"})
        leap.decide_approval("trace-1", "approved", note="ok")
        self.assertEqual(self.api.last()["body"], {"decision": "APPROVED", "adminNote": "ok"})
        leap.create_policy({"name": "No PII", "rules": ["Do not reveal card numbers"]})
        self.assertEqual((self.api.last()["method"], self.api.last()["path"]), ("POST", "/v1/projects/me/policies"))


if __name__ == "__main__":
    unittest.main()
