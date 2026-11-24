import asyncio
import base64
import hashlib
import inspect
import json
import os
import time
from pathlib import Path


class InteractiveBrowser:
    """Small authenticated browser relay over the existing task event channel."""

    def __init__(self, event_callback=None):
        configured = os.getenv("IP_AGENT_PUBLISH_CONTROL_DIR", "").strip()
        self.control_dir = Path(configured) if configured else None
        self.event_callback = event_callback
        self.enabled = False
        self.sequence = 0
        self.last_capture_at = 0.0
        self.last_digest = ""

    def _read_commands(self) -> list[dict]:
        if not self.control_dir or not self.control_dir.is_dir():
            return []
        commands = []
        for command_file in sorted(self.control_dir.glob("browser-command-*.json")):
            try:
                if command_file.stat().st_size > 32_768:
                    command_file.unlink(missing_ok=True)
                    continue
                command = json.loads(command_file.read_text(encoding="utf-8"))
            except (OSError, ValueError, json.JSONDecodeError):
                continue
            try:
                command_file.unlink(missing_ok=True)
            except OSError:
                pass
            if isinstance(command, dict):
                commands.append(command)
        return commands

    async def _emit(self, payload: dict):
        if not self.event_callback:
            return
        result = self.event_callback(payload)
        if inspect.isawaitable(result):
            await result

    @staticmethod
    def _number(value, minimum, maximum, fallback=0.0) -> float:
        try:
            return min(max(float(value), minimum), maximum)
        except (TypeError, ValueError):
            return fallback

    async def _apply_command(self, page, command: dict) -> bool:
        action = str(command.get("action") or "").strip().lower()
        if action == "open_browser":
            self.enabled = True
            return True
        if not self.enabled:
            return False
        if action == "click":
            await page.mouse.click(
                self._number(command.get("x"), 0, 4096),
                self._number(command.get("y"), 0, 4096),
            )
            return True
        if action == "drag":
            start_x = self._number(command.get("startX"), 0, 4096)
            start_y = self._number(command.get("startY"), 0, 4096)
            end_x = self._number(command.get("endX"), 0, 4096)
            end_y = self._number(command.get("endY"), 0, 4096)
            await page.mouse.move(start_x, start_y)
            await page.mouse.down()
            await page.mouse.move(end_x, end_y, steps=12)
            await page.mouse.up()
            return True
        if action == "type_text":
            text = str(command.get("text") or "")[:512]
            if text:
                await page.keyboard.insert_text(text)
            return True
        if action == "press_key":
            key = str(command.get("key") or "")
            allowed = {
                "Enter", "Tab", "Escape", "Backspace", "Delete", "Space",
                "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
            }
            if key in allowed:
                await page.keyboard.press(key)
            return True
        if action == "scroll":
            delta_y = self._number(command.get("deltaY"), -1600, 1600)
            await page.mouse.wheel(0, delta_y)
            return True
        if action == "reload":
            try:
                await page.reload(wait_until="commit", timeout=30_000)
            except Exception:
                pass
            return True
        if action == "go_back":
            try:
                await page.go_back(wait_until="commit", timeout=30_000)
            except Exception:
                pass
            return True
        return False

    async def _capture(self, page, force=False):
        if not self.enabled:
            return
        now = time.monotonic()
        if not force and now - self.last_capture_at < 0.9:
            return
        self.last_capture_at = now
        try:
            viewport = page.viewport_size or {"width": 1280, "height": 720}
            image = await page.screenshot(type="jpeg", quality=68, animations="disabled", timeout=7_000)
            digest = hashlib.sha256(image).hexdigest()
            if not force and digest == self.last_digest:
                return
            self.last_digest = digest
            self.sequence += 1
            title = await page.title()
            await self._emit({
                "event_type": "browser_frame",
                "image_data_url": f"data:image/jpeg;base64,{base64.b64encode(image).decode('ascii')}",
                "width": int(viewport.get("width") or 1280),
                "height": int(viewport.get("height") or 720),
                "url": str(page.url or "")[:500],
                "title": str(title or "")[:160],
                "sequence": self.sequence,
            })
        except Exception:
            # Login detection must continue even when one frame cannot be captured.
            return

    async def tick(self, page):
        changed = False
        for command in self._read_commands():
            try:
                changed = await self._apply_command(page, command) or changed
            except Exception:
                changed = True
        await self._capture(page, force=changed)

    async def wait(self, page, seconds: float):
        deadline = time.monotonic() + max(0.0, float(seconds))
        while True:
            await self.tick(page)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            await asyncio.sleep(min(0.25, remaining))

