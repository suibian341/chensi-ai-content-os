import ctypes
import json
import os
import platform
import re
import socket
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener, urlopen


RESULT_PREFIX = "__CHENSI_JIANYING_RESULT__"
APP_DIR = Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "ChensiAI" / "JianyingCompanion"
CONFIG_PATH = APP_DIR / "config.json"
BRIDGE_PATH = Path(__file__).resolve().with_name("bridge.py")


class SafeRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message_text, headers, new_url):
        redirected = super().redirect_request(request, file_pointer, code, message_text, headers, new_url)
        if redirected and urlparse(request.full_url).netloc.lower() != urlparse(new_url).netloc.lower():
            redirected.remove_header("Authorization")
        return redirected


def message(title, text, error=False):
    flags = 0x10 if error else 0x40
    ctypes.windll.user32.MessageBoxW(None, str(text), str(title), flags)


def load_config():
    APP_DIR.mkdir(parents=True, exist_ok=True)
    try:
        with CONFIG_PATH.open("r", encoding="utf-8") as source:
            data = json.load(source)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        data = {}
    data.setdefault("deviceId", str(uuid.uuid4()))
    data.setdefault("bindings", {})
    return data


def save_config(config):
    APP_DIR.mkdir(parents=True, exist_ok=True)
    temporary = CONFIG_PATH.with_suffix(f".{os.getpid()}.tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as target:
        json.dump(config, target, ensure_ascii=False, indent=2)
        target.flush()
        os.fsync(target.fileno())
    os.replace(temporary, CONFIG_PATH)


def parse_launch_url(value):
    parsed = urlparse(str(value or ""))
    if parsed.scheme.lower() != "chensi-jianying" or parsed.netloc.lower() != "run":
        raise ValueError("剪映助手启动链接无效")
    query = parse_qs(parsed.query)
    server = str((query.get("server") or [""])[0]).rstrip("/")
    token = str((query.get("token") or [""])[0])
    server_url = urlparse(server)
    if server_url.scheme not in {"http", "https"} or not server_url.netloc or not token:
        raise ValueError("剪映助手启动链接缺少服务器或操作凭证")
    return server, token


def api_json(server, pathname, payload):
    request = Request(
        f"{server}{pathname}",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=60) as response:
            body = json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        try:
            body = json.loads(error.read().decode("utf-8"))
            detail = body.get("error") or body.get("message")
        except Exception:
            detail = None
        raise RuntimeError(detail or f"服务器返回 HTTP {error.code}") from error
    except URLError as error:
        raise RuntimeError(f"无法连接辰思AI服务器：{error.reason}") from error
    if body.get("ok") is False:
        raise RuntimeError(body.get("error") or "服务器拒绝了本机操作")
    return body.get("data") or {}


def candidate_draft_roots():
    local = Path(os.environ.get("LOCALAPPDATA") or Path.home())
    return [
        local / "JianyingPro" / "User Data" / "Projects" / "com.lveditor.draft",
        local / "CapCut" / "User Data" / "Projects" / "com.lveditor.draft",
    ]


def choose_draft_root(initial=""):
    import tkinter as tk
    from tkinter import filedialog

    suggested = str(initial or next((item for item in candidate_draft_roots() if item.is_dir()), Path.home()))
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    selected = filedialog.askdirectory(
        parent=root,
        title="选择当前账号的剪映草稿目录",
        initialdir=suggested,
        mustexist=True,
    )
    root.destroy()
    if not selected:
        raise RuntimeError("已取消选择剪映草稿目录")
    resolved = Path(selected).resolve()
    if not resolved.is_dir():
        raise RuntimeError("所选剪映草稿目录不存在")
    probe = resolved / f".chensi-write-test-{uuid.uuid4().hex}"
    try:
        probe.write_text("ok", encoding="utf-8")
    finally:
        try:
            probe.unlink()
        except FileNotFoundError:
            pass
    return str(resolved)


def binding_for(config, user_ref, force_choose=False):
    previous = str(config.get("bindings", {}).get(user_ref, {}).get("draftRoot") or "")
    if not force_choose and previous and Path(previous).is_dir():
        return previous
    selected = choose_draft_root(previous)
    config["bindings"][user_ref] = {"draftRoot": selected}
    save_config(config)
    return selected


def download_file(url, target, max_bytes=8 * 1024 * 1024 * 1024, progress_callback=None, token=""):
    headers = {"Accept": "*/*", "User-Agent": "Chensi-Jianying-Companion/1.0"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = Request(url, headers=headers)
    try:
        with build_opener(SafeRedirectHandler()).open(request, timeout=120) as response, target.open("wb") as output:
            total = 0
            expected = int(response.headers.get("Content-Length") or 0)
            last_reported = -1
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise RuntimeError("待导入成片超过本机助手允许的大小")
                output.write(chunk)
                if progress_callback:
                    percent = min(100, round(total * 100 / expected)) if expected > 0 else None
                    if (percent is None and last_reported < 0) or (percent is not None and percent >= last_reported + 5):
                        progress_callback(percent)
                        last_reported = percent if percent is not None else 0
    except HTTPError as error:
        raise RuntimeError(f"下载待导入文件失败：HTTP {error.code}") from error
    except URLError as error:
        raise RuntimeError(f"下载待导入文件失败：{error.reason}") from error


def srt_timestamp(seconds):
    total = max(0, round(float(seconds or 0) * 1000))
    hours, remainder = divmod(total, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, milliseconds = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{milliseconds:03d}"


def fallback_srt(text, duration, target):
    sentences = [item.strip() for item in re.split(r"(?<=[。！？!?；;])\s*|\n+", str(text or "")) if item.strip()]
    if not sentences:
        return None
    total_duration = max(float(duration or 0), len(sentences) * 1.2)
    weights = [max(1, len(item)) for item in sentences]
    total_weight = sum(weights)
    cursor = 0.0
    blocks = []
    for index, (sentence, weight) in enumerate(zip(sentences, weights), 1):
        end = total_duration if index == len(sentences) else min(total_duration, cursor + total_duration * weight / total_weight)
        blocks.append(f"{index}\n{srt_timestamp(cursor)} --> {srt_timestamp(end)}\n{sentence}")
        cursor = end
    target.write_text("\n\n".join(blocks) + "\n", encoding="utf-8")
    return target


def ass_timestamp(value):
    match = re.fullmatch(r"\s*(\d+):(\d{1,2}):(\d{1,2})(?:[.](\d{1,3}))?\s*", str(value or ""))
    if not match:
        raise ValueError("ASS 字幕时间格式无效")
    hours, minutes, seconds = [int(match.group(index)) for index in range(1, 4)]
    fraction = (match.group(4) or "0")[:3].ljust(3, "0")
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{fraction}"


def convert_ass_to_srt(source, target):
    blocks = []
    for line in source.read_text(encoding="utf-8-sig", errors="replace").splitlines():
        if not line.lstrip().lower().startswith("dialogue:"):
            continue
        fields = line.split(":", 1)[1].split(",", 9)
        if len(fields) < 10:
            continue
        text = re.sub(r"\{[^}]*\}", "", fields[9]).replace(r"\N", "\n").replace(r"\n", "\n").strip()
        if not text:
            continue
        try:
            start = ass_timestamp(fields[1])
            end = ass_timestamp(fields[2])
        except ValueError:
            continue
        blocks.append(f"{len(blocks) + 1}\n{start} --> {end}\n{text}")
    if not blocks:
        raise RuntimeError("ASS 字幕没有可导入的有效时间轴")
    target.write_text("\n\n".join(blocks) + "\n", encoding="utf-8")
    return target


def canvas_size(ratio):
    try:
        width, height = [float(item) for item in str(ratio or "").split(":", 1)]
        if width > 0 and height > 0:
            return (1080, round(1080 * height / width)) if width < height else (round(1080 * width / height), 1080)
    except (ValueError, TypeError):
        pass
    return 1080, 1920


def run_bridge(payload):
    process = subprocess.run(
        [sys.executable, str(BRIDGE_PATH)],
        input=json.dumps(payload, ensure_ascii=False),
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        timeout=30 * 60,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    marker = process.stdout.rfind(RESULT_PREFIX)
    if marker < 0:
        raise RuntimeError((process.stderr or "剪映草稿生成器没有返回有效结果").strip()[-1000:])
    result = json.loads(process.stdout[marker + len(RESULT_PREFIX):].splitlines()[0])
    if result.get("success") is False:
        raise RuntimeError(result.get("error") or "剪映草稿生成失败")
    return result


def complete(server, token, device_id, success, **values):
    payload = {"token": token, "deviceId": device_id, "success": bool(success), **values}
    return api_json(server, "/api/jianying-companion/complete", payload)


def report_progress(server, token, device_id, stage, progress=None):
    try:
        api_json(server, "/api/jianying-companion/progress", {
            "token": token,
            "deviceId": device_id,
            "stage": stage,
            "progress": progress,
        })
    except Exception:
        pass


def main():
    if len(sys.argv) < 2:
        raise ValueError("缺少剪映助手启动链接")
    server, token = parse_launch_url(sys.argv[1])
    config = load_config()
    save_config(config)
    device_id = config["deviceId"]
    claimed = api_json(server, "/api/jianying-companion/claim", {
        "token": token,
        "deviceId": device_id,
        "deviceName": f"{socket.gethostname()} · {platform.system()}",
    })
    user_ref = str(claimed.get("userRef") or "")
    if not user_ref:
        raise RuntimeError("服务器没有返回用户绑定标识")
    if claimed.get("action") == "bind":
        report_progress(server, token, device_id, "选择草稿目录")
        binding_for(config, user_ref, force_choose=True)
        complete(server, token, device_id, True)
        message("辰思AI本机剪映", "本机剪映目录已为当前账号绑定。")
        return

    draft_root = binding_for(config, user_ref)
    with tempfile.TemporaryDirectory(prefix="chensi-jianying-") as temporary_value:
        temporary = Path(temporary_value)
        video_path = temporary / "source-video.mp4"
        download_file(
            str(claimed.get("videoUrl") or ""),
            video_path,
            progress_callback=lambda percent: report_progress(server, token, device_id, "下载成片", percent),
            token=token,
        )
        subtitle_path = None
        if claimed.get("subtitleUrl"):
            report_progress(server, token, device_id, "下载字幕")
            subtitle_format = str(claimed.get("subtitleFormat") or "srt").lower()
            if subtitle_format in {"srt", "ass"}:
                subtitle_source = temporary / f"subtitles.{subtitle_format}"
                download_file(str(claimed["subtitleUrl"]), subtitle_source, max_bytes=20 * 1024 * 1024, token=token)
                subtitle_path = convert_ass_to_srt(subtitle_source, temporary / "subtitles.srt") if subtitle_format == "ass" else subtitle_source
        if not subtitle_path:
            subtitle_path = fallback_srt(
                claimed.get("speechScript"),
                claimed.get("durationSeconds"),
                temporary / "generated-subtitles.srt",
            )
        width, height = canvas_size(claimed.get("ratio"))
        report_progress(server, token, device_id, "生成剪映草稿")
        result = run_bridge({
            "action": "import",
            "draftRoot": draft_root,
            "indexPath": str(Path(draft_root) / "root_meta_info.json"),
            "draftName": claimed.get("draftName") or "辰思AI成片",
            "videoPath": str(video_path),
            "subtitlePath": str(subtitle_path) if subtitle_path else None,
            "width": width,
            "height": height,
            "fps": claimed.get("fps") or 30,
            "sourceOutputId": claimed.get("outputId"),
        })
    complete(
        server,
        token,
        device_id,
        True,
        draftName=result.get("draftName"),
        durationSeconds=result.get("durationSeconds"),
        subtitleCount=result.get("subtitleCount"),
        library=result.get("library"),
        libraryVersion=result.get("libraryVersion"),
    )
    message("辰思AI本机剪映", f"已导入剪映草稿：{result.get('draftName') or '辰思AI成片'}")


if __name__ == "__main__":
    server_value = None
    token_value = None
    device_value = None
    try:
        if len(sys.argv) >= 2:
            server_value, token_value = parse_launch_url(sys.argv[1])
        current_config = load_config()
        device_value = current_config.get("deviceId")
        main()
    except Exception as error:
        if server_value and token_value and device_value:
            try:
                complete(server_value, token_value, device_value, False, message=str(error))
            except Exception:
                pass
        message("辰思AI本机剪映", str(error), error=True)
