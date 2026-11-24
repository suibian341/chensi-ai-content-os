# -*- coding: utf-8 -*-
"""
视频号（微信）视频上传模块
同步自 social-auto-upload (2026.05) 最新版，适配 HaoQingAiDigMan 架构
- 使用 playwright (非 patchright)
- 导入路径使用 sau_utils
"""
from __future__ import annotations

import asyncio
import inspect
import os
from datetime import datetime
from pathlib import Path

from playwright.async_api import Page, Playwright, async_playwright

from conf import BASE_DIR, DEBUG_MODE, LOCAL_CHROME_HEADLESS, LOCAL_CHROME_PATH
from uploader.base_video import BaseVideoUploader
from sau_utils.base_social_media import set_init_script
from sau_utils.interactive_browser import InteractiveBrowser
from sau_utils.log import tencent_logger

TENCENT_LOGIN_URL = "https://channels.weixin.qq.com"
TENCENT_UPLOAD_URL = "https://channels.weixin.qq.com/platform/post/create"
TENCENT_MANAGE_URL = "https://channels.weixin.qq.com/platform/post/list"
TENCENT_PUBLISH_STRATEGY_IMMEDIATE = "immediate"
TENCENT_PUBLISH_STRATEGY_SCHEDULED = "scheduled"


def _msg(emoji: str, text: str) -> str:
    return f"{emoji} {text}"


def _resolve_account_file(account_file: str | Path) -> str:
    path = Path(account_file).expanduser()
    if path.is_absolute():
        return str(path)
    if len(path.parts) == 1:
        return str((Path(BASE_DIR) / "cookies" / "tencent_uploader" / path).resolve())
    return str(path.resolve())


def _build_launch_kwargs(headless: bool) -> dict:
    launch_kwargs = {"headless": headless, "args": ["--lang=zh-CN"]}
    if LOCAL_CHROME_PATH:
        launch_kwargs["executable_path"] = LOCAL_CHROME_PATH
    return launch_kwargs


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


def _get_qrcode_utils():
    from sau_utils.login_qrcode import build_login_qrcode_path, decode_qrcode_from_path, \
        print_terminal_qrcode, remove_qrcode_file, save_data_url_image
    return {
        "build_login_qrcode_path": build_login_qrcode_path,
        "decode_qrcode_from_path": decode_qrcode_from_path,
        "print_terminal_qrcode": print_terminal_qrcode,
        "remove_qrcode_file": remove_qrcode_file,
        "save_data_url_image": save_data_url_image,
    }


def format_str_for_short_title(origin_title: str) -> str:
    allowed_special_chars = "《》"":+?%°"
    filtered_chars = [char if char.isalnum() or char in allowed_special_chars else " " if char == "," else "" for char in origin_title]
    formatted_string = "".join(filtered_chars)
    if len(formatted_string) > 16:
        formatted_string = formatted_string[:16]
    elif len(formatted_string) < 6:
        formatted_string += " " * (6 - len(formatted_string))
    return formatted_string


async def cookie_auth(account_file):
    account_file = _resolve_account_file(account_file)
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(**_build_launch_kwargs(headless=True))
        try:
            context = await browser.new_context(storage_state=account_file, locale="zh-CN")
            context = await set_init_script(context)
            page = await context.new_page()
            await page.goto(TENCENT_UPLOAD_URL)
            await page.wait_for_url(TENCENT_UPLOAD_URL, timeout=5000)

            login_marker = page.get_by_text("扫码登录", exact=True).first
            if await login_marker.count():
                tencent_logger.info(_msg("🥹", "cookie 已失效，得重新登录一下"))
                return False

            tencent_logger.success(_msg("🥳", "cookie 有效"))
            return True
        except Exception as exc:
            tencent_logger.warning(_msg("😵", f"cookie 校验时出错，按失效处理: {exc}"))
            return False
        finally:
            await browser.close()


async def _find_tencent_qrcode_locator(page: Page):
    selector_candidates = (
        "img.js_qrcode_img",
        "img.web_qrcode_img",
        'img[src*="/connect/qrcode/"]',
        "div#app img.qrcode",
        "div.login-qrcode-wrap img.qrcode",
        "div.qrcode-wrap img.qrcode",
        "img.qrcode",
        'img[src^="data:image/"]',
    )
    deadline = asyncio.get_running_loop().time() + 30
    next_retry_at = 0
    while asyncio.get_running_loop().time() < deadline:
        for frame in page.frames:
            for selector in selector_candidates:
                for candidate in await frame.locator(selector).all():
                    try:
                        if await candidate.is_visible():
                            return candidate
                    except Exception:
                        continue
        now = asyncio.get_running_loop().time()
        if now >= next_retry_at:
            for retry_text in ("加载失败，点击重试", "Load failed", "Failed to load"):
                retry = page.get_by_text(retry_text, exact=False).first
                try:
                    if await retry.count() and await retry.is_visible():
                        await retry.click(force=True)
                        next_retry_at = now + 3
                        await page.wait_for_timeout(750)
                        break
                except Exception:
                    continue
        await page.wait_for_timeout(250)
    raise RuntimeError("未在视频号登录页面找到可见二维码")


async def _save_tencent_qrcode(page: Page, account_file: str, previous_qrcode_path: Path | None = None, qrcode_callback=None) -> dict:
    qrcode_utils = _get_qrcode_utils()
    qrcode_locator = await _find_tencent_qrcode_locator(page)
    qrcode_src = await qrcode_locator.get_attribute("src") or ""
    resolved_qrcode_src = await qrcode_locator.evaluate(
        "element => element.currentSrc || element.src || element.getAttribute('src') || ''"
    )
    qrcode_path = qrcode_utils["build_login_qrcode_path"](account_file, suffix="tencent_login_qrcode")
    if qrcode_src.startswith("data:image/"):
        qrcode_utils["save_data_url_image"](qrcode_src, qrcode_path)
    elif str(resolved_qrcode_src).startswith(("http://", "https://")):
        response = await page.context.request.get(str(resolved_qrcode_src), timeout=30000)
        if not response.ok:
            raise RuntimeError(f"视频号登录二维码下载失败: HTTP {response.status}")
        qrcode_path.parent.mkdir(parents=True, exist_ok=True)
        qrcode_path.write_bytes(await response.body())
    else:
        qrcode_path.parent.mkdir(parents=True, exist_ok=True)
        await qrcode_locator.screenshot(path=str(qrcode_path))
    if previous_qrcode_path and previous_qrcode_path != qrcode_path:
        if qrcode_utils["remove_qrcode_file"](previous_qrcode_path):
            tencent_logger.info(_msg("🧹", f"临时二维码文件已清理: {previous_qrcode_path}"))

    tencent_logger.info(_msg("🖼️", f"二维码已经准备好啦，已保存到: {qrcode_path}"))
    qrcode_content = qrcode_utils["decode_qrcode_from_path"](qrcode_path)
    if qrcode_content:
        qrcode_utils["print_terminal_qrcode"](qrcode_content, qrcode_path, "微信")
    else:
        tencent_logger.warning(_msg("😵", f"没能从二维码图片里解析出可打印内容，请直接打开 {qrcode_path} 扫码"))

    qrcode_info = {
        "image_path": str(qrcode_path),
        "image_data_url": qrcode_src if qrcode_src.startswith("data:image/") else "",
    }
    await _emit_qrcode_callback(qrcode_callback, qrcode_info)
    return qrcode_info


async def _is_tencent_login_completed(page: Page) -> bool:
    publish_markers = [
        page.locator('div:has-text("发表视频")').first,
        page.locator('button:has-text("发表")').first,
        page.locator('button:has-text("保存草稿")').first,
    ]
    for marker in publish_markers:
        try:
            if await marker.count() and await marker.is_visible():
                return True
        except Exception:
            continue

    if not (page.url.startswith(TENCENT_UPLOAD_URL) or page.url.startswith(TENCENT_MANAGE_URL)):
        return False

    login_markers = [
        page.locator("div.login-qrcode-wrap").first,
        page.locator("div.qrcode-wrap").first,
        page.locator("img.qrcode").first,
    ]
    for marker in login_markers:
        try:
            if await marker.count() and await marker.is_visible():
                return False
        except Exception:
            continue

    return True


async def _is_tencent_qrcode_expired(page: Page) -> bool:
    tip_selectors = [
        'div.mask.show p.refresh-tip:has-text("二维码已过期，点击刷新")',
        'p.refresh-tip:has-text("二维码已过期，点击刷新")',
        'p.refresh-tip:has-text("网络不可用，点击刷新")',
    ]
    for selector in tip_selectors:
        tip = page.locator(selector).first
        try:
            if await tip.count() and await tip.is_visible():
                return True
        except Exception:
            continue
    return False


async def _refresh_tencent_qrcode(page: Page) -> None:
    visible_refresh_selectors = [
        "div.login-qrcode-wrap div.mask.show div.refresh-wrap",
        "div.login-qrcode-wrap div.mask.show .refresh-wrap",
    ]
    for selector in visible_refresh_selectors:
        refresh_wrap = page.locator(selector).first
        try:
            if not await refresh_wrap.count() or not await refresh_wrap.is_visible():
                continue
            await refresh_wrap.click()
            return
        except Exception:
            continue

    fallback_refresh = page.locator("div.login-qrcode-wrap div.refresh-wrap").first
    if await fallback_refresh.count():
        await fallback_refresh.click()
        return

    raise RuntimeError("未找到可点击的视频号二维码刷新区域")


async def _wait_for_tencent_login(page: Page, account_file: str, qrcode_info: dict, qrcode_callback=None, poll_interval: int = 3, max_checks: int = 100) -> dict:
    qrcode_path = Path(qrcode_info["image_path"])
    interaction = InteractiveBrowser(qrcode_callback)
    for _ in range(max_checks):
        if await _is_tencent_login_completed(page):
            tencent_logger.info(_msg("🥳", f"扫码成功，已经跳转到登录后页面: {page.url}"))
            return _build_login_result(True, "success", "视频号扫码登录成功", account_file, qrcode_info, page.url)

        if await _is_tencent_qrcode_expired(page):
            tencent_logger.warning(_msg("😵", "二维码失效了，小人马上去刷新"))
            await _refresh_tencent_qrcode(page)
            await asyncio.sleep(1)
            qrcode_info = await _save_tencent_qrcode(page, account_file, previous_qrcode_path=qrcode_path, qrcode_callback=qrcode_callback)
            qrcode_path = Path(qrcode_info["image_path"])

        await interaction.wait(page, poll_interval)

    return _build_login_result(False, "timeout", "等待视频号扫码登录超时", account_file, qrcode_info, page.url)


async def tencent_cookie_gen(
    account_file,
    qrcode_callback=None,
    poll_interval: int = 3,
    max_checks: int = 100,
    headless: bool = LOCAL_CHROME_HEADLESS,
):
    account_file = _resolve_account_file(account_file)
    Path(account_file).parent.mkdir(parents=True, exist_ok=True)

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(**_build_launch_kwargs(headless=headless))
        context = await browser.new_context(locale="zh-CN")
        qrcode_path = None
        result = _build_login_result(False, "failed", "视频号登录失败", account_file)
        try:
            page = await context.new_page()
            await page.goto(TENCENT_LOGIN_URL, wait_until="commit", timeout=60000)
            qrcode_info = await _save_tencent_qrcode(page, account_file, qrcode_callback=qrcode_callback)
            qrcode_path = Path(qrcode_info["image_path"])
            tencent_logger.info(_msg("🧍", "请扫码，小人正在耐心等待登录完成"))
            result = await _wait_for_tencent_login(
                page, account_file, qrcode_info,
                qrcode_callback=qrcode_callback,
                poll_interval=poll_interval,
                max_checks=max_checks,
            )
            if result["success"]:
                await asyncio.sleep(2)
                await context.storage_state(path=account_file)
            return result
        except Exception as exc:
            result = _build_login_result(False, "failed", str(exc), account_file, current_url=page.url if "page" in locals() else "")
            return result
        finally:
            qrcode_utils = _get_qrcode_utils()
            if qrcode_utils["remove_qrcode_file"](qrcode_path):
                tencent_logger.info(_msg("🧹", f"临时二维码文件已清理: {qrcode_path}"))
            if not result["success"]:
                tencent_logger.error(_msg("😢", f"登录失败: {result['message']}"))
            await context.close()
            await browser.close()


async def tencent_setup(account_file, handle=False, return_detail=False, qrcode_callback=None, headless: bool = LOCAL_CHROME_HEADLESS):
    account_file = _resolve_account_file(account_file)
    if not os.path.exists(account_file) or not await cookie_auth(account_file):
        if not handle:
            result = _build_login_result(False, "cookie_invalid", "cookie文件不存在或已失效", account_file)
            return result if return_detail else False
        tencent_logger.info(_msg("🥹", "cookie 失效了，准备打开浏览器重新登录"))
        result = await tencent_cookie_gen(account_file, qrcode_callback=qrcode_callback, headless=headless)
        return result if return_detail else result["success"]

    result = _build_login_result(True, "cookie_valid", "cookie有效", account_file)
    return result if return_detail else True


async def get_tencent_cookie(account_file, qrcode_callback=None, headless: bool = LOCAL_CHROME_HEADLESS):
    return await tencent_cookie_gen(account_file, qrcode_callback=qrcode_callback, headless=headless)


async def weixin_setup(account_file, handle=False, return_detail=False, qrcode_callback=None, headless: bool = LOCAL_CHROME_HEADLESS):
    return await tencent_setup(account_file, handle=handle, return_detail=return_detail, qrcode_callback=qrcode_callback, headless=headless)


class TencentVideo(BaseVideoUploader):
    def __init__(
        self,
        title,
        file_path,
        tags,
        publish_date: datetime | int,
        account_file,
        category=None,
        is_draft=False,
        desc: str | None = None,
        thumbnail_path: str | None = None,
        short_title: str | None = None,
        publish_strategy: str = TENCENT_PUBLISH_STRATEGY_IMMEDIATE,
        debug: bool = DEBUG_MODE,
        headless: bool = LOCAL_CHROME_HEADLESS,
    ):
        self.title = title
        self.file_path = file_path
        self.tags = tags or []
        self.publish_date = publish_date
        self.account_file = _resolve_account_file(account_file)
        self.category = category
        self.is_draft = is_draft
        self.desc = desc or ""
        self.thumbnail_path = thumbnail_path
        self.short_title = short_title
        self.publish_strategy = publish_strategy
        self.debug = debug
        self.headless = headless
        self.local_executable_path = LOCAL_CHROME_PATH
        self.submit_wait = 3

    async def validate_upload_args(self):
        if not os.path.exists(self.account_file):
            raise RuntimeError(f"cookie文件不存在，请先完成视频号登录: {self.account_file}")
        if not await cookie_auth(self.account_file):
            raise RuntimeError(f"cookie文件已失效，请先完成视频号登录: {self.account_file}")
        if not self.title or not str(self.title).strip():
            raise ValueError("视频模式下，title 是必须的")
        self.file_path = str(self.validate_video_file(self.file_path))
        if self.thumbnail_path:
            self.thumbnail_path = str(self.validate_image_file(self.thumbnail_path))

        if self.publish_strategy == TENCENT_PUBLISH_STRATEGY_SCHEDULED:
            self.publish_date = self.validate_publish_date(self.publish_date)
        else:
            self.publish_date = 0

    async def set_schedule_time_tencent(self, page: Page, publish_date: datetime):
        label_element = page.locator("label").filter(has_text="定时").nth(1)
        await label_element.click()
        await page.click('input[placeholder="请选择发表时间"]')

        current_month = publish_date.strftime("%m月")
        page_month = await page.inner_text('span.weui-desktop-picker__panel__label:has-text("月")')
        if page_month != current_month:
            await page.click("button.weui-desktop-btn__icon__right")

        elements = await page.query_selector_all("table.weui-desktop-picker__table a")
        for element in elements:
            if "weui-desktop-picker__disabled" in await element.evaluate("el => el.className"):
                continue
            text = await element.inner_text()
            if text.strip() == str(publish_date.day):
                await element.click()
                break

        await page.click('input[placeholder="请选择时间"]')
        await page.keyboard.press("Control+KeyA")
        await page.keyboard.type(publish_date.strftime("%H"))
        await page.locator("div.input-editor").click()

    async def handle_upload_error(self, page: Page) -> None:
        tencent_logger.info(_msg("😵", "视频出错了，重新上传中"))
        await page.locator('div.media-status-content div.tag-inner:has-text("删除")').click()
        await page.get_by_role("button", name="删除", exact=True).click()
        file_input = page.locator('input[type="file"]')
        await file_input.set_input_files(self.file_path)

    async def set_thumbnail(self, page: Page) -> None:
        if not self.thumbnail_path:
            return

        tencent_logger.info(_msg("🖼️", "小人准备设置封面"))
        cover_entry_selectors = [
            'div.vertical-cover-wrap:has-text("个人主页卡片"):has-text("3:4")',
            'div.vertical-cover-wrap:has-text("3:4")',
            'div.vertical-cover-wrap:has-text("个人主页卡片")',
        ]
        for selector in cover_entry_selectors:
            cover_entry = page.locator(selector).first
            try:
                if not await cover_entry.count():
                    continue
                await cover_entry.wait_for(state="visible", timeout=3000)
                await cover_entry.click()
                await page.wait_for_timeout(500)
                break
            except Exception:
                continue

        cover_dialog = page.locator("div.weui-desktop-dialog").filter(has_text="编辑个人主页卡片").first
        if not await cover_dialog.count():
            tencent_logger.info(_msg("🧍", "当前页面没有出现封面编辑弹窗，小人先跳过自定义封面"))
            return

        try:
            await cover_dialog.wait_for(state="visible", timeout=5000)
        except Exception:
            tencent_logger.warning(_msg("😵", "封面编辑弹窗暂时不可见，这次先跳过自定义封面"))
            return

        file_input = cover_dialog.locator('.single-cover-uploader-wrap input[type="file"]').first
        await file_input.wait_for(state="attached", timeout=10000)
        await file_input.set_input_files(self.thumbnail_path)
        await page.wait_for_timeout(1000)

        crop_dialog = page.locator("div.weui-desktop-dialog").filter(has_text="裁剪封面图").first
        if await crop_dialog.count():
            try:
                await crop_dialog.wait_for(state="visible", timeout=10000)
                crop_confirm_button = crop_dialog.locator(
                    'div.weui-desktop-dialog__ft button.weui-desktop-btn_primary:has-text("确定")'
                ).first
                if await crop_confirm_button.count():
                    await crop_confirm_button.wait_for(state="visible", timeout=5000)
                    await crop_confirm_button.click()
                    await page.wait_for_timeout(1000)
            except Exception as exc:
                tencent_logger.warning(_msg("😵", f"封面裁剪确认时出错，小人继续尝试保存主弹窗: {exc}"))

        confirm_button = cover_dialog.locator(
            'div.weui-desktop-dialog__ft button.weui-desktop-btn_primary:has-text("确认")'
        ).first
        await confirm_button.wait_for(state="visible", timeout=10000)
        await confirm_button.click()
        tencent_logger.success(_msg("🥳", "封面已经设置完成"))

    async def add_short_title(self, page: Page):
        short_title_element = (
            page.get_by_text("短标题", exact=True)
            .locator("..")
            .locator("xpath=following-sibling::div")
            .locator('span input[type="text"]')
        )
        if await short_title_element.count():
            await short_title_element.fill(self.short_title or format_str_for_short_title(self.title))

    async def add_title_tags(self, page: Page):
        await page.locator("div.input-editor").click()
        await page.keyboard.type(self.title)
        await page.keyboard.press("Enter")
        for tag in self.tags:
            await page.keyboard.type("#" + tag)
            await page.keyboard.press("Space")
        if self.desc:
            await page.keyboard.press("Enter")
            await page.keyboard.type(self.desc)

    async def add_collection(self, page: Page):
        collection_elements = (
            page.get_by_text("添加到合集")
            .locator("xpath=following-sibling::div")
            .locator(".option-list-wrap > div")
        )
        if await collection_elements.count() > 1:
            await page.get_by_text("添加到合集").locator("xpath=following-sibling::div").click()
            await collection_elements.first.click()

    async def add_original(self, page: Page):
        if await page.get_by_label("视频为原创").count():
            await page.get_by_label("视频为原创").check()

        try:
            label_locator = await page.locator('label:has-text("我已阅读并同意 《视频号原创声明使用条款》")').is_visible()
        except Exception:
            label_locator = False

        if label_locator:
            await page.get_by_label("我已阅读并同意 《视频号原创声明使用条款》").check()
            await page.get_by_role("button", name="声明原创").click()

    async def detect_upload_status(self, page: Page):
        while True:
            try:
                publish_button = page.get_by_role("button", name="发表")
                button_class = await publish_button.get_attribute("class")
                if button_class and "weui-desktop-btn_disabled" not in button_class:
                    tencent_logger.info(_msg("🥳", "视频上传完毕"))
                    break
                tencent_logger.info(_msg("🏃", "正在上传视频中..."))
                await asyncio.sleep(2)

                upload_failed = await page.locator("div.status-msg.error").count()
                delete_button = await page.locator('div.media-status-content div.tag-inner:has-text("删除")').count()
                if upload_failed and delete_button:
                    tencent_logger.error(_msg("😵", "发现上传出错了，准备重试"))
                    await self.handle_upload_error(page)
            except Exception:
                tencent_logger.info(_msg("🏃", "正在上传视频中..."))
                await asyncio.sleep(2)

    async def wait_for_draft_save(self, page: Page, timeout_seconds: int = 60):
        deadline = asyncio.get_running_loop().time() + timeout_seconds
        while asyncio.get_running_loop().time() < deadline:
            current_url = page.url or ""
            if "post/list" in current_url or "draft" in current_url:
                tencent_logger.success(_msg("OK", "检测到视频号草稿已保存"))
                return
            try:
                body_text = await page.locator("body").inner_text(timeout=1000)
                if any(keyword in body_text for keyword in ("保存成功", "草稿保存成功", "已保存", "草稿箱")):
                    tencent_logger.success(_msg("OK", "检测到视频号草稿已保存"))
                    return
            except Exception:
                pass
            await asyncio.sleep(2)
        raise RuntimeError("视频号草稿保存后未检测到成功状态")

    async def save_draft(self, page: Page):
        selectors = (
            'div.form-btns button:has-text("保存草稿")',
            'button:has-text("保存草稿")',
            'button:has-text("存草稿")',
            '[role="button"]:has-text("保存草稿")',
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
            tencent_logger.info(_msg("OK", "已提交视频号草稿保存"))
            await self.wait_for_draft_save(page)
            return
        raise RuntimeError("未找到视频号保存草稿按钮，平台页面可能已经改版")

    async def click_publish(self, page: Page):
        if self.is_draft:
            await self.save_draft(page)
            return

        while True:
            try:
                publish_button = page.locator('div.form-btns button:has-text("发表")')
                if await publish_button.count():
                    await publish_button.click()
                await page.wait_for_url(TENCENT_MANAGE_URL, timeout=5000)
                tencent_logger.success(_msg("🥳", "视频发布成功"))
                break
            except Exception as exc:
                current_url = page.url
                if TENCENT_MANAGE_URL in current_url:
                    tencent_logger.success(_msg("🥳", "视频发布成功"))
                    break
                tencent_logger.info(_msg("🏃", "视频正在发布中..."))
                await asyncio.sleep(0.5)

    async def upload(self, playwright: Playwright) -> None:
        tencent_logger.info(_msg("🧍", "小人先检查 cookie、视频文件和发布时间"))
        await self.validate_upload_args()
        tencent_logger.info(_msg("🥳", "上传前检查通过"))

        browser = await playwright.chromium.launch(**_build_launch_kwargs(headless=self.headless))
        context = await browser.new_context(storage_state=self.account_file, locale="zh-CN")

        try:
            page = await context.new_page()
            await page.goto(TENCENT_UPLOAD_URL)
            await page.wait_for_url(TENCENT_UPLOAD_URL)
            tencent_logger.info(_msg("🏃", f"小人开始搬运视频: {self.title}"))

            file_input = page.locator('input[type="file"]')
            await file_input.set_input_files(self.file_path)

            await self.add_title_tags(page)
            await self.add_collection(page)
            await self.add_original(page)
            await self.detect_upload_status(page)
            await self.set_thumbnail(page)

            if self.publish_strategy == TENCENT_PUBLISH_STRATEGY_SCHEDULED and self.publish_date != 0:
                await self.set_schedule_time_tencent(page, self.publish_date)

            await self.add_short_title(page)

            await asyncio.sleep(self.submit_wait)
            await self.click_publish(page)

            await context.storage_state(path=self.account_file)
            tencent_logger.success(_msg("🥳", "cookie 更新完毕"))
        finally:
            await context.close()
            await browser.close()

    async def main(self):
        async with async_playwright() as playwright:
            await self.upload(playwright)
