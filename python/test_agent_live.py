import sys
import os
import time

# Ensure we can import leap360 directly from the directory without pip install
sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))

# LIVE PRODUCTION URL
os.environ["LEAP360_API_URL"] = "https://b0vyk178b7.execute-api.us-east-1.amazonaws.com"

from leap360 import Leap360Tracer

# --- Mock OpenAI for Testing ---
class MockUsage:
    def __init__(self):
        self.prompt_tokens = 15
        self.completion_tokens = 25
        self.total_tokens = 40

class MockMessage:
    def __init__(self, content):
        self.content = content

class MockChoice:
    def __init__(self, content):
        self.message = MockMessage(content)

class MockModelDump:
    def __init__(self, content):
        self.choices = [MockChoice(content)]
        self.usage = MockUsage()
    def model_dump(self):
        return {
            "choices": [{"message": {"content": self.choices[0].message.content}}],
            "usage": {"prompt_tokens": 15, "completion_tokens": 25, "total_tokens": 40}
        }

class MockCompletions:
    def create(self, **kwargs):
        print(f"|  [MockOpenAI] Request to Live Model: {kwargs.get('model')}")
        return MockModelDump("This is a LIVE production trace test!")

class MockChat:
    def __init__(self):
        self.completions = MockCompletions()

class FakeOpenAI:
    def __init__(self):
        self.chat = MockChat()

if __name__ == "__main__":
    print("-" * 50)
    print("Testing Leap360Tracer Python SDK against PRODUCTION (Live)")
    print("-" * 50)
    
    # 1. Provide an API key from the dashboard (important for PRODUCTION)
    # You MUST replace this with your real API Key from leap360.ai/dashboard
    api_key = os.environ.get("LEAP360_API_KEY", "YOUR_REAL_API_KEY_HERE")
    
    if api_key == "YOUR_REAL_API_KEY_HERE":
        print("[!] ERROR: You need set your real API Key from the live dashboard.")
        print("    Usage: LEAP360_API_KEY=your-key python3 test_agent_live.py")
        sys.exit(1)

    print(f"[1/3] Initializing Tracer with Production URL: {os.environ['LEAP360_API_URL']}...")
    tracer = Leap360Tracer(service_name="live-production-test", api_key=api_key)
    
    print("[2/3] Wrapping FakeOpenAI...")
    client = tracer.wrap(FakeOpenAI())
    
    print("[3/3] Sending trace to production cloud...")
    response = client.chat.completions.create(
        model="gpt-4-live-test",
        messages=[{"role": "user", "content": "Testing live telemetry."}]
    )
    
    print("\n[+] SUCCESS: Trace sent to production!")
    print(">> Agent Response:", response.choices[0].message.content)
    print("\nCheck your dashboard at the live URL to see the trace appear.")
    time.sleep(2)
