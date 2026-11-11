import sys
import os
import time

# Ensure we can import leap360 directly from the directory without pip install
sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))

os.environ["LEAP360_API_URL"] = "http://localhost:4000"

from leap360 import Leap360Tracer

# ─── Mock OpenAI ─────────────────────────────────────────────────────────────

class MockUsage:
    def __init__(self):
        self.prompt_tokens = 10
        self.completion_tokens = 20
        self.total_tokens = 30

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
            "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30}
        }

class MockCompletions:
    def create(self, **kwargs):
        print(f"|  [MockOpenAI] Model: {kwargs.get('model')}")
        time.sleep(0.1)
        return MockModelDump("OpenAI mock response.")

class MockChat:
    def __init__(self):
        self.completions = MockCompletions()

# The class name must contain 'openai' for auto-detection
class FakeOpenAI:
    def __init__(self):
        self.chat = MockChat()

# ─── Mock Anthropic ───────────────────────────────────────────────────────────

class MockAnthropicUsage:
    def __init__(self):
        self.input_tokens = 15   # Anthropic uses input_tokens, not prompt_tokens
        self.output_tokens = 25  # Anthropic uses output_tokens, not completion_tokens

class MockAnthropicContent:
    def __init__(self):
        self.text = "Anthropic mock response."

class MockAnthropicResponse:
    def __init__(self):
        self.model = "claude-3-5-sonnet-20241022"
        self.usage = MockAnthropicUsage()
        self.content = [MockAnthropicContent()]

class MockAnthropicMessages:
    def create(self, **kwargs):
        print(f"|  [MockAnthropic] Model: {kwargs.get('model')}")
        time.sleep(0.1)
        return MockAnthropicResponse()

# The module name must contain 'anthropic' for auto-detection
class FakeAnthropic:
    __module__ = "anthropic.client"
    def __init__(self):
        self.messages = MockAnthropicMessages()

# ─── Mock Bedrock ─────────────────────────────────────────────────────────────

class MockBedrockResponse:
    def __init__(self):
        pass  # dict-like

class FakeBedrockMeta:
    class service_model:
        service_name = "bedrock-runtime"

class FakeBedrock:
    meta = FakeBedrockMeta()
    def send(self, command):
        model_id = getattr(getattr(command, "input", command), "modelId", "anthropic.claude-3-5-sonnet")
        print(f"|  [MockBedrock] ModelId: {model_id}")
        time.sleep(0.1)
        return {
            "output": {"message": {"content": [{"text": "Bedrock mock response."}]}},
            "usage": {"inputTokens": 12, "outputTokens": 18},
        }

# ─── Tests ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    tracer = Leap360Tracer(
        service_name="test-agent",
        api_key="test-api-key-123",
        project_id="test-project",
    )

    print("\n" + "=" * 55)
    print("TEST 1: OpenAI auto-wrap")
    print("=" * 55)
    openai_client = tracer.wrap(FakeOpenAI())
    resp = openai_client.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": "Hello from OpenAI test"}],
    )
    print(">> Response:", resp.choices[0].message.content)
    print(">> Usage:", resp.usage.prompt_tokens, "prompt /", resp.usage.completion_tokens, "completion tokens")

    print("\n" + "=" * 55)
    print("TEST 2: Anthropic auto-wrap")
    print("=" * 55)
    anthropic_client = tracer.wrap(FakeAnthropic())
    resp2 = anthropic_client.messages.create(
        model="claude-3-5-sonnet-20241022",
        max_tokens=1024,
        messages=[{"role": "user", "content": "Hello from Anthropic test"}],
    )
    print(">> Response:", resp2.content[0].text)
    print(">> Usage:", resp2.usage.input_tokens, "input /", resp2.usage.output_tokens, "output tokens")

    print("\n" + "=" * 55)
    print("TEST 3: Bedrock auto-wrap")
    print("=" * 55)

    class MockConverseCommand:
        def __init__(self, modelId, messages):
            self.input = type("Input", (), {"modelId": modelId, "messages": messages})()

    bedrock_client = tracer.wrap(FakeBedrock())
    cmd = MockConverseCommand(
        modelId="anthropic.claude-3-5-sonnet-20241022-v2:0",
        messages=[{"role": "user", "content": [{"text": "Hello from Bedrock test"}]}],
    )
    resp3 = bedrock_client.send(cmd)
    print(">> Response:", resp3["output"]["message"]["content"][0]["text"])
    print(">> Usage:", resp3["usage"]["inputTokens"], "input /", resp3["usage"]["outputTokens"], "output tokens")

    print("\n" + "=" * 55)
    print("TEST 4: Manual trace_call() — works with any provider")
    print("=" * 55)
    result = tracer.trace_call(
        fn=lambda: {"text": "Manual trace response", "tokens": 42},
        provider="mistral",
        model="mistral-large-latest",
        extract_usage=lambda r: {"prompt_tokens": 10, "completion_tokens": r["tokens"], "total_tokens": 10 + r["tokens"]},
    )
    print(">> Result:", result)

    print("\n✅ All tests passed. Traces sent (or attempted) to", tracer.api_url)

    print("\nWaiting a moment for async telemetry to execute (it fails gracefully in the background)...")
    time.sleep(1)
    
    print("\nDone! Test agent executed successfully.")
