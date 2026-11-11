"""Issue #50: by default no end-user text leaves the process.
Run: python -m unittest discover -s tests -v   (from leap360-python-sdk/)"""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from leap360 import Leap360Tracer, Leap360Governor  # noqa: E402
from leap360.privacy import capture_level, shape_of, mask_text, trace_at_capture  # noqa: E402

PROMPT = "I am Jane Doe, jane.doe@example.com, card 4111 1111 1111 1111, call +1 415 555 0132: refund my order"
PAYLOAD = {
    "model": "gpt-4o", "usage": {"prompt_tokens": 9, "completion_tokens": 4, "total_tokens": 13},
    "request": {"messages": [{"role": "user", "content": PROMPT}], "tools": [{"type": "function", "function": {"name": "refund", "description": "Refund an order"}}]},
    "response": {"choices": [{"message": {"content": "Done, Jane Doe.", "tool_calls": [{"function": {"name": "refund", "arguments": '{"order": "A-1", "amount": 900}'}}]}}]},
    "error": None,
}


class PrivacyTests(unittest.TestCase):
    def test_levels(self):
        self.assertEqual(capture_level(None), "metadata")
        self.assertEqual(capture_level("FULL"), "full")
        self.assertEqual(capture_level("everything"), "metadata")
        os.environ["LEAP360_CAPTURE"] = "redacted"
        try:
            self.assertEqual(Leap360Tracer(api_key="k").capture, "redacted")
            self.assertEqual(Leap360Governor(api_key="k", capture="full").capture, "full")
        finally:
            del os.environ["LEAP360_CAPTURE"]
        self.assertEqual(Leap360Tracer(api_key="k").capture, "metadata")

    def test_shape(self):
        self.assertEqual(shape_of({"to": "a@b.co", "amount": 9, "ok": True, "items": [1, 2], "n": None}),
                         {"to": "string", "amount": "number", "ok": "boolean", "items": "array(2)", "n": "null"})

    def test_default_trace_sends_no_prompt_or_reply_text(self):
        sent = trace_at_capture(PAYLOAD, "metadata")
        text = json.dumps(sent, ensure_ascii=False)
        for t in ("Jane Doe", "jane.doe@example.com", "4111", "refund my order", "Done,"):
            self.assertNotIn(t, text)
        self.assertEqual(sent["request"], {"captured": "metadata", "messages": 1, "tools": [{"type": "function", "name": "refund", "description": "Refund an order"}]})
        self.assertEqual(sent["response"]["tool_calls"][0]["name"], "refund")
        self.assertEqual(sent["usage"]["total_tokens"], 13)

    def test_redacted_masks_personal_details_before_sending(self):
        text = json.dumps(trace_at_capture(PAYLOAD, "redacted"), ensure_ascii=False)
        self.assertNotIn("jane.doe@example.com", text)
        self.assertIn("j•••@example.com", text)
        self.assertIn("[CARD •••• 1111]", text)
        self.assertIn("[PHONE ••32]", text)
        self.assertEqual(mask_text("on 2026-11-11"), "on 2026-11-11")


if __name__ == "__main__":
    unittest.main()
