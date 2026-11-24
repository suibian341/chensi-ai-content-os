import base64
import os
import urllib.request
from pathlib import Path


def build_login_qrcode_path(account_file, suffix="login_qrcode"):
    directory = Path(account_file).expanduser().resolve().parent
    directory.mkdir(parents=True, exist_ok=True)
    return directory / f"{suffix}.png"


def save_data_url_image(source, target_path):
    target = Path(target_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    if str(source).startswith("data:image/"):
        encoded = str(source).split(",", 1)[1]
        target.write_bytes(base64.b64decode(encoded))
    else:
        request = urllib.request.Request(str(source), headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(request, timeout=30) as response:
            target.write_bytes(response.read())
    return target


def decode_qrcode_from_path(path):
    try:
        import cv2

        image = cv2.imread(str(path))
        if image is None:
            return ""
        value, _, _ = cv2.QRCodeDetector().detectAndDecode(image)
        return value or ""
    except Exception:
        return ""


def print_terminal_qrcode(content, image_path=None, app_name="平台应用"):
    # Login runs with a visible browser. The saved image remains a fallback.
    if image_path:
        print(f"请使用{app_name}扫描浏览器中的二维码（备用图片：{image_path}）", flush=True)


def remove_qrcode_file(path):
    if not path:
        return False
    try:
        os.remove(path)
        return True
    except FileNotFoundError:
        return False
