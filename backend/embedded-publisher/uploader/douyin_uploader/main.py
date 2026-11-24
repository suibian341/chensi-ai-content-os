# -*- coding: utf-8 -*-
"""
抖音视频/图文上传模块
同步自 social-auto-upload (2026.05) 最新版，适配 HaoQingAiDigMan 架构
- 使用 playwright (非 patchright)
- 导入路径使用 sau_utils
"""
from datetime import datetime

import asyncio
import base64
import inspect
import json
import os
import re
from pathlib import Path

from playwright.async_api import Page, Playwright, async_playwright

from conf import DEBUG_MODE, LOCAL_CHROME_HEADLESS, LOCAL_CHROME_PATH
from uploader.base_video import BaseVideoUploader
from sau_utils.base_social_media import set_init_script
from sau_utils.interactive_browser import InteractiveBrowser
from sau_utils.login_qrcode import build_login_qrcode_path, decode_qrcode_from_path, \
    print_terminal_qrcode, remove_qrcode_file, save_data_url_image
from sau_utils.log import douyin_logger

DOUYIN_PUBLISH_STRATEGY_IMMEDIATE = "immediate"
DOUYIN_PUBLISH_STRATEGY_SCHEDULED = "scheduled"
DOUYIN_UPLOAD_URL = "https://creator.douyin.com/creator-micro/content/upload"
DOUYIN_AUTH_COOKIE_NAMES = {
    "sessionid", "sessionid_ss", "sid_guard", "sid_tt", "uid_tt", "uid_tt_ss",
}


def _msg(emoji: str, text: str) -> str:
    return f"{emoji} {text}"


async def _goto_douyin(page: Page, url: str, timeout: int = 60000):
    # The creator page keeps background resources open for a long time. Waiting
    # for the full load event makes healthy login pages look like timeouts.
    return await page.goto(url, wait_until="commit", timeout=timeout)


async def _emit_qrcode_callback(qrcode_callback, payload: dict):
    if not qrcode_callback:
        return
    callback_result = qrcode_callback(payload)
    if inspect.isawaitable(callback_result):
        await callback_result


def _build_login_result(success: bool, status: str, message: str, account_file: str, qrcode: dict | None = None, current_url: str = "") -> dict:
    return {
        "success": success,
        "status": status,
        "message": message,
        "account_file": str(account_file),
        "qrcode": qrcode,
        "current_url": current_url,
    }


def _build_launch_kwargs(headless: bool) -> dict:
    launch_kwargs = {"headless": headless}
    if LOCAL_CHROME_PATH:
        launch_kwargs["executable_path"] = LOCAL_CHROME_PATH
    show_browser = os.getenv("IP_AGENT_PUBLISH_SHOW_BROWSER", "").strip().lower() in {"1", "true", "yes", "on"}
    if not headless and not show_browser:
        # Douyin rejects true headless login in some risk-control flows. Keep a
        # headed renderer, but place it outside the visible desktop so the web
        # authorization dialog remains the only user-facing surface.
        launch_kwargs["args"] = [
            "--window-position=-32000,-32000",
            "--window-size=1280,900",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
            "--disable-background-timer-throttling",
            "--no-first-run",
            "--no-default-browser-check",
        ]
    return launch_kwargs


def _get_douyin_profile_dir() -> Path:
    configured = os.getenv("IP_AGENT_PUBLISH_BROWSER_PROFILE_ROOT", "").strip()
    root = Path(configured).resolve() if configured else Path(__file__).resolve().parents[2] / "Chrome" / "UserData"
    return root / "douyin_publish"


async def _launch_douyin_profile_context(playwright: Playwright, headless: bool, **kwargs):
    profile_dir = _get_douyin_profile_dir()
    profile_dir.mkdir(parents=True, exist_ok=True)
    launch_kwargs = _build_launch_kwargs(headless=headless)
    launch_kwargs.update(kwargs)
    return await playwright.chromium.launch_persistent_context(str(profile_dir), **launch_kwargs)


async def _seed_context_from_account_file(context, account_file: str):
    if not account_file or not os.path.exists(account_file):
        return
    try:
        with open(account_file, "r", encoding="utf-8") as f:
            state = json.load(f)
        cookies = state.get("cookies", []) if isinstance(state, dict) else []
        if cookies:
            await context.add_cookies(cookies)
    except Exception as exc:
        douyin_logger.warning(_msg("⚠️", f"导入抖音 cookie 到固定浏览器环境失败: {exc}"))


async def _has_douyin_auth_cookie(context) -> bool:
    cookies = await context.cookies(["https://creator.douyin.com/", "https://www.douyin.com/"])
    return any(cookie.get("name") in DOUYIN_AUTH_COOKIE_NAMES and cookie.get("value") for cookie in cookies)


async def _check_douyin_login_context(context, account_file: str | None = None) -> bool:
    page = await context.new_page()
    try:
        await _goto_douyin(page, DOUYIN_UPLOAD_URL)
        try:
            await page.wait_for_url(DOUYIN_UPLOAD_URL, wait_until="commit", timeout=5000)
        except Exception:
            return False
        await page.wait_for_timeout(1500)
        if not await _is_douyin_login_completed(page):
            return False

        if account_file:
            Path(account_file).parent.mkdir(parents=True, exist_ok=True)
            await context.storage_state(path=account_file)
        return True
    finally:
        await page.close()


async def cookie_auth(account_file):
    async with async_playwright() as playwright:
        context = await _launch_douyin_profile_context(playwright, headless=True)
        try:
            context = await set_init_script(context)
            if await _check_douyin_login_context(context, account_file):
                return True
            await _seed_context_from_account_file(context, account_file)
            if await _check_douyin_login_context(context, account_file):
                return True
        finally:
            await context.close()

        if not os.path.exists(account_file):
            return False

        browser = await playwright.chromium.launch(**_build_launch_kwargs(headless=True))
        try:
            context = await browser.new_context(storage_state=account_file)
            context = await set_init_script(context)
            return await _check_douyin_login_context(context, account_file)
        finally:
            await browser.close()


async def douyin_setup(account_file, handle=False, return_detail=False, qrcode_callback=None, headless: bool = LOCAL_CHROME_HEADLESS):
    if not os.path.exists(account_file) or not await cookie_auth(account_file):
        if not handle:
            result = _build_login_result(False, "cookie_invalid", "cookie文件不存在或已失效", account_file)
            return result if return_detail else False
        douyin_logger.info(_msg("🥹", "cookie 失效了，准备打开浏览器重新登录"))
        result = await douyin_cookie_gen(account_file, qrcode_callback=qrcode_callback, headless=headless)
        return result if return_detail else result["success"]

    result = _build_login_result(True, "cookie_valid", "cookie有效", account_file)
    return result if return_detail else True


async def _extract_douyin_qrcode_src(page: Page) -> str:
    scan_login_tab = page.get_by_text("扫码登录", exact=True).first
    await scan_login_tab.wait_for(timeout=30000)

    qrcode_img = (
        scan_login_tab
        .locator("..")
        .locator("xpath=following-sibling::div[1]")
        .locator('img[aria-label="二维码"]')
        .first
    )

    if not await qrcode_img.count():
        qrcode_img = page.get_by_role("img", name="二维码").first

    await qrcode_img.wait_for(state="visible", timeout=30000)
    src = await qrcode_img.get_attribute("src")
    if not src:
        raise RuntimeError("未获取到抖音登录二维码地址")

    return src


async def _save_douyin_qrcode(page: Page, account_file: str, previous_qrcode_path: Path | None = None, qrcode_callback=None) -> dict:
    qrcode_src = await _extract_douyin_qrcode_src(page)
    qrcode_path = save_data_url_image(qrcode_src, build_login_qrcode_path(account_file))
    if previous_qrcode_path and previous_qrcode_path != qrcode_path:
        if remove_qrcode_file(previous_qrcode_path):
            douyin_logger.info(_msg("🧹", f"临时二维码文件已清理: {previous_qrcode_path}"))
    douyin_logger.info(_msg("🖼️", f"二维码已经准备好啦，已保存到: {qrcode_path}"))
    qrcode_content = decode_qrcode_from_path(qrcode_path)
    if qrcode_content:
        print_terminal_qrcode(qrcode_content, qrcode_path, "抖音APP")
    else:
        douyin_logger.warning(_msg("😵", f"终端没法完整显示二维码，请打开 {qrcode_path} 扫码"))
    qrcode_info = {
        "image_path": str(qrcode_path),
        "image_data_url": qrcode_src,
    }
    await _emit_qrcode_callback(qrcode_callback, qrcode_info)
    return qrcode_info


async def _visible(locator) -> bool:
    if not await locator.count():
        return False
    try:
        return await locator.is_visible()
    except Exception:
        return False


def _read_verification_commands() -> list[dict]:
    configured = os.getenv("IP_AGENT_PUBLISH_CONTROL_DIR", "").strip()
    if not configured:
        return []
    root = Path(configured)
    if not root.is_dir():
        return []
    commands = []
    for command_file in sorted(root.glob("verification-command-*.json")):
        try:
            if command_file.stat().st_size > 16_384:
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


async def _identity_verification_root(page: Page):
    title = await _first_visible_text(page, re.compile(r"身份\s*验证|安全\s*验证|登录\s*验证"))
    if title is None:
        return None
    dialog = title.locator("xpath=ancestor::*[@role='dialog'][1]")
    if await _visible(dialog):
        return dialog
    modal = title.locator("xpath=ancestor::div[contains(@class, 'modal')][1]")
    if await _visible(modal):
        return modal
    return page.locator("body")


async def _first_visible_text(root, pattern: re.Pattern):
    candidates = root.get_by_text(pattern)
    for index in range(await candidates.count()):
        candidate = candidates.nth(index)
        if await _visible(candidate):
            return candidate
    return None


async def _identity_verification_methods(root) -> dict:
    sms = await _first_visible_text(root, re.compile(r"手机验证码|短信验证码|短信验证|手机号验证|手机验证"))
    face = await _first_visible_text(root, re.compile(r"手机刷脸验证|刷脸验证|人脸验证"))
    methods = {}
    if sms is not None:
        methods["sms"] = sms
    elif await _find_verification_input(root) is not None:
        methods["sms"] = None
    if face is not None:
        methods["face"] = face
    return methods


async def _emit_verification_state(qrcode_callback, state: dict, methods: dict, stage: str, message: str, can_resend: bool = False):
    payload = {
        "event_type": "verification",
        "methods": [{"id": method_id} for method_id in methods],
        "selected_method": state.get("selected_method") or "",
        "stage": stage,
        "can_resend": can_resend,
        "phone_hint": state.get("phone_hint") or "",
        "message": message,
    }
    signature = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    if signature == state.get("last_event"):
        return
    state["last_event"] = signature
    await _emit_qrcode_callback(qrcode_callback, payload)


async def _find_verification_input(root):
    selectors = [
        'input[placeholder*="验证码"]',
        'input[aria-label*="验证码"]',
        'input[name*="code" i]',
    ]
    for selector in selectors:
        inputs = root.locator(selector)
        for index in range(await inputs.count()):
            candidate = inputs.nth(index)
            if await _visible(candidate):
                return candidate
    return None


async def _click_visible_text(root, pattern: re.Pattern) -> bool:
    candidate = await _first_visible_text(root, pattern)
    if candidate is None:
        return False
    try:
        await candidate.click()
        return True
    except Exception:
        return False


async def _capture_identity_face_qrcode(root, account_file: str, previous_qrcode_path: Path | None = None, qrcode_callback=None) -> dict | None:
    target = build_login_qrcode_path(account_file, suffix="douyin_identity_verification")
    for selector in ("canvas", "img"):
        candidates = root.locator(selector)
        for index in range(await candidates.count()):
            candidate = candidates.nth(index)
            if not await _visible(candidate):
                continue
            box = await candidate.bounding_box()
            if not box or min(box["width"], box["height"]) < 120:
                continue
            image_bytes = await candidate.screenshot(type="png")
            target.write_bytes(image_bytes)
            if not decode_qrcode_from_path(target):
                continue
            if previous_qrcode_path and previous_qrcode_path != target:
                remove_qrcode_file(previous_qrcode_path)
            image_data_url = f"data:image/png;base64,{base64.b64encode(image_bytes).decode('ascii')}"
            qrcode_info = {"image_path": str(target), "image_data_url": image_data_url, "purpose": "identity_face"}
            await _emit_qrcode_callback(qrcode_callback, qrcode_info)
            douyin_logger.info(_msg("📱", "身份验证二维码已回传，请在手机端完成人脸验证"))
            return qrcode_info
    return None


async def _handle_identity_verification(page: Page, account_file: str, state: dict, previous_qrcode_path: Path | None = None, qrcode_callback=None) -> dict | None:
    root = await _identity_verification_root(page)
    if root is None:
        return None
    methods = await _identity_verification_methods(root)

    if not state.get("detected"):
        state["detected"] = True
        state["last_event"] = None
        douyin_logger.info(_msg("🔐", "检测到身份验证，正在同步到项目授权弹窗"))
        await _emit_verification_state(qrcode_callback, state, methods, "method_required", "检测到身份验证，正在读取可用验证方式")

    if not methods:
        return None
    if state.get("selected_method") not in methods:
        state["selected_method"] = "sms" if "sms" in methods else next(iter(methods))
        state["clicked_method"] = None
        state["last_event"] = None
        douyin_logger.info(_msg("🔐", f"可用身份验证方式: {', '.join(methods)}"))

    pending_code = state.get("pending_code")
    resend_requested = False
    for command in _read_verification_commands():
        action = str(command.get("action") or "")
        if action == "select_method":
            method = str(command.get("method") or "").lower()
            if method in methods:
                state["selected_method"] = method
                state["sms_requested"] = False
                state["code_submitted"] = False
                state["last_event"] = None
        elif action == "resend_code" and "sms" in methods:
            state["selected_method"] = "sms"
            state["sms_requested"] = False
            state["code_submitted"] = False
            resend_requested = True
        elif action == "submit_code":
            code = re.sub(r"\s+", "", str(command.get("code") or ""))
            if re.fullmatch(r"\d{4,8}", code):
                state["selected_method"] = "sms"
                pending_code = code
                state["pending_code"] = code

    selected_method = state.get("selected_method")
    selected_option = methods.get(selected_method)
    if selected_option is not None and state.get("clicked_method") != selected_method:
        try:
            await selected_option.click()
            await page.wait_for_timeout(600)
            state["clicked_method"] = selected_method
        except Exception:
            pass

    if selected_method == "sms":
        refreshed_root = await _identity_verification_root(page)
        if refreshed_root is not None:
            root = refreshed_root
        root_text = await root.inner_text()
        phone_match = re.search(r"1\d{2}\*{2,}\d{2,4}", root_text)
        if phone_match:
            state["phone_hint"] = phone_match.group(0)
        send_pattern = re.compile(r"获取验证码|发送验证码|重新发送")
        if (not state.get("sms_requested") or resend_requested) and await _click_visible_text(root, send_pattern):
            state["sms_requested"] = True
            state["last_event"] = None
            await page.wait_for_timeout(500)

        verification_input = await _find_verification_input(root)
        if pending_code and verification_input is not None:
            await verification_input.fill(pending_code)
            state.pop("pending_code", None)
            pending_code = None
            submitted = await _click_visible_text(root, re.compile(r"^(确认|提交|验证|下一步|完成)$"))
            if not submitted:
                await verification_input.press("Enter")
            state["code_submitted"] = True
            state["last_event"] = None
            await _emit_verification_state(qrcode_callback, state, methods, "submitting", "验证码已提交，正在等待平台确认")
            return None

        error_match = re.search(r"验证码[^\n]{0,12}(?:错误|不正确|失效|过期)|(?:错误|无效)的验证码", root_text)
        if error_match:
            state["code_submitted"] = False
            state["last_event"] = None
            await _emit_verification_state(qrcode_callback, state, methods, "code_required", error_match.group(0), can_resend=True)
            return None
        if not state.get("code_submitted"):
            message = "验证码已发送，请输入绑定手机收到的验证码" if state.get("sms_requested") else "请选择手机验证码并获取验证码"
            await _emit_verification_state(qrcode_callback, state, methods, "code_required", message, can_resend=True)
        return None

    await _emit_verification_state(qrcode_callback, state, methods, "face_required", "请使用抖音手机端完成刷脸验证")
    if state.get("face_qrcode_captured"):
        return None
    verification_qrcode = await _capture_identity_face_qrcode(
        root,
        account_file,
        previous_qrcode_path=previous_qrcode_path,
        qrcode_callback=qrcode_callback,
    )
    if verification_qrcode:
        state["face_qrcode_captured"] = True
    return verification_qrcode


async def _is_douyin_login_completed(page: Page) -> bool:
    if await _identity_verification_root(page) is not None:
        return False
    current_url = page.url.lower()
    if not current_url.startswith("https://creator.douyin.com/") or any(token in current_url for token in ("/login", "passport")):
        return False
    if not await _has_douyin_auth_cookie(page.context):
        return False

    login_markers = [
        page.get_by_text("扫码登录", exact=True).first,
        page.get_by_text("手机号登录", exact=True).first,
        page.get_by_text("二维码失效", exact=True).first,
        page.get_by_role("img", name="二维码").first,
    ]

    for marker in login_markers:
        if not await marker.count():
            continue
        try:
            if await marker.is_visible():
                return False
        except Exception:
            continue

    return True


async def _wait_for_douyin_login(page: Page, account_file: str, qrcode_info: dict, qrcode_callback=None, poll_interval: int = 1, max_checks: int = 600) -> dict:
    qrcode_path = Path(qrcode_info["image_path"])
    interaction = InteractiveBrowser(qrcode_callback)
    verification_state = {
        "detected": False,
        "selected_method": None,
        "clicked_method": None,
        "sms_requested": False,
        "code_submitted": False,
        "face_qrcode_captured": False,
        "last_event": None,
    }
    for _ in range(max_checks):
        verification_qrcode = await _handle_identity_verification(
            page,
            account_file,
            verification_state,
            previous_qrcode_path=qrcode_path,
            qrcode_callback=qrcode_callback,
        )
        if verification_qrcode:
            qrcode_info = verification_qrcode
            qrcode_path = Path(qrcode_info["image_path"])

        if await _is_douyin_login_completed(page):
            douyin_logger.info(_msg("🥳", f"扫码成功，已经跳转到登录后页面: {page.url}"))
            return _build_login_result(True, "success", "抖音扫码登录成功", account_file, qrcode_info, page.url)

        expired_box = page.get_by_text("二维码失效", exact=True).locator("..").first
        if await expired_box.count() and await expired_box.is_visible():
            douyin_logger.warning(_msg("😵", "二维码失效了，小人马上去刷新"))
            await expired_box.click()
            await asyncio.sleep(1)
            qrcode_info = await _save_douyin_qrcode(page, account_file, qrcode_path, qrcode_callback=qrcode_callback)
            qrcode_path = Path(qrcode_info["image_path"])

        await interaction.wait(page, poll_interval)

    return _build_login_result(False, "timeout", "等待抖音扫码登录超时", account_file, qrcode_info, page.url)


async def douyin_cookie_gen(
    account_file,
    qrcode_callback=None,
    poll_interval: int = 1,
    max_checks: int = 600,
    headless: bool = LOCAL_CHROME_HEADLESS,
):
    async with async_playwright() as playwright:
        context = await _launch_douyin_profile_context(playwright, headless=headless)
        await _seed_context_from_account_file(context, account_file)
        context = await set_init_script(context)
        qrcode_path = None
        result = _build_login_result(False, "failed", "抖音登录失败", account_file)
        try:
            page = await context.new_page()
            await _goto_douyin(page, "https://creator.douyin.com/")
            if await _is_douyin_login_completed(page):
                await context.storage_state(path=account_file)
                return _build_login_result(True, "success", "抖音登录状态已恢复", account_file, current_url=page.url)
            qrcode_info = await _save_douyin_qrcode(page, account_file, qrcode_callback=qrcode_callback)
            qrcode_path = Path(qrcode_info["image_path"])
            douyin_logger.info(_msg("🧍", "请扫码，小人正在耐心等待登录完成"))
            result = await _wait_for_douyin_login(
                page, account_file, qrcode_info,
                qrcode_callback=qrcode_callback,
                poll_interval=poll_interval,
                max_checks=max_checks,
            )
            if result["success"]:
                await asyncio.sleep(2)
                await context.storage_state(path=account_file)
        except Exception as exc:
            result = _build_login_result(False, "failed", str(exc), account_file, current_url=page.url if "page" in locals() else "")
        finally:
            if remove_qrcode_file(qrcode_path):
                douyin_logger.info(_msg("🧹", f"临时二维码文件已清理: {qrcode_path}"))
            if not result["success"]:
                douyin_logger.error(_msg("😢", f"登录失败: {result['message']}"))
            await context.close()
        return result


class DouYinBaseUploader(BaseVideoUploader):
    def __init__(
        self,
        publish_date: datetime | int,
        account_file,
        publish_strategy: str = DOUYIN_PUBLISH_STRATEGY_IMMEDIATE,
        debug: bool = DEBUG_MODE,
        headless: bool = LOCAL_CHROME_HEADLESS,
    ):
        self.publish_date = publish_date
        self.account_file = account_file
        self.publish_strategy = publish_strategy
        self.debug = debug
        self.date_format = "%Y年%m月%d日 %H:%M"
        self.local_executable_path = LOCAL_CHROME_PATH
        self.headless = headless

    async def validate_base_args(self):
        if not await cookie_auth(self.account_file):
            raise RuntimeError(f"抖音登录态已失效，请先完成抖音登录: {self.account_file}")
        if self.publish_strategy not in {DOUYIN_PUBLISH_STRATEGY_IMMEDIATE, DOUYIN_PUBLISH_STRATEGY_SCHEDULED}:
            raise ValueError(f"不支持的发布策略: {self.publish_strategy}")

        if self.publish_strategy == DOUYIN_PUBLISH_STRATEGY_SCHEDULED:
            self.publish_date = self.validate_publish_date(self.publish_date)
        else:
            self.publish_date = 0

    async def set_schedule_time_douyin(self, page, publish_date):
        label_element = page.locator("[class^='radio']:has-text('定时发布')")
        await label_element.click()
        await asyncio.sleep(1)
        publish_date_hour = publish_date.strftime("%Y-%m-%d %H:%M")
        await asyncio.sleep(1)
        await page.locator('.semi-input[placeholder="日期和时间"]').click()
        await page.keyboard.press("Control+KeyA")
        await page.keyboard.type(str(publish_date_hour))
        await page.keyboard.press("Enter")
        await asyncio.sleep(1)

    async def fill_title_and_description(self, page: Page, title: str, description: str, tags: list = None):
        description_section = (
            page.get_by_text("作品描述", exact=True)
            .locator("xpath=ancestor::div[2]")
            .locator("xpath=following-sibling::div[1]")
        )

        title_input = description_section.locator('input[type="text"]').first
        await title_input.wait_for(state="visible", timeout=10000)
        await title_input.fill(title[:30])

        description_editor = description_section.locator('.zone-container[contenteditable="true"]').first
        await description_editor.wait_for(state="visible", timeout=10000)
        await description_editor.click()
        await page.keyboard.press("Control+KeyA")
        await page.keyboard.press("Delete")
        await page.keyboard.type(description)

        for tag in tags or []:
            await page.keyboard.type(" #" + tag)
            await page.keyboard.press("Space")

    async def set_location(self, page: Page, location: str = ""):
        if not location:
            return
        await page.locator('div.semi-select span:has-text("输入地理位置")').click()
        await page.keyboard.press("Backspace")
        await page.wait_for_timeout(2000)
        await page.keyboard.type(location)
        await page.wait_for_selector('div[role="listbox"] [role="option"]', timeout=5000)
        await page.locator('div[role="listbox"] [role="option"]').first.click()

    async def handle_product_dialog(self, page: Page, product_title: str):
        await page.wait_for_timeout(2000)
        await page.wait_for_selector('input[placeholder="请输入商品短标题"]', timeout=10000)
        short_title_input = page.locator('input[placeholder="请输入商品短标题"]')
        if not await short_title_input.count():
            douyin_logger.error(_msg("😵", "没找到商品短标题输入框"))
            return False

        product_title = product_title[:10]
        await short_title_input.fill(product_title)
        await page.wait_for_timeout(1000)

        finish_button = page.locator('button:has-text("完成编辑")')
        if "disabled" not in await finish_button.get_attribute("class"):
            await finish_button.click()
            douyin_logger.debug(_msg("🥳", '已点击"完成编辑"按钮'))
            await page.wait_for_selector(".semi-modal-content", state="hidden", timeout=5000)
            return True

        douyin_logger.error(_msg("😵", '"完成编辑"按钮是灰的，小人先把弹窗关掉'))
        cancel_button = page.locator('button:has-text("取消")')
        if await cancel_button.count():
            await cancel_button.click()
        else:
            close_button = page.locator(".semi-modal-close")
            await close_button.click()
        await page.wait_for_selector(".semi-modal-content", state="hidden", timeout=5000)
        return False

    async def set_product_link(self, page: Page, product_link: str, product_title: str):
        await page.wait_for_timeout(2000)
        try:
            await page.wait_for_selector("text=添加标签", timeout=10000)
            dropdown = page.get_by_text("添加标签").locator("..").locator("..").locator("..").locator(".semi-select").first
            if not await dropdown.count():
                douyin_logger.error(_msg("😵", "没找到标签下拉框"))
                return False
            await dropdown.click()
            await page.wait_for_selector('[role="listbox"]', timeout=5000)
            await page.locator('[role="option"]:has-text("购物车")').click()

            await page.wait_for_selector('input[placeholder="粘贴商品链接"]', timeout=5000)
            input_field = page.locator('input[placeholder="粘贴商品链接"]')
            await input_field.fill(product_link)

            add_button = page.locator('span:has-text("添加链接")')
            button_class = await add_button.get_attribute("class")
            if "disable" in button_class:
                douyin_logger.error(_msg("😵", '"添加链接"按钮现在点不了'))
                return False
            await add_button.click()

            await page.wait_for_timeout(2000)
            error_modal = page.locator("text=未搜索到对应商品")
            if await error_modal.count():
                confirm_button = page.locator('button:has-text("确定")')
                await confirm_button.click()
                douyin_logger.error(_msg("😢", "这个商品链接无效"))
                return False

            if not await self.handle_product_dialog(page, product_title):
                return False

            douyin_logger.debug(_msg("🥳", "商品链接设置好了"))
            return True
        except Exception as e:
            douyin_logger.error(_msg("😢", f"设置商品链接时出错: {str(e)}"))
            return False


class DouYinVideo(DouYinBaseUploader):
    def __init__(
        self,
        title,
        file_path,
        tags,
        publish_date: datetime | int,
        account_file,
        thumbnail_path=None,
        thumbnail_landscape_path=None,
        thumbnail_portrait_path=None,
        productLink="",
        productTitle="",
        desc: str | None = None,
        publish_strategy: str = DOUYIN_PUBLISH_STRATEGY_IMMEDIATE,
        debug: bool = DEBUG_MODE,
        headless: bool = LOCAL_CHROME_HEADLESS,
        is_draft: bool = False,
    ):
        super().__init__(
            publish_date=publish_date,
            account_file=account_file,
            publish_strategy=publish_strategy,
            debug=debug,
            headless=headless,
        )
        self.title = title
        self.file_path = file_path
        self.tags = tags
        # 兼容旧接口 thumbnail_path 和新接口 thumbnail_landscape_path
        self.thumbnail_landscape_path = thumbnail_landscape_path or thumbnail_path
        self.thumbnail_portrait_path = thumbnail_portrait_path
        self.productLink = productLink
        self.productTitle = productTitle
        self.desc = desc or ""
        self.is_draft = is_draft
        self.submit_wait = 3

    async def validate_upload_args(self):
        await self.validate_base_args()
        if not self.title or not str(self.title).strip():
            raise ValueError("视频模式下，title 是必须的")

        self.file_path = str(self.validate_video_file(self.file_path))
        if self.thumbnail_landscape_path:
            self.thumbnail_landscape_path = str(self.validate_image_file(self.thumbnail_landscape_path))
        if self.thumbnail_portrait_path:
            self.thumbnail_portrait_path = str(self.validate_image_file(self.thumbnail_portrait_path))

    async def wait_for_draft_save(self, page: Page, context, timeout_seconds: int = 60) -> None:
        deadline = asyncio.get_running_loop().time() + timeout_seconds
        while asyncio.get_running_loop().time() < deadline:
            current_url = page.url or ""
            if "content/manage" in current_url or "draft" in current_url:
                await context.storage_state(path=self.account_file)
                douyin_logger.success(_msg("OK", "检测到抖音草稿已保存"))
                return
            try:
                body_text = await page.locator("body").inner_text(timeout=1000)
                if any(keyword in body_text for keyword in ("保存成功", "草稿保存成功", "已保存", "草稿箱")):
                    await context.storage_state(path=self.account_file)
                    douyin_logger.success(_msg("OK", "检测到抖音草稿已保存"))
                    return
            except Exception:
                pass
            await asyncio.sleep(2)
        raise RuntimeError("抖音草稿保存后未检测到成功状态")

    async def save_draft(self, page: Page, context) -> None:
        selectors = (
            'button:has-text("保存草稿")',
            'button:has-text("存草稿")',
            '[role="button"]:has-text("保存草稿")',
            '[role="button"]:has-text("存草稿")',
        )
        for selector in selectors:
            button = page.locator(selector).first
            try:
                clickable = await button.count() and await button.is_visible() and await button.is_enabled()
            except Exception:
                continue
            if not clickable:
                continue
            await button.click()
            douyin_logger.info(_msg("OK", "已提交抖音草稿保存"))
            await self.wait_for_draft_save(page, context)
            return
        raise RuntimeError("未找到抖音保存草稿按钮，平台页面可能已经改版")

    async def handle_upload_error(self, page):
        douyin_logger.warning(_msg("😵", "视频上传摔了一跤，小人马上重新上传"))
        await page.locator('div.progress-div [class^="upload-btn-input"]').set_input_files(self.file_path)

    async def handle_auto_video_cover(self, page):
        if await page.get_by_text("请设置封面后再发布").first.is_visible():
            douyin_logger.info(_msg("🧍", "发布前还得先把封面弄好"))
            recommend_cover = page.locator('[class^="recommendCover-"]').first
            if await recommend_cover.count():
                douyin_logger.info(_msg("🏃", "小人去选第一个推荐封面"))
                try:
                    await recommend_cover.click()
                    await asyncio.sleep(1)
                    confirm_text = "是否确认应用此封面？"
                    if await page.get_by_text(confirm_text).first.is_visible():
                        await page.get_by_role("button", name="确定").click()
                        await asyncio.sleep(1)
                    return True
                except Exception as e:
                    douyin_logger.warning(_msg("😵", f"推荐封面没选成功: {e}"))
        return False

    async def set_thumbnail(self, page: Page):
        if not self.thumbnail_landscape_path and not self.thumbnail_portrait_path:
            return

        douyin_logger.info(_msg("🏃", "小人正在设置视频封面"))
        await page.click('text="选择封面"')
        cover_locator_str = 'div[id*="creator-content-modal"]'
        cover_locator = page.locator(cover_locator_str)
        await page.wait_for_selector(cover_locator_str)

        upload_input = cover_locator.locator("div[class^='semi-upload upload'] >> input.semi-upload-hidden-input")

        if self.thumbnail_landscape_path:
            await page.wait_for_timeout(1000)
            await upload_input.set_input_files(self.thumbnail_landscape_path)
            await page.wait_for_timeout(2000)
            douyin_logger.info(_msg("🖼️", "横版封面上传完成"))

        if self.thumbnail_portrait_path:
            await cover_locator.locator("div[class*='steps'] div").nth(1).click()
            await page.wait_for_timeout(1000)
            await upload_input.set_input_files(self.thumbnail_portrait_path)
            await page.wait_for_timeout(2000)
            douyin_logger.info(_msg("🖼️", "竖版封面上传完成"))

        await cover_locator.locator('button:visible:has-text("完成")').click()
        douyin_logger.info(_msg("🥳", "视频封面设置完成"))
        await page.wait_for_selector("div.extractFooter", state="detached")

    async def upload(self, playwright: Playwright) -> None:
        douyin_logger.info(_msg("🧍", "小人先检查 cookie、视频文件、封面和发布时间"))
        await self.validate_upload_args()
        douyin_logger.info(_msg("🥳", "上传前检查通过"))

        context = await _launch_douyin_profile_context(
            playwright,
            headless=self.headless,
            permissions=["geolocation"],
        )
        await _seed_context_from_account_file(context, self.account_file)
        context = await set_init_script(context)

        context_closed = False
        try:
            page = await context.new_page()
            await _goto_douyin(page, DOUYIN_UPLOAD_URL)
            douyin_logger.info(_msg("🏃", f"小人开始搬运视频: {self.title}.mp4"))
            await page.wait_for_url(DOUYIN_UPLOAD_URL, wait_until="commit")
            await page.locator("div[class^='container'] input").set_input_files(self.file_path)

            while True:
                try:
                    await page.wait_for_url(
                        "https://creator.douyin.com/creator-micro/content/publish?enter_from=publish_page",
                        wait_until="commit",
                        timeout=3000,
                    )
                    douyin_logger.info(_msg("🥳", "已经进入 version_1 发布页面"))
                    break
                except Exception:
                    try:
                        await page.wait_for_url(
                            "https://creator.douyin.com/creator-micro/content/post/video?enter_from=publish_page",
                            wait_until="commit",
                            timeout=3000,
                        )
                        douyin_logger.info(_msg("🥳", "已经进入 version_2 发布页面"))
                        break
                    except Exception:
                        douyin_logger.debug(_msg("🧍", "还没进到视频发布页面，小人继续等一会"))
                        await asyncio.sleep(0.5)

            await asyncio.sleep(1)
            douyin_logger.info(_msg("✍️", "小人开始填标题、描述和话题"))
            await self.fill_title_and_description(page, self.title, self.desc or self.title, self.tags)
            douyin_logger.info(_msg("🏷️", f"小人一共贴了 {len(self.tags)} 个话题"))

            while True:
                try:
                    number = await page.locator('[class^="long-card"] div:has-text("重新上传")').count()
                    if number > 0:
                        douyin_logger.success(_msg("🥳", "视频已经传完啦"))
                        break
                    douyin_logger.info(_msg("🏃", "小人正在努力上传视频"))
                    await asyncio.sleep(2)
                    if await page.locator('div.progress-div > div:has-text("上传失败")').count():
                        douyin_logger.error(_msg("😵", "检测到上传失败，小人准备重试"))
                        await self.handle_upload_error(page)
                except Exception:
                    douyin_logger.debug(_msg("🧍", "小人还在等视频上传完成"))
                    await asyncio.sleep(2)

            if self.productLink and self.productTitle:
                douyin_logger.info(_msg("🛒", "小人正在设置商品链接"))
                await self.set_product_link(page, self.productLink, self.productTitle)

            await self.set_thumbnail(page)

            third_part_element = '[class^="info"] > [class^="first-part"] div div.semi-switch'
            if await page.locator(third_part_element).count():
                if "semi-switch-checked" not in await page.eval_on_selector(third_part_element, "div => div.className"):
                    await page.locator(third_part_element).locator("input.semi-switch-native-control").click()

            if self.publish_strategy == DOUYIN_PUBLISH_STRATEGY_SCHEDULED and self.publish_date != 0:
                await self.set_schedule_time_douyin(page, self.publish_date)

            await asyncio.sleep(self.submit_wait)

            if self.is_draft:
                await self.save_draft(page, context)
                await asyncio.sleep(2)
                await context.close()
                context_closed = True
                return

            while True:
                try:
                    publish_button = page.get_by_role("button", name="发布", exact=True)
                    if await publish_button.count():
                        await publish_button.click()
                    await page.wait_for_url(
                        "https://creator.douyin.com/creator-micro/content/manage**",
                        wait_until="commit",
                        timeout=3000,
                    )
                    douyin_logger.success(_msg("🥳", "视频发布成功，小人开心收工"))
                    break
                except Exception:
                    await self.handle_auto_video_cover(page)
                    douyin_logger.info(_msg("🏃", "小人正在冲刺发布视频"))
                    if self.debug:
                        await page.screenshot(full_page=True)
                    await asyncio.sleep(0.5)

            await context.storage_state(path=self.account_file)
            douyin_logger.success(_msg("🥳", "cookie 更新完毕"))
            await asyncio.sleep(2)
            await context.close()
            context_closed = True
        finally:
            if not context_closed:
                await context.close()

    async def main(self):
        async with async_playwright() as playwright:
            await self.upload(playwright)
