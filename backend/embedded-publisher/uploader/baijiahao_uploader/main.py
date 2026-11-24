# -*- coding: utf-8 -*-
"""
百家号视频上传模块
同步自 social-auto-upload (2026.05) 最新版，适配 HaoQingAiDigMan 架构
- 使用 playwright (非 patchright)
- 导入路径使用 sau_utils
"""
import random
import inspect
from datetime import datetime
from pathlib import Path

from playwright.async_api import Playwright, async_playwright, Page
import os
import asyncio

from conf import LOCAL_CHROME_PATH, LOCAL_CHROME_HEADLESS
from sau_utils.base_social_media import set_init_script
from sau_utils.interactive_browser import InteractiveBrowser
from sau_utils.login_qrcode import build_login_qrcode_path, remove_qrcode_file, save_data_url_image
from sau_utils.log import baijiahao_logger
from sau_utils.network import async_retry

BAIJIAHAO_LOGIN_URL = "https://baijiahao.baidu.com/builder/theme/bjh/login"
BAIJIAHAO_HOME_URL = "https://baijiahao.baidu.com/builder/rc/home"
BAIJIAHAO_UPLOAD_URL = "https://baijiahao.baidu.com/builder/rc/edit?type=videoV2"


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


async def _save_baijiahao_qrcode(page: Page, account_file: str, qrcode_callback=None) -> dict:
    selectors = (
        'img[src^="data:image/"]',
        'img[src*="qrcode"]',
        'img[class*="qrcode"]',
        'canvas',
    )
    qrcode_locator = None
    deadline = asyncio.get_running_loop().time() + 30
    scan_switch_clicked = False
    while asyncio.get_running_loop().time() < deadline and qrcode_locator is None:
        if not scan_switch_clicked:
            scan_switch = page.get_by_text('扫码登录').first
            try:
                if await scan_switch.count() and await scan_switch.is_visible():
                    await scan_switch.click()
                    scan_switch_clicked = True
                    await page.wait_for_timeout(500)
            except Exception:
                pass
        for frame in page.frames:
            for selector in selectors:
                for candidate in await frame.locator(selector).all():
                    try:
                        if not await candidate.is_visible():
                            continue
                        box = await candidate.bounding_box()
                        if box and min(box["width"], box["height"]) >= 90:
                            qrcode_locator = candidate
                            break
                    except Exception:
                        continue
                if qrcode_locator is not None:
                    break
            if qrcode_locator is not None:
                break
        if qrcode_locator is None:
            await page.wait_for_timeout(250)
    if qrcode_locator is None:
        raise RuntimeError("未在百家号登录页面找到二维码")

    qrcode_path = build_login_qrcode_path(account_file, suffix="baijiahao_login_qrcode")
    qrcode_src = await qrcode_locator.get_attribute("src") or ""
    if qrcode_src.startswith("data:image/"):
        save_data_url_image(qrcode_src, qrcode_path)
    else:
        qrcode_path.parent.mkdir(parents=True, exist_ok=True)
        await qrcode_locator.screenshot(path=str(qrcode_path))
    qrcode_info = {"image_path": str(qrcode_path), "image_data_url": qrcode_src}
    await _emit_qrcode_callback(qrcode_callback, qrcode_info)
    return qrcode_info


async def _is_baijiahao_login_visible(page: Page) -> bool:
    login_markers = [
        page.get_by_text('注册/登录百家号').first,
        page.get_by_text('扫码登录').first,
        page.get_by_text('登录', exact=True).first,
    ]
    for marker in login_markers:
        try:
            if await marker.count() and await marker.is_visible():
                return True
        except Exception:
            continue
    return False


async def _is_baijiahao_logged_in(page: Page) -> bool:
    if page.url.startswith(BAIJIAHAO_HOME_URL) or "/builder/rc/" in page.url:
        return not await _is_baijiahao_login_visible(page)
    return False


async def baijiahao_cookie_gen(account_file, qrcode_callback=None, poll_interval: int = 3, max_checks: int = 100, headless: bool = LOCAL_CHROME_HEADLESS):
    async with async_playwright() as playwright:
        launch_kwargs = _build_launch_kwargs(headless=headless)
        launch_kwargs.setdefault('args', ['--lang=zh-CN'])
        browser = await playwright.chromium.launch(**launch_kwargs)
        context = await browser.new_context(locale="zh-CN")
        qrcode_path = None
        qrcode_info = None
        try:
            context = await set_init_script(context)
            page = await context.new_page()
            await page.goto(BAIJIAHAO_LOGIN_URL, wait_until="commit", timeout=60000)
            qrcode_info = await _save_baijiahao_qrcode(page, account_file, qrcode_callback=qrcode_callback)
            qrcode_path = Path(qrcode_info["image_path"])
            baijiahao_logger.info("请使用百家号手机端扫描网页展示的二维码")
            interaction = InteractiveBrowser(qrcode_callback)

            for check_index in range(max_checks):
                if await _is_baijiahao_logged_in(page):
                    Path(account_file).parent.mkdir(parents=True, exist_ok=True)
                    await context.storage_state(path=account_file)
                    baijiahao_logger.success("百家号登录成功，cookie saved")
                    return _build_login_result(True, "success", "百家号扫码登录成功", account_file, qrcode_info, page.url)
                if check_index and check_index % 20 == 0:
                    qrcode_info = await _save_baijiahao_qrcode(page, account_file, qrcode_callback=qrcode_callback)
                await interaction.wait(page, poll_interval)

            baijiahao_logger.error("等待百家号登录超时")
            return _build_login_result(False, "timeout", "等待百家号扫码登录超时", account_file, qrcode_info, page.url)
        except Exception as exc:
            baijiahao_logger.error(f"百家号登录失败: {exc}")
            return _build_login_result(False, "failed", str(exc), account_file, qrcode_info, page.url if "page" in locals() else "")
        finally:
            remove_qrcode_file(qrcode_path)
            await context.close()
            await browser.close()


async def cookie_auth(account_file):
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(**_build_launch_kwargs(headless=True))
        context = None
        try:
            context = await browser.new_context(storage_state=account_file)
            context = await set_init_script(context)
            page = await context.new_page()
            await page.goto(BAIJIAHAO_HOME_URL)
            await page.wait_for_timeout(timeout=5000)

            if await page.get_by_text('注册/登录百家号').count():
                baijiahao_logger.error("等待5秒 cookie 失效")
                return False
            else:
                baijiahao_logger.success("[+] cookie 有效")
                return True
        except Exception as exc:
            baijiahao_logger.error(f"百家号 cookie 校验失败: {exc}")
            return False
        finally:
            if context:
                await context.close()
            await browser.close()


async def baijiahao_setup(account_file, handle=False, return_detail=False, qrcode_callback=None, headless: bool = LOCAL_CHROME_HEADLESS):
    if not os.path.exists(account_file) or not await cookie_auth(account_file):
        if not handle:
            result = _build_login_result(False, "cookie_invalid", "cookie文件不存在或已失效", account_file)
            return result if return_detail else False
        baijiahao_logger.info("cookie文件不存在或已失效，准备获取百家号扫码二维码")
        result = await baijiahao_cookie_gen(account_file, qrcode_callback=qrcode_callback, headless=headless)
        return result if return_detail else result["success"]
    result = _build_login_result(True, "cookie_valid", "cookie有效", account_file)
    return result if return_detail else True


class BaiJiaHaoVideo(object):
    def __init__(self, title, file_path, tags, publish_date: datetime, account_file, proxy_setting=None):
        self.title = title
        self.file_path = file_path
        self.tags = tags
        self.publish_date = publish_date
        self.account_file = account_file
        self.date_format = '%Y年%m月%d日 %H:%M'
        self.local_executable_path = LOCAL_CHROME_PATH
        self.headless = LOCAL_CHROME_HEADLESS
        self.proxy_setting = proxy_setting

    async def set_schedule_time(self, page, publish_date):
        publish_date_day = f"{publish_date.month}月{publish_date.day}日" if publish_date.day > 9 else f"{publish_date.month}月0{publish_date.day}日"
        await page.wait_for_selector('div.select-wrap', timeout=5000)
        for _ in range(3):
            try:
                await page.locator('div.select-wrap').nth(0).click()
                await page.wait_for_selector('div.rc-virtual-list  div.cheetah-select-item', timeout=5000)
                break
            except:
                await page.locator('div.select-wrap').nth(0).click()
        await page.wait_for_timeout(2000)
        await page.locator(f'div.rc-virtual-list  div.cheetah-select-item >> text={publish_date_day}').click()
        await page.wait_for_timeout(2000)

        for _ in range(3):
            try:
                await page.locator('div.select-wrap').nth(1).click()
                await page.wait_for_selector('div.rc-virtual-list div.rc-virtual-list-holder-inner:visible', timeout=5000)
                break
            except:
                await page.locator('div.select-wrap').nth(1).click()
        await page.wait_for_timeout(2000)
        current_choice_hour = await page.locator('div.rc-virtual-list:visible div.cheetah-select-item-option').count()
        await page.wait_for_timeout(2000)
        await page.locator('div.rc-virtual-list:visible div.cheetah-select-item-option').nth(
            random.randint(1, max(1, current_choice_hour - 3))).click()

        await page.wait_for_timeout(2000)
        await page.locator("button >> text=定时发布").click()

    async def handle_upload_error(self, page):
        return

    async def close_popconfirm(self, page):
        """关闭可能出现的弹窗"""
        try:
            close_btn = page.locator('div.ant-modal-confirm-btns button')
            if await close_btn.count():
                await close_btn.first.click()
                await page.wait_for_timeout(500)
        except Exception:
            pass

    async def upload(self, playwright: Playwright) -> None:
        browser = await playwright.chromium.launch(
            headless=self.headless,
            executable_path=self.local_executable_path,
            proxy=self.proxy_setting
        )
        context = await browser.new_context(
            storage_state=f"{self.account_file}",
            user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.4324.150 Safari/537.36'
        )
        await context.grant_permissions(['geolocation'])

        closed = False
        try:
            page = await context.new_page()
            await page.goto(BAIJIAHAO_UPLOAD_URL, timeout=60000)
            baijiahao_logger.info(f"正在上传-------{self.title}.mp4")
            baijiahao_logger.info('正在打开主页...')
            await page.wait_for_url("https://baijiahao.baidu.com/builder/rc/edit?type=videoV2", timeout=60000)

            await page.locator("div[class^='video-main-container'] input").set_input_files(self.file_path)

            while True:
                try:
                    await page.wait_for_selector("div#formMain:visible")
                    break
                except:
                    baijiahao_logger.info("正在等待进入视频发布页面...")
                    await asyncio.sleep(0.1)

            await asyncio.sleep(1)
            baijiahao_logger.info("正在填充标题和话题...")
            await self.add_title_tags(page)

            upload_status = await self.uploading_video(page)
            if not upload_status:
                baijiahao_logger.error(f"发现上传出错了... 文件:{self.file_path}")
                raise Exception("视频上传失败")

            while True:
                baijiahao_logger.info("正在确认封面完成, 准备去点击定时/发布...")
                if await page.locator("div.cheetah-spin-container img").count():
                    baijiahao_logger.info("封面已完成，点击定时/发布...")
                    break
                else:
                    baijiahao_logger.info("等待封面生成...")
                    await asyncio.sleep(3)

            await self.close_popconfirm(page)
            await self.publish_video(page, self.publish_date)
            await page.wait_for_timeout(2000)
            if await page.locator('div.passMod_dialog-container >> text=百度安全验证:visible').count():
                baijiahao_logger.error("出现验证，退出")
                raise Exception("出现验证，退出")
            await page.wait_for_url("https://baijiahao.baidu.com/builder/rc/clue**", timeout=5000)
            baijiahao_logger.success("视频发布成功")

            await context.storage_state(path=self.account_file)
            baijiahao_logger.info('cookie更新完毕！')
            await asyncio.sleep(2)
            await context.close()
            await browser.close()
            closed = True
        finally:
            if not closed:
                await context.close()
                await browser.close()

    @async_retry(timeout=300)
    async def uploading_video(self, page):
        while True:
            upload_failed = await page.locator('div .cover-overlay:has-text("上传失败")').count()
            if upload_failed:
                baijiahao_logger.error("发现上传出错了...")
                return False

            uploading = await page.locator('div .cover-overlay:has-text("上传中")').count()
            if uploading:
                baijiahao_logger.info("正在上传视频中...")
                await asyncio.sleep(2)
                continue

            if not uploading and not upload_failed:
                baijiahao_logger.success("视频上传完毕")
                return True

    async def set_schedule_publish(self, page, publish_date):
        while True:
            schedule_element = page.locator("div.op-btn-outter-content >> text=定时发布").locator("..").locator('button')
            try:
                await schedule_element.click()
                await page.wait_for_selector('div.select-wrap:visible', timeout=3000)
                await page.wait_for_timeout(timeout=2000)
                baijiahao_logger.info("开始点击发布定时...")
                await self.set_schedule_time(page, publish_date)
                break
            except Exception as e:
                baijiahao_logger.error(f"定时发布失败: {e}")
                raise

    @async_retry(timeout=300)
    async def publish_video(self, page: Page, publish_date):
        if publish_date != 0:
            await self.set_schedule_publish(page, publish_date)
        else:
            await self.direct_publish(page)

    async def direct_publish(self, page):
        try:
            publish_button = page.locator("button >> text=发布")
            if await publish_button.count():
                await publish_button.click()
        except Exception as e:
            baijiahao_logger.error(f"直接发布视频失败: {e}")
            raise

    async def add_title_tags(self, page):
        # 尝试多种方式定位标题输入框
        title_container = page.get_by_placeholder('添加标题获得更多推荐')
        if not await title_container.count():
            title_container = page.locator('input[placeholder*="标题"]').first
        if not await title_container.count():
            title_container = page.locator('textarea[placeholder*="标题"]').first

        if len(self.title) <= 8:
            self.title += " 你不知道的"
        await title_container.fill(self.title[:30])

    async def main(self):
        async with async_playwright() as playwright:
            await self.upload(playwright)
