# -*- coding: utf-8 -*-
"""
小红书视频/图文上传模块
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

from playwright.async_api import Page, Playwright, TimeoutError as PlaywrightTimeoutError, async_playwright

from conf import DEBUG_MODE, LOCAL_CHROME_HEADLESS, LOCAL_CHROME_PATH
from uploader.base_video import BaseVideoUploader
from sau_utils.base_social_media import set_init_script
from sau_utils.interactive_browser import InteractiveBrowser
from sau_utils.login_qrcode import build_login_qrcode_path, decode_qrcode_from_path, \
    print_terminal_qrcode, remove_qrcode_file, save_data_url_image
from sau_utils.log import xiaohongshu_logger

XHS_LOGIN_URL = "https://creator.xiaohongshu.com/login"
XHS_PUBLISH_VIDEO_URL = "https://creator.xiaohongshu.com/publish/publish?from=homepage&target=video"
XHS_PUBLISH_NOTE_URL = "https://creator.xiaohongshu.com/publish/publish?from=homepage&target=image"
XHS_PUBLISH_SUCCESS_URL_PATTERN = "**/publish/success?**"
XHS_LOGIN_BOX_SELECTOR = "div[class*='login-box']"
XHS_LOGIN_SWITCH_SELECTOR = "img.css-wemwzq"
XIAOHONGSHU_PUBLISH_STRATEGY_IMMEDIATE = "immediate"
XIAOHONGSHU_PUBLISH_STRATEGY_SCHEDULED = "scheduled"


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


async def _open_xhs_qrcode_panel(page: Page) -> None:
    login_box = page.locator(XHS_LOGIN_BOX_SELECTOR).first
    await login_box.wait_for(state="visible", timeout=30000)

    scan_text = login_box.locator("div:has-text('扫一扫')").first
    if await scan_text.count():
        return

    switch_img = login_box.locator(XHS_LOGIN_SWITCH_SELECTOR).first
    await switch_img.wait_for(state="visible", timeout=10000)
    await switch_img.click()
    await login_box.locator("div:has-text('扫一扫')").first.wait_for(state="visible", timeout=10000)


async def _find_xhs_qrcode_locator(page: Page):
    await _open_xhs_qrcode_panel(page)

    qrcode_img = page.locator('.login-box-container').get_by_text("APP扫一扫登录").filter(visible=True).locator("xpath=..//following-sibling::div//img").nth(0)

    if await qrcode_img.count():
        return qrcode_img

    raise RuntimeError("未在扫一扫登录区域找到小红书二维码图片")


async def _extract_xhs_qrcode_src(page: Page) -> str:
    qrcode_img = await _find_xhs_qrcode_locator(page)
    await qrcode_img.wait_for(state="visible", timeout=30000)
    qrcode_src = await qrcode_img.get_attribute("src")
    if not qrcode_src:
        raise RuntimeError("未获取到小红书登录二维码地址")
    return qrcode_src


async def _save_xhs_qrcode(page: Page, account_file: str, previous_qrcode_path: Path | None = None, qrcode_callback=None) -> dict:
    qrcode_src = await _extract_xhs_qrcode_src(page)
    qrcode_path = build_login_qrcode_path(account_file, suffix="xhs_login_qrcode")
    qrcode_img = await _find_xhs_qrcode_locator(page)

    if qrcode_src.startswith("data:image/"):
        save_data_url_image(qrcode_src, qrcode_path)
    else:
        qrcode_path.parent.mkdir(parents=True, exist_ok=True)
        await qrcode_img.screenshot(path=str(qrcode_path))

    if previous_qrcode_path and previous_qrcode_path != qrcode_path:
        if remove_qrcode_file(previous_qrcode_path):
            xiaohongshu_logger.info(_msg("🧹", f"临时二维码文件已清理: {previous_qrcode_path}"))

    xiaohongshu_logger.info(_msg("🖼️", f"二维码已经准备好啦，已保存到: {qrcode_path}"))
    qrcode_content = decode_qrcode_from_path(qrcode_path)
    if qrcode_content:
        print_terminal_qrcode(qrcode_content, qrcode_path, "小红书APP")
    else:
        xiaohongshu_logger.warning(_msg("😵", f"终端没法完整显示二维码，请打开 {qrcode_path} 扫码"))

    qrcode_info = {
        "image_path": str(qrcode_path),
        "image_data_url": qrcode_src,
    }
    await _emit_qrcode_callback(qrcode_callback, qrcode_info)
    return qrcode_info


async def _is_xhs_login_completed(page: Page) -> bool:
    if page.url.startswith(XHS_LOGIN_URL):
        return False

    login_box = page.locator(XHS_LOGIN_BOX_SELECTOR).first
    if not await login_box.count():
        return True

    try:
        return not await login_box.is_visible()
    except Exception:
        return True


async def cookie_auth(account_file):
    if not os.path.exists(account_file):
        return False

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(**_build_launch_kwargs(headless=True))
        try:
            context = await browser.new_context(storage_state=account_file)
            context = await set_init_script(context)
            page = await context.new_page()
            await page.goto(XHS_PUBLISH_VIDEO_URL)
            await page.wait_for_timeout(3000)

            if page.url.startswith(XHS_LOGIN_URL):
                xiaohongshu_logger.info(_msg("🥹", "cookie 已失效，得重新登录一下"))
                return False

            login_box = page.locator(XHS_LOGIN_BOX_SELECTOR).first
            if await login_box.count():
                try:
                    if await login_box.is_visible():
                        xiaohongshu_logger.info(_msg("🥹", "页面仍然停留在登录二维码页，按 cookie 失效处理"))
                        return False
                except Exception:
                    return False

            xiaohongshu_logger.success(_msg("🥳", "cookie 有效"))
            return True
        except Exception as exc:
            xiaohongshu_logger.warning(_msg("😵", f"cookie 校验时出错，按失效处理: {exc}"))
            return False
        finally:
            await browser.close()


async def xiaohongshu_setup(account_file, handle=False, return_detail=False, qrcode_callback=None, headless: bool = LOCAL_CHROME_HEADLESS):
    if not os.path.exists(account_file) or not await cookie_auth(account_file):
        if not handle:
            result = _build_login_result(False, "cookie_invalid", "cookie文件不存在或已失效", account_file)
            return result if return_detail else False
        xiaohongshu_logger.info(_msg("🥹", "cookie 失效了，准备打开浏览器重新登录"))
        result = await xiaohongshu_cookie_gen(account_file, qrcode_callback=qrcode_callback, headless=headless)
        return result if return_detail else result["success"]

    result = _build_login_result(True, "cookie_valid", "cookie有效", account_file)
    return result if return_detail else True


async def xiaohongshu_cookie_gen(
    account_file,
    qrcode_callback=None,
    poll_interval: int = 3,
    max_checks: int = 100,
    headless: bool = LOCAL_CHROME_HEADLESS,
):
    account_path = Path(account_file)
    account_path.parent.mkdir(parents=True, exist_ok=True)

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(**_build_launch_kwargs(headless=headless))
        context = await browser.new_context()
        context = await set_init_script(context)
        qrcode_path = None
        qrcode_info = None
        result = _build_login_result(False, "failed", "小红书登录失败", account_file)
        try:
            page = await context.new_page()
            await page.goto(XHS_LOGIN_URL, wait_until="commit", timeout=60000)
            qrcode_info = await _save_xhs_qrcode(page, account_file, qrcode_callback=qrcode_callback)
            qrcode_path = Path(qrcode_info["image_path"])
            xiaohongshu_logger.info(_msg("🧍", "请扫码，小人正在耐心等待登录完成"))
            interaction = InteractiveBrowser(qrcode_callback)

            for _ in range(max_checks):
                if await _is_xhs_login_completed(page):
                    await asyncio.sleep(2)
                    await context.storage_state(path=account_file)
                    xiaohongshu_logger.success(_msg("🥳", "小红书扫码登录成功，小人开心收工"))
                    result = _build_login_result(True, "success", "小红书扫码登录成功", account_file, qrcode_info, page.url)
                    return result

                await interaction.wait(page, poll_interval)

            result = _build_login_result(False, "timeout", "等待小红书扫码登录超时", account_file, qrcode_info, page.url)
        except Exception as exc:
            result = _build_login_result(False, "failed", str(exc), account_file, current_url=page.url if "page" in locals() else "")
        finally:
            if remove_qrcode_file(qrcode_path):
                xiaohongshu_logger.info(_msg("🧹", f"临时二维码文件已清理: {qrcode_path}"))
            if not result["success"]:
                xiaohongshu_logger.error(_msg("😢", f"登录失败: {result['message']}"))
            await context.close()
            await browser.close()
        return result


class XiaoHongShuBaseUploader(BaseVideoUploader):
    def __init__(
        self,
        publish_date: datetime | int,
        account_file,
        publish_strategy: str = XIAOHONGSHU_PUBLISH_STRATEGY_IMMEDIATE,
        debug: bool = DEBUG_MODE,
        headless: bool = LOCAL_CHROME_HEADLESS,
    ):
        self.publish_date = publish_date
        self.account_file = str(account_file)
        self.publish_strategy = publish_strategy
        self.debug = debug
        self.date_format = "%Y年%m月%d日 %H:%M"
        self.local_executable_path = LOCAL_CHROME_PATH
        self.headless = headless

    async def validate_base_args(self):
        if not os.path.exists(self.account_file):
            raise RuntimeError(f"cookie文件不存在，请先完成小红书登录: {self.account_file}")
        if not await cookie_auth(self.account_file):
            raise RuntimeError(f"cookie文件已失效，请先完成小红书登录: {self.account_file}")

        if self.publish_strategy not in {XIAOHONGSHU_PUBLISH_STRATEGY_IMMEDIATE, XIAOHONGSHU_PUBLISH_STRATEGY_SCHEDULED}:
            raise ValueError(f"不支持的发布策略: {self.publish_strategy}")

        if self.publish_strategy == XIAOHONGSHU_PUBLISH_STRATEGY_SCHEDULED:
            self.publish_date = self.validate_publish_date(self.publish_date)
        else:
            self.publish_date = 0

    async def set_schedule_time_xiaohongshu(self, page: Page, publish_date: datetime):
        xiaohongshu_logger.info(_msg("🕒", f"小人准备设置定时发布时间: {publish_date.strftime(self.date_format)}"))
        await page.locator('.custom-switch-card').filter(has_text="定时发布").locator('.d-switch').click()
        await asyncio.sleep(1)
        publish_date_hour = publish_date.strftime("%Y-%m-%d %H:%M")
        time_input = page.locator('.d-datepicker-input-filter input.d-text')
        await time_input.fill(str(publish_date_hour))
        await asyncio.sleep(1)

    async def fill_title(self, page: Page) -> None:
        title_container = page.locator('input[placeholder*="填写标题"]')
        await title_container.fill(self.title[:20])

    async def fill_desc(self, page: Page) -> None:
        if not getattr(self, "desc", ""):
            return

        desc = page.locator('p[data-placeholder*="输入正文描述"]')
        await desc.click()
        await page.keyboard.press("Backspace")
        await page.keyboard.press("Control+KeyA")
        await page.keyboard.press("Delete")
        await page.keyboard.type(self.desc)
        await page.keyboard.press("Enter")

    async def fill_tags(self, page: Page) -> None:
        if not getattr(self, "tags", None):
            return

        if not getattr(self, "desc", ""):
            desc = page.locator('p[data-placeholder*="输入正文描述"]')
            await desc.click()

        for tag in self.tags:
            clean_tag = str(tag or "").strip().lstrip("#")
            if not clean_tag:
                continue
            await page.keyboard.type("#" + clean_tag, delay=30)
            topic_container = page.locator('#creator-editor-topic-container')
            first_item = topic_container.locator('.item').first
            try:
                await topic_container.wait_for(state="visible", timeout=12000)
                await first_item.wait_for(state="visible", timeout=5000)
                await first_item.click()
                await page.wait_for_timeout(300)
            except PlaywrightTimeoutError:
                xiaohongshu_logger.warning(_msg("WARN", f"Topic suggestion not shown, keep raw hashtag: #{clean_tag}"))
                await page.keyboard.press("Space")
                await page.wait_for_timeout(300)

    async def fill_meta(self, page: Page) -> None:
        await self.fill_title(page)
        await self.fill_desc(page)
        await self.fill_tags(page)


class XiaoHongShuVideo(XiaoHongShuBaseUploader):
    def __init__(
        self,
        title,
        file_path,
        tags,
        publish_date: datetime | int,
        account_file,
        thumbnail_path=None,
        desc: str | None = None,
        is_draft: bool = False,
        publish_strategy: str = XIAOHONGSHU_PUBLISH_STRATEGY_IMMEDIATE,
        debug: bool = DEBUG_MODE,
        headless: bool = LOCAL_CHROME_HEADLESS,
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
            raise ValueError("视频模式下，title 是必须的")
        self.file_path = str(self.validate_video_file(self.file_path))
        if self.thumbnail_path:
            self.thumbnail_path = str(self.validate_image_file(self.thumbnail_path))

    async def handle_upload_error(self, page: Page):
        xiaohongshu_logger.warning(_msg("😵", "视频上传摔了一跤，小人马上重新上传"))
        await page.locator('div.progress-div [class^="upload-btn-input"]').set_input_files(self.file_path)

    async def set_thumbnail(self, page: Page, thumbnail_path: str):
        if not thumbnail_path:
            return

        xiaohongshu_logger.info(_msg("🖼️", "小人准备设置封面"))
        cover_plugin_title = page.locator("div.cover-plugin-title").filter(has_text="设置封面")
        cover_upload_dialog = cover_plugin_title.locator(
            "xpath=ancestor::div[contains(@class, 'cover-plugin-preview')]"
        ).locator("div.cover > div.default:visible")
        await cover_upload_dialog.wait_for(state="visible", timeout=30000)
        await cover_upload_dialog.click(force=True)

        modal = page.locator("div.d-modal.cover-modal")
        await modal.wait_for(state="visible", timeout=30000)

        file_input = modal.locator('input[type="file"][accept*="image"]').first
        await file_input.wait_for(state="attached", timeout=10000)
        await file_input.set_input_files(thumbnail_path)
        await page.wait_for_timeout(2000)

        confirm_button = modal.locator("button.mojito-button").filter(has_text="确定").first
        await confirm_button.wait_for(state="visible", timeout=10000)
        await confirm_button.click()

        await modal.wait_for(state="hidden", timeout=30000)
        xiaohongshu_logger.success(_msg("🥳", "封面已经设置完成"))

    async def _click_first_visible(self, page: Page, selectors: tuple[str, ...]) -> str:
        for selector in selectors:
            locator = page.locator(selector).first
            try:
                if not await locator.count():
                    continue
                await locator.wait_for(state="visible", timeout=1200)
                try:
                    if await locator.is_disabled():
                        continue
                except Exception:
                    pass
                await locator.click()
                return selector
            except Exception:
                continue
        return ""

    async def _visible_button_texts(self, page: Page) -> str:
        try:
            texts = await page.locator("button, [role='button']").evaluate_all(
                """els => els
                    .filter(el => {
                        const style = window.getComputedStyle(el);
                        const rect = el.getBoundingClientRect();
                        return style.visibility !== 'hidden'
                            && style.display !== 'none'
                            && rect.width > 0
                            && rect.height > 0;
                    })
                    .map(el => (el.innerText || el.textContent || '').trim())
                    .filter(Boolean)
                    .slice(0, 30)
                """
            )
            return "、".join(dict.fromkeys(texts))
        except Exception:
            return ""

    async def _wait_after_draft_click(self, page: Page) -> None:
        await page.wait_for_timeout(1800)
        try:
            body_text = await page.locator("body").inner_text(timeout=1000)
            if any(keyword in body_text for keyword in ("保存失败", "存草稿失败", "上传失败")):
                raise RuntimeError("小红书页面提示草稿保存失败")
        except PlaywrightTimeoutError:
            pass
        xiaohongshu_logger.success(_msg("OK", "Xiaohongshu draft saved"))

    async def wait_for_manual_draft_save(self, page: Page, timeout_seconds: int = 1800) -> None:
        xiaohongshu_logger.info(_msg("OK", "页面已填写完成，请在打开的小红书页面手动点击暂存离开/保存草稿"))
        deadline = asyncio.get_running_loop().time() + timeout_seconds
        while asyncio.get_running_loop().time() < deadline:
            current_url = page.url or ""
            if "publish/success" in current_url or "draft" in current_url:
                xiaohongshu_logger.success(_msg("OK", "检测到小红书草稿已保存"))
                return
            if "publish/publish" not in current_url:
                xiaohongshu_logger.success(_msg("OK", "检测到小红书已离开编辑页"))
                return
            try:
                body_text = await page.locator("body").inner_text(timeout=1000)
                if any(keyword in body_text for keyword in ("保存成功", "草稿保存成功", "已保存", "草稿箱", "暂存成功")):
                    xiaohongshu_logger.success(_msg("OK", "检测到小红书草稿已保存"))
                    return
            except Exception:
                pass
            await asyncio.sleep(2)
        raise RuntimeError("小红书页面已填写完成，但等待手动保存草稿超时，请重新操作并在浏览器中点击暂存离开/保存草稿")

    async def save_draft(self, page: Page) -> None:
        direct_selectors = (
            'button:has-text("暂存离开")',
            '[role="button"]:has-text("暂存离开")',
            'button:has-text("保存草稿")',
            '[role="button"]:has-text("保存草稿")',
            'button:has-text("存入草稿")',
            '[role="button"]:has-text("存入草稿")',
            'button:has-text("存草稿")',
            '[role="button"]:has-text("存草稿")',
            'button:has-text("暂存")',
            '[role="button"]:has-text("暂存")',
            'button:has-text("保存并退出")',
            '[role="button"]:has-text("保存并退出")',
            'button:has-text("退出并保存")',
            '[role="button"]:has-text("退出并保存")',
        )
        clicked = await self._click_first_visible(page, direct_selectors)
        if clicked:
            xiaohongshu_logger.info(_msg("OK", f"点击小红书草稿按钮: {clicked}"))
            await self._wait_after_draft_click(page)
            return

        leave_selectors = (
            'button[aria-label*="关闭"]',
            '[aria-label*="关闭"]',
            'button[aria-label*="返回"]',
            '[aria-label*="返回"]',
            'button:has-text("退出")',
            '[role="button"]:has-text("退出")',
            'button:has-text("取消")',
            '[role="button"]:has-text("取消")',
        )
        clicked = await self._click_first_visible(page, leave_selectors)
        if not clicked:
            try:
                await page.keyboard.press("Alt+Left")
                clicked = "Alt+Left"
            except Exception:
                clicked = ""

        if clicked:
            xiaohongshu_logger.info(_msg("OK", f"触发小红书退出确认: {clicked}"))
            await page.wait_for_timeout(1200)
            confirm_selectors = (
                'button:has-text("暂存离开")',
                '[role="button"]:has-text("暂存离开")',
                'button:has-text("保存草稿")',
                '[role="button"]:has-text("保存草稿")',
                'button:has-text("存入草稿")',
                '[role="button"]:has-text("存入草稿")',
                'button:has-text("存草稿")',
                '[role="button"]:has-text("存草稿")',
                'button:has-text("暂存")',
                '[role="button"]:has-text("暂存")',
                'button:has-text("保存并退出")',
                '[role="button"]:has-text("保存并退出")',
                'button:has-text("确认保存")',
                '[role="button"]:has-text("确认保存")',
            )
            confirmed = await self._click_first_visible(page, confirm_selectors)
            if confirmed:
                xiaohongshu_logger.info(_msg("OK", f"确认小红书保存草稿: {confirmed}"))
                await self._wait_after_draft_click(page)
                return
            if "publish/publish" not in page.url:
                xiaohongshu_logger.success(_msg("OK", "Xiaohongshu draft saved by leaving editor"))
                return

        visible_buttons = await self._visible_button_texts(page)
        detail = f"。当前可见按钮: {visible_buttons}" if visible_buttons else ""
        raise RuntimeError(f"未找到小红书保存草稿按钮，页面已填写完成但无法确认草稿保存{detail}")

    async def upload_video_content(self, page: Page) -> None:
        xiaohongshu_logger.info(_msg("🏃", f"小人开始搬运视频: {self.title}.mp4"))
        await page.goto(XHS_PUBLISH_VIDEO_URL)
        await page.wait_for_url(XHS_PUBLISH_VIDEO_URL)
        await page.locator("div[class^='upload-content'] input[class='upload-input']").set_input_files(self.file_path)

        while True:
            try:
                upload_input = await page.wait_for_selector('input.upload-input', timeout=3000)
                preview_new = await upload_input.query_selector(
                    'xpath=following-sibling::div[contains(@class, "preview-new")]')
                if preview_new:
                    all_text = await preview_new.inner_text()
                    upload_success = any(keyword in all_text for keyword in ['上传成功', '分辨率', '重新上传', '编辑封面', '已上传', '已选择', '100%'])

                    if not upload_success:
                        stage_elements = await preview_new.query_selector_all('div.stage')
                        for stage in stage_elements:
                            text_content = await page.evaluate('(element) => element.textContent', stage)
                            if '上传成功' in text_content or '分辨率' in text_content:
                                upload_success = True
                                break

                    if upload_success:
                        xiaohongshu_logger.success(_msg("🥳", "视频已经传完啦"))
                        break

                    xiaohongshu_logger.debug(_msg("🧍", "还没看到上传成功标识，小人继续等一会"))
                else:
                    title_container = page.locator('input[placeholder*="填写标题"]')
                    if await title_container.count() > 0 and await title_container.is_visible():
                        xiaohongshu_logger.success(_msg("🥳", "虽然没看到预览区，但标题框出来了，小人继续"))
                        break
                    xiaohongshu_logger.debug(_msg("🧍", "还没拿到预览区域，小人继续等一会"))
            except Exception as e:
                xiaohongshu_logger.debug(_msg("😵", f"上传状态还没稳定下来，小人继续观察: {e}"))
            await asyncio.sleep(2)

        xiaohongshu_logger.info(_msg("✍️", "小人开始填标题、描述和话题"))
        await self.fill_meta(page)

        await self.set_thumbnail(page, self.thumbnail_path)

        if self.publish_strategy == XIAOHONGSHU_PUBLISH_STRATEGY_SCHEDULED and self.publish_date != 0:
            await self.set_schedule_time_xiaohongshu(page, self.publish_date)

        if self.is_draft:
            await self.save_draft(page)
            return

        while True:
            try:
                if self.publish_strategy == XIAOHONGSHU_PUBLISH_STRATEGY_SCHEDULED:
                    await page.locator('button:has-text("定时发布")').click()
                else:
                    await page.locator('button:has-text("发布")').click()
                await page.wait_for_url(
                    "https://creator.xiaohongshu.com/publish/success?**",
                    timeout=3000
                )
                xiaohongshu_logger.success(_msg("🥳", "视频发布成功，小人开心收工"))
                break
            except Exception:
                xiaohongshu_logger.info(_msg("🏃", "小人正在冲刺发布视频"))
                if self.debug:
                    await page.screenshot(full_page=True)
                await asyncio.sleep(0.5)

    async def upload(self, playwright: Playwright) -> None:
        xiaohongshu_logger.info(_msg("🧍", "小人先检查 cookie、视频文件、封面和发布时间"))
        await self.validate_upload_args()
        xiaohongshu_logger.info(_msg("🥳", "上传前检查通过"))
        browser = await playwright.chromium.launch(**_build_launch_kwargs(headless=self.headless))
        context = await browser.new_context(
            permissions=["geolocation"],
            storage_state=self.account_file,
        )
        context = await set_init_script(context)

        try:
            page = await context.new_page()
            await self.upload_video_content(page)
            await context.storage_state(path=self.account_file)
            xiaohongshu_logger.success(_msg("🥳", "cookie 更新完毕"))
        finally:
            await context.close()
            await browser.close()

    async def main(self):
        async with async_playwright() as playwright:
            await self.upload(playwright)
