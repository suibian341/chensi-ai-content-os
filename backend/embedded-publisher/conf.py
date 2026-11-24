import os
from pathlib import Path

BASE_DIR = str(Path(__file__).resolve().parent)
DEBUG_MODE = os.getenv("IP_AGENT_PUBLISH_DEBUG", "0").strip().lower() in {"1", "true", "yes", "on"}
LOCAL_CHROME_HEADLESS = os.getenv("IP_AGENT_PUBLISH_HEADLESS", "1").strip().lower() in {"1", "true", "yes", "on"}


def _find_browser() -> str:
    configured = os.getenv("IP_AGENT_PUBLISH_BROWSER_PATH", "").strip()
    if configured and Path(configured).is_file():
        return configured
    candidates = [
        Path(os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe")),
        Path(os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe")),
        Path(os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe")),
        Path(os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe")),
        Path(os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe")),
        Path(os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe")),
    ]
    return str(next((path for path in candidates if path.is_file()), ""))


LOCAL_CHROME_PATH = _find_browser()
