"""Tests for leap360.governor against a deliberately slow fake Leap360 API.
Run: python -m unittest discover -s tests -v   (from leap360-python-sdk/)"""
import asyncio
import json
import os
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from leap360 import Leap360Governor, ActionBlocked  # noqa: E402
from leap360.governor import to_plain, redact, offline_risk  # noqa: E402

API_DELAY = 0.4


class FakeApi:
    """Blocks tools named delete_*, holds deploy_*, reports a configurable mode and kill switch"""

    def __init__(self, mode="enforce"):
        self.mode = mode
        self.status = "ACTIVE"
        self.seen = []
        self.caps = []
        api = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, payload):
                body = json.dumps(payload).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                if "/status" in self.path:
                    return self._send(200, {"status": api.status, "mode": api.mode})
                if self.path.endswith("/poll"):
                    return self._send(200, {"decision": "APPROVED"})
                self._send(404, {"error": "not found"})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
                if self.path == "/v1/capabilities":
                    api.caps.append(body)
                    return self._send(200, {"saved": len(body.get("tools", []))})
                api.seen.append(body)
                time.sleep(API_DELAY)
                if api.status == "SUSPENDED":
                    return self._send(403, {"code": "GOVERNANCE_HALT", "message": "Project is suspended. Kill switch is active.", "decision": "block"})
                if body.get("phase") == "post":
                    return self._send(200, {"ok": True})
                tool = body.get("tool", "")
                verdict = "block" if tool.startswith("delete_") else "review" if tool.startswith("deploy_") else "allow"
                decision = "allow" if api.mode == "shadow" else verdict
                extra = {"message": f'Blocked by policy for {tool}'} if verdict == "block" else {}
                if verdict == "review":
                    extra = {"message": "Needs approval", "approvalId": body.get("id")}
                self._send(200, {"id": body.get("id"), "mode": api.mode, "decision": decision, "wouldBe": verdict, "category": "unknown", "risk": "high", **extra})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()

    def pre(self):
        return [b for b in self.seen if b.get("phase") == "pre"]

    def post(self):
        return [b for b in self.seen if b.get("phase") == "post"]


def quiet():
    return lambda m: None


class GovernorTests(unittest.TestCase):
    def test_enforce_blocks_before_the_function_runs(self):
        api = FakeApi("enforce")
        try:
            gov = Leap360Governor(api_key="k", agent_name="ops-bot", api_url=api.url, mode="enforce", log=quiet())
            ran = []

            @gov.wrap_tool("delete_namespace")
            def delete_namespace(name):
                ran.append(name)

            @gov.wrap_tool("list_pods")
            def list_pods(namespace):
                return [f"{namespace}/web-1"]

            with self.assertRaises(ActionBlocked) as ctx:
                delete_namespace(name="payments")
            self.assertEqual(ran, [])
            self.assertEqual(ctx.exception.code, "ACTION_BLOCKED")
            self.assertEqual(list_pods("web"), ["web/web-1"])
            time.sleep(API_DELAY + 0.3)
            self.assertEqual([b["tool"] for b in api.pre()], ["delete_namespace", "list_pods"])
            self.assertEqual(api.pre()[1]["args"], {"namespace": "web"}, "positional args are named from the signature")
            self.assertEqual(len(api.post()), 1, "only the call that ran reports an outcome")
            self.assertNotIn("result_preview", api.post()[0], "no result text leaves the process by default (issue #50)")
            self.assertEqual(api.post()[0]["capture"], "metadata")
        finally:
            api.close()

    def test_shadow_never_waits_and_records_the_outcome(self):
        api = FakeApi("shadow")
        try:
            gov = Leap360Governor(api_key="k", agent_name="ops-bot", api_url=api.url, mode="shadow", log=quiet())

            @gov.wrap_tool("delete_namespace")
            def delete_namespace(name):
                return f"deleted {name}"

            delete_namespace("warm")  # first call loads the kill-switch status
            t = time.monotonic()
            self.assertEqual(delete_namespace("payments"), "deleted payments")
            self.assertLess(time.monotonic() - t, 0.05, "shadow mode does not wait for the API")
            time.sleep(2 * API_DELAY + 0.3)
            self.assertEqual(len(api.post()), 2, "outcomes arrive after their pre reports")
        finally:
            api.close()

    def test_kill_switch_lands_within_the_status_window(self):
        api = FakeApi("shadow")
        try:
            gov = Leap360Governor(api_key="k", agent_name="ops-bot", api_url=api.url, mode="shadow", status_ttl=0.2, log=quiet())
            run = gov.wrap_tool("list_pods")(lambda: "ok")
            self.assertEqual(run(), "ok")
            api.status = "SUSPENDED"
            time.sleep(0.3)
            with self.assertRaises(ActionBlocked):
                run()
            api.status = "ACTIVE"
            time.sleep(0.3)
            self.assertEqual(run(), "ok", "resume works without a restart")
        finally:
            api.close()

    def test_unserialisable_arguments_do_not_skip_the_check(self):
        api = FakeApi("enforce")
        try:
            gov = Leap360Governor(api_key="k", agent_name="ops-bot", api_url=api.url, mode="enforce", log=quiet())
            circular = {}
            circular["self"] = circular

            @gov.wrap_tool("delete_records")
            def delete_records(payload, raw):
                return "ran"

            with self.assertRaises(ActionBlocked):
                delete_records(circular, b"\x00\x01")
            self.assertEqual(api.pre()[0]["args"]["payload"]["self"], "[circular]")
            self.assertEqual(api.pre()[0]["args"]["raw"], "[binary 2 bytes]")
        finally:
            api.close()

    def test_held_call_waits_for_approval_when_asked(self):
        api = FakeApi("enforce")
        try:
            gov = Leap360Governor(api_key="k", agent_name="ops-bot", api_url=api.url, mode="enforce", approval_wait=5, log=quiet())
            deploy = gov.wrap_tool("deploy_service")(lambda env: f"deployed to {env}")
            self.assertEqual(deploy("production"), "deployed to production")
            no_wait = Leap360Governor(api_key="k", agent_name="ops-bot", api_url=api.url, mode="enforce", log=quiet())
            with self.assertRaises(ActionBlocked) as ctx:
                no_wait.wrap_tool("deploy_service")(lambda env: "ran")("production")
            self.assertEqual(ctx.exception.code, "APPROVAL_REQUIRED")
        finally:
            api.close()

    def test_async_tools(self):
        api = FakeApi("enforce")
        try:
            gov = Leap360Governor(api_key="k", agent_name="ops-bot", api_url=api.url, mode="enforce", log=quiet())

            @gov.wrap_tool("delete_bucket")
            async def delete_bucket(name):
                return "ran"

            @gov.wrap_tool("get_object")
            async def get_object(key):
                return f"object {key}"

            async def main():
                with self.assertRaises(ActionBlocked):
                    await delete_bucket("logs")
                return await get_object("a.txt")
            self.assertEqual(asyncio.run(main()), "object a.txt")
        finally:
            api.close()

    def test_offline_blocks_only_destructive_calls(self):
        gov = Leap360Governor(api_key="k", agent_name="ops-bot", api_url="http://127.0.0.1:9", mode="enforce", timeout=0.5, log=quiet())
        self.assertEqual(gov.wrap_tool("list_pods")(lambda: "ok")(), "ok")
        with self.assertRaises(ActionBlocked) as ctx:
            gov.wrap_tool("run_command")(lambda command: "ran")(command="kubectl delete namespace prod")
        self.assertIn("unreachable", ctx.exception.gate.message)

    def test_invalid_tool_names_are_refused(self):
        gov = Leap360Governor(api_key="k", agent_name="ops-bot", api_url="http://127.0.0.1:9", log=quiet())
        with self.assertRaises(TypeError):
            gov.wrap_tool("")(lambda: None)
        with self.assertRaises(TypeError):
            gov.wrap_tool("x" * 201)(lambda: None)


    def test_wrapping_a_tool_declares_it_once_for_the_capability_map(self):
        api = FakeApi("shadow")
        try:
            gov = Leap360Governor(api_key="k", agent_name="ops-bot", api_url=api.url, mode="shadow", log=quiet())

            @gov.wrap_tool("delete_namespace", hints={"destructiveHint": True})
            def delete_namespace(name):
                """Deletes a Kubernetes namespace."""
                return name

            gov.wrap_tool("delete_namespace")(lambda name: name)  # the same tool again: not re-sent
            deadline = time.time() + 3
            while not api.caps and time.time() < deadline:
                time.sleep(0.05)
            time.sleep(0.2)
            self.assertEqual(len(api.caps), 1)
            self.assertEqual(api.caps[0]["agent_name"], "ops-bot")
            self.assertEqual(api.caps[0]["tools"], [{"tool": "delete_namespace", "source": "sdk", "description": "Deletes a Kubernetes namespace.", "hints": {"destructiveHint": True}}])
            self.assertEqual(api.seen, [], "declaring a tool is not a tool call")
        finally:
            api.server.shutdown()


class HelperTests(unittest.TestCase):
    def test_redaction(self):
        self.assertEqual(redact("postgres://admin:Sup3rS3cret@db:5432/app"), "postgres://admin:[REDACTED]@db:5432/app")
        self.assertNotIn("QAFAKEKEY", redact("key AKIA" + "QAFAKEKEY1234567"))

    def test_offline_risk(self):
        self.assertEqual(offline_risk("run_command", {"command": "terraform destroy -auto-approve"}), "critical")
        self.assertEqual(offline_risk("list_pods", {}), "low")
        self.assertEqual(offline_risk("deploy_service", {"env": "prod"}), "high")

    def test_to_plain_never_raises(self):
        class Thing:
            def __init__(self):
                self.a = 1
        self.assertEqual(to_plain({"n": 10 ** 30, "t": Thing(), "s": {1}}), {"n": str(10 ** 30), "t": {"a": 1}, "s": [1]})


if __name__ == "__main__":
    unittest.main()
