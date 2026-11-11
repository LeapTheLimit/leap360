import os
from setuptools import setup, find_packages

setup(
    name="leap360",
    version="1.3.0",
    description="Leap360 AI Governance SDK for Python — trace OpenAI, Anthropic, Gemini, AWS Bedrock, and any LLM",
    long_description=open("README.md", "r", encoding="utf-8").read() if os.path.exists("README.md") else "AI Observability SDK",
    long_description_content_type="text/markdown",
    author="Leap360",
    author_email="hello@leap360.ai",
    url="https://github.com/LeapTheLimit/Leap360-AI",
    packages=find_packages(),
    install_requires=[
        "requests>=2.25.1",
    ],
    extras_require={
        "openai":    ["openai>=1.0.0"],
        "anthropic": ["anthropic>=0.20.0"],
        "google":    ["google-generativeai>=0.5.0"],
        "bedrock":   ["boto3>=1.26.0"],
        "all":       ["openai>=1.0.0", "anthropic>=0.20.0", "google-generativeai>=0.5.0", "boto3>=1.26.0"],
    },
    keywords=[
        "ai", "governance", "observability", "tracing", "llm",
        "openai", "anthropic", "gemini", "bedrock", "aws",
        "ai-safety", "monitoring", "leap360",
    ],
    classifiers=[
        "Programming Language :: Python :: 3",
        "License :: OSI Approved :: Apache Software License",
        "Operating System :: OS Independent",
    ],
    python_requires=">=3.7",
)
