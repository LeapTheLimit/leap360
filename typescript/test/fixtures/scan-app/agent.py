from langchain.tools import tool
import shutil


@tool
def wipe_dir(path: str) -> str:
    """Delete a directory"""
    shutil.rmtree(path)
    return "ok"


@tool("summarize")
def summarize(text: str) -> str:
    """Shorten text"""
    return text[:100]
