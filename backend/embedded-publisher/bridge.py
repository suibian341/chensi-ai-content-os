#!/usr/bin/env python3
import asyncio
import base64
import importlib.util
import json
import mimetypes
import os
import sys
import traceback
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

RESULT_PREFIX = "__CHENSI_PUBLISH_RESULT__"
EVENT_PREFIX = "__CHENSI_PUBLISH_EVENT__"


def emit_event(payload):
    print(f"{EVENT_PREFIX}{json.dumps(payload, ensure_ascii=False)}", flush=True)


def qrcode_data_url(qrcode):
    image_data_url = str((qrcode or {}).get("image_data_url") or "")
    if image_data_url.startswith("data:image/"):
        return image_data_url
    image_path = Path(str((qrcode or {}).get("image_path") or ""))
    if not image_path.is_file():
        return ""
    mime_type = mimetypes.guess_type(str(image_path))[0] or "image/png"
    return f"data:{mime_type};base64,{base64.b64encode(image_path.read_bytes()).decode('ascii')}"


def emit_qrcode(platform, qrcode):
    image_data_url = qrcode_data_url(qrcode)
    if image_data_url:
        emit_event({
            "type": "qrcode",
            "platform": platform,
            "imageDataUrl": image_data_url,
            "purpose": str((qrcode or {}).get("purpose") or "login"),
        })


def emit_authorization_event(platform, payload):
    event_type = str((payload or {}).get("event_type") or "")
    if event_type == "browser_frame":
        image_data_url = str((payload or {}).get("image_data_url") or "")
        if image_data_url.startswith("data:image/jpeg;base64,"):
            emit_event({
                "type": "browser_frame",
                "platform": platform,
                "imageDataUrl": image_data_url,
                "width": int((payload or {}).get("width") or 1280),
                "height": int((payload or {}).get("height") or 720),
                "url": str((payload or {}).get("url") or "")[:500],
                "title": str((payload or {}).get("title") or "")[:160],
                "sequence": int((payload or {}).get("sequence") or 0),
            })
        return
    if event_type != "verification":
        emit_qrcode(platform, payload)
        return
    methods = []
    for item in (payload or {}).get("methods") or []:
        method_id = str((item or {}).get("id") if isinstance(item, dict) else item).strip().lower()
        if method_id in {"sms", "face"} and method_id not in methods:
            methods.append(method_id)
    emit_event({
        "type": "verification",
        "platform": platform,
        "methods": [{"id": item} for item in methods],
        "selectedMethod": str((payload or {}).get("selected_method") or ""),
        "stage": str((payload or {}).get("stage") or "method_required"),
        "canResend": bool((payload or {}).get("can_resend", False)),
        "phoneHint": str((payload or {}).get("phone_hint") or "")[:80],
        "message": str((payload or {}).get("message") or "")[:240],
    })


def env_flag(name, fallback=True):
    value = os.getenv(name, "").strip().lower()
    if not value:
        return fallback
    return value in {"1", "true", "yes", "on"}


def compact_result(payload):
    if not isinstance(payload, dict):
        return payload
    result = dict(payload)
    # QR bytes have already been sent through the dedicated event channel.
    # Repeating them in the terminal result creates a multi-megabyte status line.
    result.pop("qrcode", None)
    result.pop("account_file", None)
    return result


def parse_date(value):
    if not value:
        return 0
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo:
        parsed = parsed.astimezone().replace(tzinfo=None)
    return parsed


def dependency_status(service):
    return {
        "python": True,
        "playwright": importlib.util.find_spec("playwright") is not None,
        "biliup": importlib.util.find_spec("biliup") is not None,
        "browser": bool(service.chrome_path),
        "browserPath": service.chrome_path or "",
    }


def execute(payload):
    from Core.publish_service import get_publish_service

    service = get_publish_service()
    action = str(payload.get("action") or "status")
    platform = str(payload.get("platform") or "")
    if action == "status":
        dependencies = dependency_status(service)
        return {
            "success": True,
            "available": dependencies["playwright"],
            "dependencies": dependencies,
            "platforms_status": {
                platform_id: service.check_login_status(platform_id)
                for platform_id in service.PLATFORMS
            },
        }
    if action == "connect":
        emit_event({"type": "status", "platform": platform, "status": "preparing"})
        return service.get_platform_cookie(
            platform,
            qrcode_callback=lambda event: emit_authorization_event(platform, event),
            headless=env_flag("IP_AGENT_PUBLISH_HEADLESS", True),
        )
    if action == "check":
        return service.validate_login_status(platform)
    if action == "clear":
        return service.clear_login(platform)
    if action == "publish":
        platforms = [str(item) for item in payload.get("platforms") or []]
        common = {
            "video_path": str(payload.get("video_path") or ""),
            "title": str(payload.get("title") or ""),
            "tags": [str(item) for item in payload.get("tags") or []],
            "cover_path": str(payload.get("cover_path") or "") or None,
            "is_draft": bool(payload.get("is_draft")),
            "submit_wait": int(payload.get("submit_wait") or 3),
            "publish_date": parse_date(payload.get("publish_date")),
        }
        if len(platforms) == 1:
            result = service.publish_video(platforms[0], **common)
            return {**result, "results": {platforms[0]: result}}
        return service.publish_to_all(platforms=platforms, **common)
    return {"success": False, "error": f"不支持的内置发布操作: {action}"}


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        result = compact_result(execute(payload))
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        result = {"success": False, "error": str(error), "error_type": type(error).__name__}
    print(f"{RESULT_PREFIX}{json.dumps(result, ensure_ascii=False)}", flush=True)


if __name__ == "__main__":
    main()
