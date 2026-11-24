# -*- coding: utf-8 -*-
import asyncio
import inspect
import json
import os
import pathlib
import random
from biliup.plugins.bili_webup import BiliBili, Data

from conf import LOCAL_CHROME_PATH, LOCAL_CHROME_HEADLESS
from sau_utils.base_social_media import set_init_script
from sau_utils.interactive_browser import InteractiveBrowser
from sau_utils.login_qrcode import build_login_qrcode_path, remove_qrcode_file, save_data_url_image
from sau_utils.log import bilibili_logger


def extract_keys_from_json(data):
    """Extract specified keys from the provided JSON data.
    Supports both biliup format {cookie_info: {cookies: [...]}} 
    and Playwright storage_state format {cookies: [{name, value, domain}...]}
    """
    keys_to_extract = ["SESSDATA", "bili_jct", "DedeUserID__ckMd5", "DedeUserID", "access_token"]
    extracted_data = {}

    if 'cookie_info' in data:
        # biliup 格式
        for cookie in data['cookie_info']['cookies']:
            if cookie['name'] in keys_to_extract:
                extracted_data[cookie['name']] = cookie['value']
        if "access_token" in data.get('token_info', {}):
            extracted_data['access_token'] = data['token_info']['access_token']
    elif 'cookies' in data:
        # Playwright storage_state 格式
        for cookie in data['cookies']:
            if cookie.get('name') in keys_to_extract:
                extracted_data[cookie['name']] = cookie.get('value', '')
    else:
        raise ValueError("无法识别的B站cookie格式，请重新登录B站")

    return extracted_data


def read_cookie_json_file(filepath: pathlib.Path):
    with open(filepath, 'r', encoding='utf-8') as file:
        content = json.load(file)
        return content


def random_emoji():
    emoji_list = [
        "\U0001f34f", "\U0001f34e", "\U0001f34a", "\U0001f34b", "\U0001f34c",
        "\U0001f349", "\U0001f347", "\U0001f353", "\U0001f348", "\U0001f352",
        "\U0001f351", "\U0001f34d", "\U0001f96d", "\U0001f965", "\U0001f95d",
    ]
    return random.choice(emoji_list)


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


async def _save_bilibili_qrcode(page, account_file: str, qrcode_callback=None) -> dict:
    selectors = (
        'div.login-scan-box canvas',
        'div.login-scan-box img',
        'img[alt="Scan me!"]',
        'img[src^="data:image/"]',
        'canvas',
        'img[alt*="qrcode"]',
        'img[alt*="二维码"]',
        'img[src*="qrcode"]',
    )
    qrcode_locator = None
    for _ in range(120):
        for selector in selectors:
            candidate = page.locator(selector).first
            try:
                if await candidate.count() and await candidate.is_visible():
                    qrcode_locator = candidate
                    break
            except Exception:
                continue
        if qrcode_locator is not None:
            break
        await page.wait_for_timeout(250)
    if qrcode_locator is None:
        raise RuntimeError("未在B站登录页面找到二维码")

    qrcode_path = build_login_qrcode_path(account_file, suffix="bilibili_login_qrcode")
    qrcode_src = await qrcode_locator.get_attribute("src") or ""
    if qrcode_src.startswith("data:image/"):
        save_data_url_image(qrcode_src, qrcode_path)
    else:
        qrcode_path.parent.mkdir(parents=True, exist_ok=True)
        await qrcode_locator.screenshot(path=str(qrcode_path))
    qrcode_info = {"image_path": str(qrcode_path), "image_data_url": qrcode_src}
    await _emit_qrcode_callback(qrcode_callback, qrcode_info)
    return qrcode_info


async def bilibili_cookie_gen(account_file, qrcode_callback=None, headless: bool = LOCAL_CHROME_HEADLESS):
    """打开浏览器让用户扫码登录B站，将浏览器cookie转换为biliup格式保存"""
    from playwright.async_api import async_playwright
    async with async_playwright() as playwright:
        options = {
            'args': ['--lang zh-CN'],
            'headless': headless,
        }
        if LOCAL_CHROME_PATH:
            options['executable_path'] = LOCAL_CHROME_PATH
        browser = await playwright.chromium.launch(**options)
        context = await browser.new_context()
        context = await set_init_script(context)
        qrcode_path = None
        result = _build_login_result(False, "failed", "B站登录失败", account_file)
        try:
            page = await context.new_page()
            await page.goto("https://passport.bilibili.com/login", wait_until="commit", timeout=60000)
            qrcode_info = await _save_bilibili_qrcode(page, account_file, qrcode_callback=qrcode_callback)
            qrcode_path = pathlib.Path(qrcode_info["image_path"])
            bilibili_logger.info("请使用B站手机端扫描网页展示的二维码")

            logged_in = False
            interaction = InteractiveBrowser(qrcode_callback)
            for _ in range(120):
                await interaction.wait(page, 1)
                current_url = page.url
                if "www.bilibili.com" in current_url or "space.bilibili.com" in current_url:
                    logged_in = True
                    bilibili_logger.info(f"检测到登录成功，当前页面: {current_url}")
                    break
            if not logged_in:
                return _build_login_result(False, "timeout", "等待B站扫码登录超时", account_file, qrcode_info, page.url)

            await page.wait_for_timeout(2000)
            browser_cookies = await context.cookies()
            bili_cookies = [
                {'name': cookie['name'], 'value': cookie['value']}
                for cookie in browser_cookies
                if cookie.get('domain', '').endswith('.bilibili.com') or cookie.get('domain', '').endswith('.biligame.com')
            ]
            if not any(cookie.get('name') == 'SESSDATA' for cookie in bili_cookies):
                return _build_login_result(False, "cookie_invalid", "B站扫码完成，但登录态校验失败", account_file, qrcode_info, page.url)
            cookie_data = {
                'cookie_info': {'cookies': bili_cookies},
                'token_info': {'access_token': ''}
            }
            pathlib.Path(account_file).parent.mkdir(parents=True, exist_ok=True)
            with open(account_file, 'w', encoding='utf-8') as f:
                json.dump(cookie_data, f, ensure_ascii=False, indent=2)
            bilibili_logger.success("B站 cookie saved via browser")
            result = _build_login_result(True, "success", "B站扫码登录成功", account_file, qrcode_info, page.url)
            return result
        except Exception as exc:
            result = _build_login_result(False, "failed", str(exc), account_file, current_url=page.url if "page" in locals() else "")
            return result
        finally:
            remove_qrcode_file(qrcode_path)
            await context.close()
            await browser.close()


async def cookie_auth(account_file):
    """检查B站cookie是否有效"""
    try:
        with open(account_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
        sessdata = ''
        # 支持 biliup 格式: {cookie_info: {cookies: [...]}}
        if 'cookie_info' in data:
            for c in data['cookie_info'].get('cookies', []):
                if c.get('name') == 'SESSDATA':
                    sessdata = c.get('value', '')
                    break
        # 支持 Playwright storage_state 格式: {cookies: [{name, value, domain}...]}
        if not sessdata and 'cookies' in data:
            for c in data['cookies']:
                if c.get('name') == 'SESSDATA':
                    sessdata = c.get('value', '')
                    break
        if not sessdata:
            bilibili_logger.error("B站 cookie 中无 SESSDATA，请重新登录")
            return False
        import urllib.request
        req = urllib.request.Request(
            'https://api.bilibili.com/x/web-interface/nav',
            headers={'Cookie': f'SESSDATA={sessdata}', 'User-Agent': 'Mozilla/5.0'}
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read().decode('utf-8'))
        if result.get('code') == 0 and result.get('data', {}).get('isLogin'):
            bilibili_logger.success("[+] B站 cookie 有效")
            return True
        else:
            bilibili_logger.error("B站 cookie 已失效")
            return False
    except Exception as e:
        bilibili_logger.error(f"B站 cookie 验证失败: {e}")
        return False


async def bilibili_setup(account_file, handle=False, return_detail=False, qrcode_callback=None, headless: bool = LOCAL_CHROME_HEADLESS):
    """B站登录入口，与其他平台保持一致的接口"""
    if not os.path.exists(account_file) or not await cookie_auth(account_file):
        if not handle:
            result = _build_login_result(False, "cookie_invalid", "cookie文件不存在或已失效", account_file)
            return result if return_detail else False
        bilibili_logger.info("cookie文件不存在或已失效，准备获取B站扫码二维码")
        result = await bilibili_cookie_gen(account_file, qrcode_callback=qrcode_callback, headless=headless)
        return result if return_detail else result["success"]
    result = _build_login_result(True, "cookie_valid", "cookie有效", account_file)
    return result if return_detail else True


class BilibiliUploader(object):
    def __init__(self, cookie_data, file: pathlib.Path, title, desc, tid, tags, dtime):
        self.upload_thread_num = 3
        self.copyright = 1
        self.lines = 'AUTO'
        self.cookie_data = cookie_data
        self.file = file
        self.title = title
        self.desc = desc
        self.tid = tid
        self.tags = tags
        self.dtime = dtime
        self._init_data()

    def _init_data(self):
        self.data = Data()
        self.data.copyright = self.copyright
        self.data.title = self.title
        self.data.desc = self.desc
        self.data.tid = self.tid
        self.data.set_tag(self.tags)
        self.data.dtime = self.dtime

    def upload(self):
        with BiliBili(self.data) as bili:
            bili.login_by_cookies(self.cookie_data)
            bili.access_token = self.cookie_data.get('access_token', '')
            video_part = bili.upload_file(str(self.file), lines=self.lines,
                                          tasks=self.upload_thread_num)
            video_part['title'] = self.title
            self.data.append(video_part)
            ret = bili.submit()
            bilibili_logger.info(f'[B站] submit返回: {ret}')
            if ret.get('code') == 0:
                bilibili_logger.success(f'[+] {self.file.name} upload success')
                return True
            else:
                bilibili_logger.error(f'[-] {self.file.name} upload failed: {ret}')
                return False
