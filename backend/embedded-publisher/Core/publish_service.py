#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
视频发布服务模块
集成 social-auto-upload 开源项目的上传能力
支持：抖音、视频号、小红书、快手、B站、百家号
"""

import os
import sys
import json
import asyncio
import subprocess
import threading
from pathlib import Path
from datetime import datetime
from typing import Optional, Dict, Any, List

# 确保项目根目录在 sys.path 中，以便 uploader 模块能正确导入 conf 和 sau_utils
PROJECT_ROOT = Path(__file__).parent.parent.resolve()
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


def log_info(msg):
    print(f"[Publish] {msg}")

def log_warning(msg):
    print(f"[Publish] WARNING: {msg}")

def log_error(msg):
    print(f"[Publish] ERROR: {msg}")


def _run_async(coro):
    """在独立线程中运行异步协程，避免 asyncio.run() 在已有事件循环时报错"""
    result = None
    error = None

    def _thread_target():
        nonlocal result, error
        try:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                result = loop.run_until_complete(coro)
            finally:
                loop.close()
        except Exception as e:
            error = e

    t = threading.Thread(target=_thread_target)
    t.start()
    t.join()

    if error is not None:
        raise error
    return result


class PublishService:
    """视频发布服务 - 基于 social-auto-upload 开源项目"""

    # 支持的平台配置
    PLATFORMS = {
        'douyin': {
            'name': '抖音',
            'cookie_dir': 'douyin_uploader',
            'cookie_file': 'account.json',
            'login_url': 'https://creator.douyin.com/',
        },
        'tencent': {
            'name': '视频号',
            'cookie_dir': 'tencent_uploader',
            'cookie_file': 'account.json',
            'login_url': 'https://channels.weixin.qq.com/',
        },
        'xiaohongshu': {
            'name': '小红书',
            'cookie_dir': 'xiaohongshu_uploader',
            'cookie_file': 'account.json',
            'login_url': 'https://creator.xiaohongshu.com/login',
        },
        'kuaishou': {
            'name': '快手',
            'cookie_dir': 'ks_uploader',
            'cookie_file': 'account.json',
            'login_url': 'https://passport.kuaishou.com/pc/account/login/?sid=kuaishou.web.cp.api&callback=https%3A%2F%2Fcp.kuaishou.com%2Frest%2Finfra%2Fsts%3FfollowUrl%3Dhttps%253A%252F%252Fcp.kuaishou.com%252Farticle%252Fpublish%252Fvideo%26setRootDomain%3Dtrue',
        },
        'bilibili': {
            'name': 'B站',
            'cookie_dir': 'bilibili_uploader',
            'cookie_file': 'account.json',
            'login_url': 'https://www.bilibili.com/',
        },
        'baijiahao': {
            'name': '百家号',
            'cookie_dir': 'baijiahao_uploader',
            'cookie_file': 'account.json',
            'login_url': 'https://baijiahao.baidu.com/builder/theme/bjh/login',
        },
    }

    def __init__(self):
        self.project_root = PROJECT_ROOT
        configured_session_root = os.getenv('IP_AGENT_PUBLISH_SESSION_ROOT', '').strip()
        self.cookies_dir = Path(configured_session_root).resolve() if configured_session_root else self.project_root / 'cookies'
        self.cookies_dir.mkdir(parents=True, exist_ok=True)
        # 为每个平台创建 cookie 目录
        for platform, config in self.PLATFORMS.items():
            (self.cookies_dir / config['cookie_dir']).mkdir(parents=True, exist_ok=True)
        # Chrome 路径
        self.chrome_path = self._find_chrome()

    def _find_chrome(self) -> Optional[str]:
        """查找 Chrome 浏览器路径"""
        try:
            from conf import LOCAL_CHROME_PATH
            if LOCAL_CHROME_PATH and os.path.exists(LOCAL_CHROME_PATH):
                return LOCAL_CHROME_PATH
        except Exception:
            pass

        possible_paths = [
            r'C:\Program Files\Google\Chrome\Application\chrome.exe',
            r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
            os.path.expandvars(r'%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe'),
            r'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
            r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
            os.path.expandvars(r'%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe'),
        ]
        for path in possible_paths:
            if os.path.exists(path):
                return path
        return None

    def _get_account_file(self, platform: str) -> str:
        """获取平台的 cookie 文件路径"""
        config = self.PLATFORMS.get(platform)
        if not config:
            return ''
        return str(self.cookies_dir / config['cookie_dir'] / config['cookie_file'])

    def get_status(self) -> Dict[str, Any]:
        """获取发布服务状态"""
        return {
            'available': True,
            'chrome_path': self.chrome_path,
            'cookies_dir': str(self.cookies_dir),
            'platforms': list(self.PLATFORMS.keys()),
        }

    def start_chrome_debug(self) -> Dict[str, Any]:
        """启动 Chrome 调试模式（兼容旧接口）"""
        if not self.chrome_path:
            return {'success': True, 'message': 'Chrome路径未配置，将使用Playwright内置浏览器'}
        try:
            user_data_dir = self.project_root / 'Chrome' / 'UserData'
            user_data_dir.mkdir(parents=True, exist_ok=True)
            cmd = [
                self.chrome_path,
                f'--remote-debugging-port=9222',
                f'--user-data-dir={user_data_dir}',
            ]
            subprocess.Popen(cmd, shell=False)
            log_info("Chrome 调试模式已启动")
            return {'success': True, 'message': 'Chrome 已启动'}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def check_login_status(self, platform: str) -> Dict[str, Any]:
        """检查平台登录状态（检查cookie文件是否存在）"""
        account_file = self._get_account_file(platform)
        if not account_file or not os.path.exists(account_file):
            return {'logged_in': False, 'message': '未登录'}
        try:
            with open(account_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
            # 检查是否有有效数据
            if isinstance(data, dict):
                cookies = data.get('cookies', [])
                # 兼容B站 biliup 格式: {cookie_info: {cookies: [...]}}
                if not cookies and 'cookie_info' in data:
                    cookies = data.get('cookie_info', {}).get('cookies', [])
                if cookies:
                    return {'logged_in': True, 'message': '已登录', 'cookie_count': len(cookies)}
            elif isinstance(data, list) and len(data) > 0:
                return {'logged_in': True, 'message': '已登录'}
            return {'logged_in': False, 'message': 'Cookie 为空'}
        except Exception as e:
            return {'logged_in': False, 'message': f'读取失败: {e}'}

    def validate_login_status(self, platform: str) -> Dict[str, Any]:
        """Validate the stored browser session against the platform."""
        account_file = self._get_account_file(platform)
        if not account_file or not os.path.exists(account_file):
            return {'success': True, 'logged_in': False, 'message': '未登录'}
        try:
            valid = _run_async(self._validate_login_async(platform, account_file))
            return {
                'success': True,
                'logged_in': bool(valid),
                'message': '登录态有效' if valid else '登录态无效或已过期',
            }
        except Exception as e:
            return {'success': False, 'logged_in': False, 'error': str(e), 'message': f'登录态检查失败: {e}'}

    async def _validate_login_async(self, platform: str, account_file: str) -> bool:
        if platform == 'douyin':
            from uploader.douyin_uploader.main import douyin_setup
            return bool(await douyin_setup(account_file, handle=False))
        if platform == 'tencent':
            from uploader.tencent_uploader.main import weixin_setup
            return bool(await weixin_setup(account_file, handle=False))
        if platform == 'xiaohongshu':
            from uploader.xiaohongshu_uploader.main import xiaohongshu_setup
            return bool(await xiaohongshu_setup(account_file, handle=False))
        if platform == 'kuaishou':
            from uploader.ks_uploader.main import ks_setup
            return bool(await ks_setup(account_file, handle=False))
        if platform == 'bilibili':
            from uploader.bilibili_uploader.main import bilibili_setup
            return bool(await bilibili_setup(account_file, handle=False))
        if platform == 'baijiahao':
            from uploader.baijiahao_uploader.main import baijiahao_setup
            return bool(await baijiahao_setup(account_file, handle=False))
        return False

    def clear_login(self, platform: str) -> Dict[str, Any]:
        """清除指定平台的登录信息"""
        config = self.PLATFORMS.get(platform)
        if not config:
            return {'success': False, 'error': f'未知平台: {platform}'}
        platform_name = config['name']
        account_file = self._get_account_file(platform)
        if not account_file or not os.path.exists(account_file):
            return {'success': True, 'message': f'{platform_name} 未登录，无需清除'}
        try:
            os.remove(account_file)
            log_info(f"已清除 {platform_name} 登录信息: {account_file}")
            return {'success': True, 'message': f'{platform_name} 已退出登录'}
        except Exception as e:
            return {'success': False, 'error': f'清除失败: {e}'}

    def get_platform_cookie(self, platform: str, qrcode_callback=None, headless: bool = True) -> Dict[str, Any]:
        """生成平台 Cookie（通过 Playwright 打开浏览器让用户登录）"""
        account_file = self._get_account_file(platform)
        if not account_file:
            return {'success': False, 'error': f'未知平台: {platform}'}

        try:
            result = _run_async(self._generate_cookie_async(
                platform,
                account_file,
                qrcode_callback=qrcode_callback,
                headless=headless,
            ))
            return result
        except Exception as e:
            log_error(f"获取 Cookie 失败: {e}")
            return {'success': False, 'error': str(e)}

    async def _generate_cookie_async(self, platform: str, account_file: str, qrcode_callback=None, headless: bool = True) -> Dict[str, Any]:
        """异步生成 Cookie - 打开浏览器让用户登录"""
        try:
            from playwright.async_api import async_playwright
        except ImportError:
            return {'success': False, 'error': 'Playwright 未安装，请运行: pip install playwright && playwright install chromium'}

        config = self.PLATFORMS.get(platform)
        if not config:
            return {'success': False, 'error': f'未知平台: {platform}'}

        try:
            # 确保目录存在
            Path(account_file).parent.mkdir(parents=True, exist_ok=True)

            # 使用各平台的 setup 函数（handle=True 会打开浏览器让用户登录）
            if platform == 'douyin':
                from uploader.douyin_uploader.main import douyin_setup
                result = await douyin_setup(account_file, handle=True, return_detail=True, qrcode_callback=qrcode_callback, headless=headless)
            elif platform == 'tencent':
                from uploader.tencent_uploader.main import weixin_setup
                result = await weixin_setup(account_file, handle=True, return_detail=True, qrcode_callback=qrcode_callback, headless=headless)
            elif platform == 'xiaohongshu':
                from uploader.xiaohongshu_uploader.main import xiaohongshu_setup
                result = await xiaohongshu_setup(account_file, handle=True, return_detail=True, qrcode_callback=qrcode_callback, headless=headless)
            elif platform == 'kuaishou':
                from uploader.ks_uploader.main import ks_setup
                result = await ks_setup(account_file, handle=True, return_detail=True, qrcode_callback=qrcode_callback, headless=headless)
            elif platform == 'baijiahao':
                from uploader.baijiahao_uploader.main import baijiahao_setup
                result = await baijiahao_setup(account_file, handle=True, return_detail=True, qrcode_callback=qrcode_callback, headless=headless)
            elif platform == 'bilibili':
                from uploader.bilibili_uploader.main import bilibili_setup
                result = await bilibili_setup(account_file, handle=True, return_detail=True, qrcode_callback=qrcode_callback, headless=headless)
            else:
                return {'success': False, 'error': f'不支持的平台: {platform}'}

            if isinstance(result, dict):
                return result
            if result:
                return {'success': True, 'message': f'{config["name"]} 登录成功'}
            return {'success': False, 'error': f'{config["name"]} 登录失败或取消'}

        except Exception as e:
            log_error(f"生成 {platform} Cookie 失败: {e}")
            import traceback
            traceback.print_exc()
            return {'success': False, 'error': str(e)}

    async def _bilibili_login(self, account_file: str) -> Dict[str, Any]:
        """B站登录 - 使用 biliup.exe"""
        biliup_path = self.project_root / 'uploader' / 'bilibili_uploader' / 'biliup.exe'
        if not biliup_path.exists():
            return {'success': False, 'error': 'biliup.exe 未找到，请确保文件存在'}
        try:
            import sys
            # Windows 下创建新控制台窗口，让用户能看到二维码
            create_flags = 0
            if sys.platform == 'win32':
                create_flags = subprocess.CREATE_NEW_CONSOLE
            proc = subprocess.Popen(
                [str(biliup_path), '-u', account_file, 'login'],
                cwd=str(biliup_path.parent),
                creationflags=create_flags
            )
            proc.wait(timeout=120)
            if os.path.exists(account_file):
                return {'success': True, 'message': 'B站登录成功'}
            else:
                return {'success': False, 'error': 'B站登录失败'}
        except subprocess.TimeoutExpired:
            return {'success': False, 'error': '登录超时'}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    # ==================== 发布功能 ====================

    def publish_video(self, platform: str, video_path: str, title: str, tags: List[str], cover_path: Optional[str] = None, is_draft: bool = False, submit_wait: int = 3, publish_date: datetime | int = 0) -> Dict[str, Any]:
        """发布视频到指定平台"""
        if not os.path.exists(video_path):
            return {'success': False, 'error': f'视频文件不存在: {video_path}'}

        account_file = self._get_account_file(platform)
        if not account_file or not os.path.exists(account_file):
            return {'success': False, 'error': f'请先登录{self.PLATFORMS.get(platform, {}).get("name", platform)}'}

        try:
            result = _run_async(self._publish_video_async(platform, video_path, title, tags, account_file, cover_path, is_draft=is_draft, submit_wait=submit_wait, publish_date=publish_date))
            return result
        except Exception as e:
            log_error(f"发布失败: {e}")
            import traceback
            traceback.print_exc()
            return {'success': False, 'error': str(e)}

    async def _publish_video_async(self, platform: str, video_path: str, title: str, tags: List[str], account_file: str, cover_path: Optional[str] = None, is_draft: bool = False, submit_wait: int = 3, publish_date: datetime | int = 0) -> Dict[str, Any]:
        """异步发布视频到指定平台"""
        config = self.PLATFORMS.get(platform)
        platform_name = config['name'] if config else platform

        try:
            if publish_date and is_draft:
                return {'success': False, 'error': '定时发布不能和保存草稿同时使用'}
            if publish_date and platform == 'bilibili':
                return {'success': False, 'error': 'B站暂不支持定时发布，请取消 B站或改为立即发布'}
            if publish_date and platform == 'baijiahao':
                return {'success': False, 'error': '百家号暂不支持定时发布，请取消 百家号或改为立即发布'}

            if platform == 'douyin':
                return await self._publish_douyin(video_path, title, tags, account_file, cover_path, is_draft=is_draft, submit_wait=submit_wait, publish_date=publish_date)
            elif platform == 'tencent':
                return await self._publish_tencent(video_path, title, tags, account_file, cover_path=cover_path, is_draft=is_draft, submit_wait=submit_wait, publish_date=publish_date)
            elif platform == 'xiaohongshu':
                return await self._publish_xiaohongshu(video_path, title, tags, account_file, cover_path, is_draft=is_draft, publish_date=publish_date)
            elif platform == 'kuaishou':
                return await self._publish_kuaishou(video_path, title, tags, account_file, cover_path=cover_path, is_draft=is_draft, publish_date=publish_date)
            elif platform == 'bilibili':
                return await self._publish_bilibili(video_path, title, tags, account_file, is_draft=is_draft)
            elif platform == 'baijiahao':
                return await self._publish_baijiahao(video_path, title, tags, account_file, is_draft=is_draft)
            else:
                return {'success': False, 'error': f'不支持的平台: {platform}'}
        except Exception as e:
            log_error(f"{platform_name} 发布失败: {e}")
            import traceback
            traceback.print_exc()
            return {'success': False, 'error': str(e)}

    async def _publish_douyin(self, video_path: str, title: str, tags: List[str], account_file: str, cover_path: Optional[str] = None, is_draft: bool = False, submit_wait: int = 3, publish_date: datetime | int = 0) -> Dict[str, Any]:
        """发布到抖音"""
        from uploader.douyin_uploader.main import DouYinVideo, DOUYIN_PUBLISH_STRATEGY_IMMEDIATE, DOUYIN_PUBLISH_STRATEGY_SCHEDULED
        log_info(f"📤 发布到抖音: {title} (草稿={is_draft})")
        publish_strategy = DOUYIN_PUBLISH_STRATEGY_SCHEDULED if publish_date else DOUYIN_PUBLISH_STRATEGY_IMMEDIATE
        app = DouYinVideo(title, video_path, tags, publish_date or 0, account_file, thumbnail_path=cover_path, is_draft=is_draft, publish_strategy=publish_strategy)
        app.submit_wait = submit_wait
        try:
            await app.main()
            message = '抖音页面已填写完成，已检测到你手动保存草稿' if is_draft else '抖音发布成功'
            return {'success': True, 'message': message}
        except Exception as e:
            log_error(f"抖音发布失败: {e}")
            import traceback
            traceback.print_exc()
            return {
                'success': False,
                'error': '抖音发布失败：请检查抖音账号是否已登录，是否出现验证码或风控验证，视频文件是否可访问；处理后请重试。'
            }

    async def _publish_tencent(self, video_path: str, title: str, tags: List[str], account_file: str, cover_path: Optional[str] = None, is_draft: bool = False, submit_wait: int = 3, publish_date: datetime | int = 0) -> Dict[str, Any]:
        """发布到视频号"""
        from uploader.tencent_uploader.main import TencentVideo, TENCENT_PUBLISH_STRATEGY_IMMEDIATE, TENCENT_PUBLISH_STRATEGY_SCHEDULED
        log_info(f"📤 发布到视频号: {title} (草稿={is_draft})")
        publish_strategy = TENCENT_PUBLISH_STRATEGY_SCHEDULED if publish_date else TENCENT_PUBLISH_STRATEGY_IMMEDIATE
        app = TencentVideo(title, video_path, tags, publish_date or 0, account_file, is_draft=is_draft, thumbnail_path=cover_path, publish_strategy=publish_strategy)
        app.submit_wait = submit_wait
        try:
            await app.main()
            message = '视频号页面已填写完成，已检测到你手动保存草稿' if is_draft else '视频号发布成功'
            return {'success': True, 'message': message}
        except Exception as e:
            return {'success': False, 'error': f'视频号发布失败: {e}'}

    async def _publish_xiaohongshu(self, video_path: str, title: str, tags: List[str], account_file: str, cover_path: Optional[str] = None, is_draft: bool = False, publish_date: datetime | int = 0) -> Dict[str, Any]:
        """发布到小红书"""
        from uploader.xiaohongshu_uploader.main import XiaoHongShuVideo, XIAOHONGSHU_PUBLISH_STRATEGY_IMMEDIATE, XIAOHONGSHU_PUBLISH_STRATEGY_SCHEDULED
        log_info(f"📤 发布到小红书: {title} (草稿={is_draft})")
        publish_strategy = XIAOHONGSHU_PUBLISH_STRATEGY_SCHEDULED if publish_date else XIAOHONGSHU_PUBLISH_STRATEGY_IMMEDIATE
        app = XiaoHongShuVideo(title, video_path, tags, publish_date or 0, account_file, thumbnail_path=cover_path, is_draft=is_draft, publish_strategy=publish_strategy)
        try:
            await app.main()
            message = '小红书页面已填写完成，已检测到你手动保存草稿' if is_draft else '小红书发布成功'
            return {'success': True, 'message': message}
        except Exception as e:
            return {'success': False, 'error': f'小红书发布失败: {e}'}

    async def _publish_kuaishou(self, video_path: str, title: str, tags: List[str], account_file: str, cover_path: Optional[str] = None, is_draft: bool = False, publish_date: datetime | int = 0) -> Dict[str, Any]:
        """发布到快手"""
        from uploader.ks_uploader.main import KSVideo
        log_info(f"📤 发布到快手: {title} (草稿={is_draft})")
        app = KSVideo(title, video_path, tags, publish_date or 0, account_file, thumbnail_path=cover_path, is_draft=is_draft)
        try:
            await app.main()
            message = '快手页面已填写完成，已检测到你手动保存草稿' if is_draft else '快手发布成功'
            return {'success': True, 'message': message}
        except Exception as e:
            return {'success': False, 'error': f'快手发布失败: {e}'}

    async def _publish_bilibili(self, video_path: str, title: str, tags: List[str], account_file: str, is_draft: bool = False) -> Dict[str, Any]:
        """发布到B站"""
        try:
            if is_draft:
                return {'success': False, 'error': 'B站暂不支持保存草稿，请选择直接发布或取消 B站'}
            from uploader.bilibili_uploader.main import read_cookie_json_file, extract_keys_from_json, random_emoji, BilibiliUploader
        except ImportError as e:
            return {'success': False, 'error': f'B站上传模块导入失败: {e}，请安装 biliup: pip install biliup'}

        log_info(f"📤 发布到B站: {title}")
        try:
            if not os.path.exists(account_file):
                return {'success': False, 'error': '请先登录B站'}
            cookie_data = read_cookie_json_file(Path(account_file))
            log_info(f"[B站] cookie文件已读取，格式keys: {list(cookie_data.keys())}")
            cookie_data = extract_keys_from_json(cookie_data)
            log_info(f"[B站] 提取到的cookie字段: {list(cookie_data.keys())}")
            # B站不允许相同标题，加个emoji
            bili_title = title + random_emoji()
            # tags不能为空，biliup要求至少一个tag
            bili_tags = tags[:5] if tags else ['视频']
            # tid=17 是生活分区
            bili_uploader = BilibiliUploader(cookie_data, Path(video_path), bili_title, title, 17, bili_tags, 0)
            log_info(f"[B站] 开始上传: {video_path}")
            success = bili_uploader.upload()
            if success:
                return {'success': True, 'message': 'B站发布成功'}
            else:
                return {'success': False, 'error': 'B站上传返回失败，请查看控制台日志'}
        except Exception as e:
            import traceback
            err_detail = traceback.format_exc()
            log_error(f"[B站] 发布异常: {err_detail}")
            return {'success': False, 'error': f'B站发布失败: {e}'}

    async def _publish_baijiahao(self, video_path: str, title: str, tags: List[str], account_file: str, is_draft: bool = False) -> Dict[str, Any]:
        """发布到百家号"""
        if is_draft:
            return {'success': False, 'error': '百家号暂不支持保存草稿，请选择直接发布或取消 百家号'}
        from uploader.baijiahao_uploader.main import BaiJiaHaoVideo
        log_info(f"📤 发布到百家号: {title}")
        app = BaiJiaHaoVideo(title, video_path, tags, 0, account_file)
        try:
            await app.main()
            return {'success': True, 'message': '百家号发布成功'}
        except Exception as e:
            return {'success': False, 'error': f'百家号发布失败: {e}'}

    # ==================== 批量发布 ====================

    async def _publish_all_async(self, video_path: str, title: str, tags: List[str], cover_path: Optional[str], platforms: List[str], is_draft: bool = False, submit_wait: int = 3, publish_date: datetime | int = 0) -> Dict[str, Any]:
        """顺序发布到所有平台"""
        import asyncio
        results = {}
        for idx, platform in enumerate(platforms):
            config = self.PLATFORMS.get(platform, {})
            platform_name = config.get('name', platform)
            log_info(f"发布到 {platform_name}...")

            if is_draft and platform == 'bilibili':
                results[platform] = {'success': False, 'error': 'B站暂不支持保存草稿，请选择直接发布或取消 B站'}
                continue
            if is_draft and platform == 'baijiahao':
                results[platform] = {'success': False, 'error': '百家号暂不支持保存草稿，请选择直接发布或取消 百家号'}
                continue
            if publish_date and platform == 'bilibili':
                results[platform] = {'success': False, 'error': 'B站暂不支持定时发布，请取消 B站或改为立即发布'}
                continue
            if publish_date and platform == 'baijiahao':
                results[platform] = {'success': False, 'error': '百家号暂不支持定时发布，请取消 百家号或改为立即发布'}
                continue

            account_file = self._get_account_file(platform)
            if not account_file or not os.path.exists(account_file):
                results[platform] = {'success': False, 'error': f'请先登录{platform_name}'}
                continue

            try:
                result = await self._publish_video_async(platform, video_path, title, tags, account_file, cover_path, is_draft=is_draft, submit_wait=submit_wait, publish_date=publish_date)
                results[platform] = result
            except Exception as e:
                log_error(f"{platform_name} 发布失败: {e}")
                results[platform] = {'success': False, 'error': str(e)}

            # 平台之间等待5秒，避免操作过快
            if idx < len(platforms) - 1:
                log_info(f"等待5秒后发布下一个平台...")
                await asyncio.sleep(5)
        return results

    def publish_to_all(self, video_path: str, title: str, tags: List[str], cover_path: Optional[str] = None, platforms: List[str] = None, is_draft: bool = False, submit_wait: int = 3, publish_date: datetime | int = 0) -> Dict[str, Any]:
        """发布到所有平台"""
        if platforms is None:
            platforms = ['douyin', 'tencent', 'xiaohongshu']

        if not os.path.exists(video_path):
            return {'success': False, 'error': f'视频文件不存在: {video_path}'}

        try:
            results = _run_async(self._publish_all_async(video_path, title, tags, cover_path, platforms, is_draft=is_draft, submit_wait=submit_wait, publish_date=publish_date))
        except Exception as e:
            log_error(f"发布失败: {e}")
            return {'success': False, 'error': str(e)}

        success_count = sum(1 for r in results.values() if r.get('success'))
        action_text = '草稿处理完成' if is_draft else '成功发布'
        return {
            'success': success_count > 0,
            'message': f'{action_text} {success_count}/{len(platforms)} 个平台',
            'results': results,
        }


# 单例
_publish_service = None

def get_publish_service() -> PublishService:
    global _publish_service
    if _publish_service is None:
        _publish_service = PublishService()
    return _publish_service
