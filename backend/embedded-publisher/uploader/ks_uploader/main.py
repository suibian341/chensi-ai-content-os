# -*- coding: utf-8 -*-
"""
快手视频上传模块
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

from conf import DEBUG_MODE, LOCAL_CHROME_HEADLESS, LOCAL_CHROME_PATH
from uploader.base_video import BaseVideoUploader
from sau_utils.base_social_media import set_init_script
from sau_utils.interactive_browser import InteractiveBrowser
from sau_utils.files_times import get_absolute_path
from sau_utils.login_qrcode import build_login_qrcode_path, decode_qrcode_from_path, \
    print_terminal_qrcode, remove_qrcode_file, save_data_url_image
from sau_utils.log import kuaishou_logger

KUAISHOU_UPLOAD_URL = "https://cp.kuaishou.com/article/publish/video"
KUAISHOU_MANAGE_URL = "https://cp.kuaishou.com/article/manage/video?status=2&from=publish"
KUAISHOU_LOGIN_URL = "https://passport.kuaishou.com/pc/account/login/?sid=kuaishou.web.cp.api&callback=https%3A%2F%2Fcp.kuaishou.com%2Frest%2Finfra%2Fsts%3FfollowUrl%3Dhttps%253A%252F%252Fcp.kuaishou.com%252Farticle%252Fpublish%252Fvideo%26setRootDomain%3Dtrue"
KUAISHOU_UPLOAD_URL_PATTERN = "**/article/publish/video**"
KUAISHOU_MANAGE_URL_PATTERN = "**/article/manage/video?status=2&from=publish**"
KUAISHOU_COOKIE_INVALID_SELECTOR = "div.names div.container div.name:text('机构服务')"
KUAISHOU_PUBLISH_STRATEGY_IMMEDIATE = "immediate"
KUAISHOU_PUBLISH_STRATEGY_SCHEDULED = "scheduled"


def _msg(emoji: str, text: str) -> str:
    return f"{emoji} {text}"


def _build_launch_kwargs(headless: bool) -> dict:
    launch_kwargs = {"headless": headless}
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


async def _is_ks_cookie_invalid(page: Page, timeout: int = 5000) -> bool:
    try:
        await page.wait_for_selector(KUAISHOU_COOKIE_INVALID_SELECTOR, timeout=timeout)
        return True
    except Exception:
        return False


async def _extract_ks_qrcode_src(page: Page) -> str:
    login_form = page.locator("main#login-form").first
    await login_form.wait_for(state="visible", timeout=30000)

    qrcode_img = login_form.locator('div.qr-login img[alt="qrcode"]').first
    try:
        if not await qrcode_img.count() or not await qrcode_img.is_visible():
            platform_switch = login_form.locator("div.platform-switch").first
            await platform_switch.wait_for(state="visible", timeout=10000)
            await platform_switch.click()
            await asyncio.sleep(1)
    except Exception:
        platform_switch = login_form.locator("div.platform-switch").first
        await platform_switch.wait_for(state="visible", timeout=10000)
        await platform_switch.click()
        await asyncio.sleep(1)

    await qrcode_img.wait_for(state="visible", timeout=15000)
    qrcode_src = await qrcode_img.get_attribute("src")
    if not qrcode_src:
        raise RuntimeError("未获取到快手登录二维码地址")
    return qrcode_src


async def _save_ks_qrcode(page: Page, account_file: str, previous_qrcode_path: Path | None = None, qrcode_callback=None) -> dict:
    qrcode_src = await _extract_ks_qrcode_src(page)
    qrcode_path = save_data_url_image(qrcode_src, build_login_qrcode_path(account_file, suffix="ks_login_qrcode"))

    if previous_qrcode_path and previous_qrcode_path != qrcode_path:
        if remove_qrcode_file(previous_qrcode_path):
            kuaishou_logger.info(_msg("🧹", f"临时二维码文件已清理: {previous_qrcode_path}"))

    kuaishou_logger.info(_msg("🖼️", f"二维码已经准备好啦，已保存到: {qrcode_path}"))
    qrcode_content = decode_qrcode_from_path(qrcode_path)
    if qrcode_content:
        print_terminal_qrcode(qrcode_content, qrcode_path, "快手APP")
    else:
        kuaishou_logger.warning(_msg("😵", f"终端没法完整显示二维码，请打开 {qrcode_path} 扫码"))

    qrcode_info = {
        "image_path": str(qrcode_path),
        "image_data_url": qrcode_src,
    }
    await _emit_qrcode_callback(qrcode_callback, qrcode_info)
    return qrcode_info


async def _is_ks_qrcode_expired(page: Page) -> bool:
    expired_box = page.locator("div.qrcode-status.qrcode-status-timeout").first
    try:
        if not await expired_box.count():
            return False
        return await expired_box.is_visible()
    except Exception:
        return False


async def _is_ks_login_page_gone(page: Page) -> bool:
    try:
        login_form = page.locator("main#login-form").first
        if not await login_form.count():
            return True
        return not await login_form.is_visible()
    except Exception:
        return True


async def cookie_auth(account_file):
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(**_build_launch_kwargs(headless=True))
        try:
            context = await browser.new_context(storage_state=account_file)
            context = await set_init_script(context)
            page = await context.new_page()
            await page.goto(KUAISHOU_UPLOAD_URL)
            if await _is_ks_cookie_invalid(page):
                kuaishou_logger.info(_msg("🥹", "cookie 已失效，得重新登录一下"))
                return False
            kuaishou_logger.success(_msg("🥳", "cookie 有效"))
            return True
        except Exception as exc:
            kuaishou_logger.warning(_msg("😵", f"cookie 校验时出错，按失效处理: {exc}"))
            return False
        finally:
            await browser.close()


async def ks_setup(account_file, handle=False, return_detail=False, qrcode_callback=None, headless: bool = LOCAL_CHROME_HEADLESS):
    account_file = get_absolute_path(account_file, "ks_uploader")
    if not os.path.exists(account_file) or not await cookie_auth(account_file):
        if not handle:
            result = _build_login_result(False, "cookie_invalid", "cookie文件不存在或已失效", account_file)
            return result if return_detail else False
        kuaishou_logger.info(_msg("🥹", "cookie 失效了，准备重新登录快手创作者平台"))
        result = await get_ks_cookie(account_file, qrcode_callback=qrcode_callback, headless=headless)
        return result if return_detail else result["success"]

    result = _build_login_result(True, "cookie_valid", "cookie有效", account_file)
    return result if return_detail else True


async def get_ks_cookie(
    account_file,
    qrcode_callback=None,
    headless: bool = LOCAL_CHROME_HEADLESS,
    poll_interval: int = 3,
    max_checks: int = 100,
):
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(**_build_launch_kwargs(headless=headless))
        context = await browser.new_context()
        context = await set_init_script(context)
        qrcode_path = None
        qrcode_info = None
        result = _build_login_result(False, "failed", "快手登录失败", account_file)
        try:
            page = await context.new_page()
            await page.goto(KUAISHOU_LOGIN_URL, wait_until="commit", timeout=60000)
            kuaishou_logger.info(_msg("🧍", "请在浏览器里扫码登录快手，小人正在耐心等待"))

            qrcode_info = await _save_ks_qrcode(page, account_file, qrcode_callback=qrcode_callback)
            qrcode_path = Path(qrcode_info["image_path"])
            interaction = InteractiveBrowser(qrcode_callback)

            for _ in range(max_checks):
                if page.url.startswith(KUAISHOU_UPLOAD_URL) or await _is_ks_login_page_gone(page):
                    await context.storage_state(path=account_file)
                    kuaishou_logger.success(_msg("🥳", "快手扫码登录成功，小人开心收工"))
                    result = _build_login_result(True, "success", "快手扫码登录成功", account_file, qrcode_info, page.url)
                    return result

                if qrcode_info and await _is_ks_qrcode_expired(page):
                    kuaishou_logger.warning(_msg("😵", "二维码失效了，小人马上去刷新"))
                    refresh_button = page.locator("p.qrcode-refresh").first
                    if await refresh_button.count():
                        await refresh_button.click()
                        await asyncio.sleep(1)
                    qrcode_info = await _save_ks_qrcode(page, account_file, qrcode_path, qrcode_callback=qrcode_callback)
                    qrcode_path = Path(qrcode_info["image_path"])

                await interaction.wait(page, poll_interval)

            result = _build_login_result(False, "timeout", "等待快手扫码登录超时", account_file, qrcode_info, page.url)
        except Exception as exc:
            result = _build_login_result(False, "failed", str(exc), account_file, current_url=page.url if "page" in locals() else "")
        finally:
            if remove_qrcode_file(qrcode_path):
                kuaishou_logger.info(_msg("🧹", f"临时二维码文件已清理: {qrcode_path}"))
            if not result["success"]:
                kuaishou_logger.error(_msg("😢", f"登录失败: {result['message']}"))
            await context.close()
            await browser.close()

    return result


class KSBaseUploader(BaseVideoUploader):
    def __init__(
        self,
        publish_date: datetime | int,
        account_file,
        publish_strategy: str | None = None,
        debug: bool = DEBUG_MODE,
        headless: bool = LOCAL_CHROME_HEADLESS,
    ):
        self.publish_date = publish_date
        self.account_file = str(account_file)
        self.publish_strategy = publish_strategy
        self.debug = debug
        self.headless = headless
        self.local_executable_path = LOCAL_CHROME_PATH
        self.date_format = "%Y-%m-%d %H:%M"

    async def validate_base_args(self):
        if not os.path.exists(self.account_file):
            raise RuntimeError(f"cookie文件不存在，请先完成快手登录: {self.account_file}")
        if not await cookie_auth(self.account_file):
            raise RuntimeError(f"cookie文件已失效，请先完成快手登录: {self.account_file}")

        if self.publish_strategy is None:
            self.publish_strategy = (
                KUAISHOU_PUBLISH_STRATEGY_SCHEDULED if self.publish_date != 0
                else KUAISHOU_PUBLISH_STRATEGY_IMMEDIATE
            )

        if self.publish_strategy not in {KUAISHOU_PUBLISH_STRATEGY_IMMEDIATE, KUAISHOU_PUBLISH_STRATEGY_SCHEDULED}:
            raise ValueError(f"不支持的发布策略: {self.publish_strategy}")

        if self.publish_strategy == KUAISHOU_PUBLISH_STRATEGY_SCHEDULED:
            self.publish_date = self.validate_publish_date(self.publish_date)
        else:
            self.publish_date = 0

    async def set_schedule_time(self, page: Page, publish_date: datetime):
        kuaishou_logger.info(_msg("🕒", "小人准备设置定时发布时间"))
        publish_date_hour = publish_date.strftime("%Y-%m-%d %H:%M:%S")
        await page.locator("label:text('发布时间')").locator("xpath=following-sibling::div").locator(".ant-radio-input").nth(1).click()
        await asyncio.sleep(1)
        await page.locator('div.ant-picker-input input[placeholder="选择日期时间"]').click()
        await asyncio.sleep(1)
        await page.keyboard.press("Control+KeyA")
        await page.keyboard.type(publish_date_hour)
        await page.keyboard.press("Enter")
        await asyncio.sleep(1)

    async def close_guide_overlay(self, page: Page) -> bool:
        joyride_tooltip = page.locator('div[id^="react-joyride-step"] div[role="alertdialog"]')
        if await joyride_tooltip.count() > 0 and await joyride_tooltip.first.is_visible():
            kuaishou_logger.info("检测到 Joyride 引导遮罩，正在关闭...")
            close_button = page.locator('div[role="alertdialog"]').locator(
                '[aria-label="Skip"], [data-action="skip"], button[title="Skip"]'
            )
            await close_button.click(force=True)
            await joyride_tooltip.wait_for(state="hidden", timeout=5000)
            kuaishou_logger.info("已关闭 Joyride 遮罩")
            return True
        return False


class KSVideo(KSBaseUploader):
    def __init__(
        self,
        title,
        file_path,
        tags,
        publish_date: datetime | int,
        account_file,
        publish_strategy: str | None = None,
        debug: bool = DEBUG_MODE,
        headless: bool = LOCAL_CHROME_HEADLESS,
        thumbnail_path=None,
        desc: str | None = None,
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
        self.tags = tags or []
        self.thumbnail_path = thumbnail_path
        self.desc = desc or ""
        self.is_draft = is_draft

    async def validate_upload_args(self):
        await self.validate_base_args()
        if not self.title or not str(self.title).strip():
            raise ValueError("快手视频上传时，title 是必须的")
        self.file_path = str(self.validate_video_file(self.file_path))
        if self.thumbnail_path:
            self.thumbnail_path = str(self.validate_image_file(self.thumbnail_path))

    async def handle_upload_error(self, page: Page):
        kuaishou_logger.warning(_msg("😵", "视频上传摔了一跤，小人马上重新上传"))
        await page.locator('div.progress-div [class^="upload-btn-input"]').set_input_files(self.file_path)

    async def set_thumbnail(self, page: Page):
        if not self.thumbnail_path:
            return

        kuaishou_logger.info(_msg("🖼️", "小人准备设置封面"))
        cover_label = page.locator("span").filter(has_text="封面设置")
        await cover_label.wait_for(state="visible", timeout=30000)
        await cover_label.locator("xpath=../following-sibling::div[1]").locator('div').nth(0).click()

        modal = page.locator('div[role="document"].ant-modal')
        await modal.wait_for(state="visible", timeout=30000)

        upload_cover_tab = modal.get_by_text("上传封面", exact=True)
        await upload_cover_tab.wait_for(state="visible", timeout=10000)
        await upload_cover_tab.click()

        file_input = modal.locator('input[type="file"]')
        await file_input.wait_for(state="attached", timeout=30000)
        await file_input.set_input_files(self.thumbnail_path)
        await asyncio.sleep(1)

        confirm_button = modal.get_by_role("button", name="确认", exact=True)
        await confirm_button.wait_for(state="visible", timeout=10000)
        await confirm_button.click()

        await modal.wait_for(state="hidden", timeout=30000)
        kuaishou_logger.success(_msg("🥳", "封面已经设置完成"))

    async def wait_for_draft_save(self, page: Page, timeout_seconds: int = 60) -> None:
        deadline = asyncio.get_running_loop().time() + timeout_seconds
        while asyncio.get_running_loop().time() < deadline:
            current_url = page.url or ""
            if "manage" in current_url or "draft" in current_url:
                kuaishou_logger.success(_msg("OK", "检测到快手草稿已保存"))
                return
            try:
                body_text = await page.locator("body").inner_text(timeout=1000)
                if any(keyword in body_text for keyword in ("保存成功", "草稿保存成功", "已保存", "草稿箱")):
                    kuaishou_logger.success(_msg("OK", "检测到快手草稿已保存"))
                    return
            except Exception:
                pass
            await asyncio.sleep(2)
        raise RuntimeError("快手草稿保存后未检测到成功状态")

    async def save_draft(self, page: Page) -> None:
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
            kuaishou_logger.info(_msg("OK", "已提交快手草稿保存"))
            await self.wait_for_draft_save(page)
            return
        raise RuntimeError("未找到快手保存草稿按钮，平台页面可能已经改版")

    async def upload(self, playwright: Playwright) -> None:
        kuaishou_logger.info(_msg("🧍", "小人先检查 cookie、视频文件、封面和发布时间"))
        await self.validate_upload_args()
        kuaishou_logger.info(_msg("🥳", "上传前检查通过"))

        browser = await playwright.chromium.launch(**_build_launch_kwargs(headless=self.headless))
        context = await browser.new_context(storage_state=self.account_file)
        context = await set_init_script(context)

        upload_success = False
        try:
            page = await context.new_page()
            await page.goto(KUAISHOU_UPLOAD_URL)
            kuaishou_logger.info(_msg("🏃", f"小人开始搬运视频: {self.title}.mp4"))
            await page.wait_for_url(KUAISHOU_UPLOAD_URL_PATTERN)

            upload_button = page.locator("button[class^='_upload-btn']")
            await upload_button.wait_for(state="visible", timeout=10000)

            async with page.expect_file_chooser() as fc_info:
                await upload_button.click()
            file_chooser = await fc_info.value
            await file_chooser.set_files(self.file_path)

            await asyncio.sleep(2)

            know_button = page.locator('button[type="button"] span:text("我知道了")').first
            try:
                if await know_button.count() and await know_button.is_visible():
                    await know_button.click()
            except Exception:
                pass

            await self.close_guide_overlay(page)

            kuaishou_logger.info(_msg("✍️", "小人开始填描述和话题"))
            await page.get_by_text("描述").locator("xpath=following-sibling::div").click()
            await page.keyboard.press("Backspace")
            await page.keyboard.press("Control+KeyA")
            await page.keyboard.press("Delete")
            await page.keyboard.type(self.desc or self.title)
            await page.keyboard.press("Enter")

            for index, tag in enumerate(self.tags[:3], start=1):
                kuaishou_logger.info(_msg("🏷️", f"小人正在添加第 {index} 个话题: #{tag}"))
                await page.keyboard.type(f"#{tag} ")
                await asyncio.sleep(2)

            max_retries = 60
            retry_count = 0
            while retry_count < max_retries:
                try:
                    number = await page.locator("text=上传中").count()
                    if number == 0:
                        kuaishou_logger.success(_msg("🥳", "视频已经传完啦"))
                        break
                    if retry_count % 5 == 0:
                        kuaishou_logger.info(_msg("🏃", "小人正在努力上传视频"))
                    if await page.locator("text=上传失败").count():
                        await self.handle_upload_error(page)
                    await asyncio.sleep(2)
                except Exception as exc:
                    kuaishou_logger.warning(_msg("😵", f"检查上传状态时出错，小人继续重试: {exc}"))
                    await asyncio.sleep(2)
                retry_count += 1

            if retry_count == max_retries:
                kuaishou_logger.warning(_msg("😵", "超过最大重试次数，视频上传可能未完成"))

            await self.set_thumbnail(page)

            if self.publish_strategy == KUAISHOU_PUBLISH_STRATEGY_SCHEDULED and self.publish_date != 0:
                await self.set_schedule_time(page, self.publish_date)

            if self.is_draft:
                await self.save_draft(page)
                upload_success = True
                return

            while True:
                try:
                    publish_button = page.get_by_text("发布", exact=True)
                    if await publish_button.count() > 0:
                        await publish_button.click()

                    await asyncio.sleep(1)
                    confirm_button = page.get_by_text("确认发布")
                    if await confirm_button.count() > 0:
                        await confirm_button.click()

                    await page.wait_for_url(KUAISHOU_MANAGE_URL_PATTERN, timeout=5000)
                    kuaishou_logger.success(_msg("🥳", "视频发布成功，小人开心收工"))
                    break
                except Exception as exc:
                    kuaishou_logger.info(_msg("🏃", f"小人正在冲刺发布视频: {exc}"))
                    if self.debug:
                        await page.screenshot(full_page=True)
                    await asyncio.sleep(1)

            upload_success = True
        finally:
            if upload_success:
                await context.storage_state(path=self.account_file)
                kuaishou_logger.success(_msg("🥳", "cookie 更新完毕"))
                await asyncio.sleep(2)
            await context.close()
            await browser.close()

    async def main(self):
        async with async_playwright() as playwright:
            await self.upload(playwright)
