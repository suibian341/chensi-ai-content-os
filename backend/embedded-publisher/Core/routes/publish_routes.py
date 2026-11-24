# -*- coding: utf-8 -*-
"""
发布服务 Mixin - 多平台视频发布
"""
import os
import sys
import json
import time
import threading
from datetime import datetime, timedelta
from pathlib import Path

try:
    from .utils import PROJECT_ROOT, BUNDLED_FFMPEG, BUNDLED_FFPROBE
except ImportError:
    PROJECT_ROOT = Path(__file__).parent.parent.parent.resolve()
    import shutil
    _bundled = PROJECT_ROOT / "lib" / "ffmpeg" / "bin" / "ffmpeg.exe"
    BUNDLED_FFMPEG = str(_bundled) if _bundled.exists() else (shutil.which('ffmpeg') or 'ffmpeg')
    _bundled_p = PROJECT_ROOT / "lib" / "ffmpeg" / "bin" / "ffprobe.exe"
    BUNDLED_FFPROBE = str(_bundled_p) if _bundled_p.exists() else (shutil.which('ffprobe') or 'ffprobe')


class PublishMixin:
    """发布服务 Mixin - 多平台视频发布"""

    def _parse_bool(self, value):
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            return value.strip().lower() in {'1', 'true', 'yes', 'on'}
        return bool(value)

    def _parse_publish_datetime(self, value):
        if not value:
            return 0
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(value)
        text = str(value).strip()
        if not text:
            return 0
        if text.endswith('Z'):
            text = text[:-1] + '+00:00'
        try:
            return datetime.fromisoformat(text)
        except ValueError:
            pass
        for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M'):
            try:
                return datetime.strptime(text, fmt)
            except ValueError:
                continue
        raise ValueError('定时发布时间格式不正确')

    def _validate_publish_datetime(self, value):
        publish_date = self._parse_publish_datetime(value)
        if not publish_date:
            raise ValueError('请选择定时发布时间')
        now = datetime.now(tz=publish_date.tzinfo) if publish_date.tzinfo else datetime.now()
        if publish_date <= now + timedelta(hours=2):
            raise ValueError('定时发布时间必须晚于当前时间 2 小时以上')
        return publish_date

    def handle_publish_status(self):
        """获取发布服务状态"""
        try:
            from Core.publish_service import get_publish_service
            service = get_publish_service()
            status = service.get_status()
            
            # 检查各平台登录状态
            platforms_status = {}
            for platform in status.get('platforms', []):
                login_status = service.check_login_status(platform)
                platforms_status[platform] = login_status
            
            status['platforms_status'] = platforms_status
            
            self.send_json_response({
                'success': True,
                **status
            })
        except Exception as e:
            print(f"❌ 获取发布状态失败 {e}")
            self.send_json_response({'success': False, 'error': str(e)})

    def handle_publish_start_chrome(self):
        """启动Chrome调试模式"""
        try:
            from Core.publish_service import get_publish_service
            service = get_publish_service()
            result = service.start_chrome_debug()
            self.send_json_response(result)
        except Exception as e:
            print(f"❌ 启动Chrome失败: {e}")
            self.send_json_response({'success': False, 'error': str(e)})

    def handle_publish_get_cookie(self):
        """获取平台Cookie"""
        try:
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            data = json.loads(post_data.decode('utf-8'))
            
            platform = data.get('platform', '')
            if not platform:
                self.send_json_response({'success': False, 'error': '请指定平台'})
                return
            
            from Core.publish_service import get_publish_service
            service = get_publish_service()
            result = service.get_platform_cookie(platform)
            self.send_json_response(result)
        except Exception as e:
            print(f"❌ 获取Cookie失败: {e}")
            self.send_json_response({'success': False, 'error': str(e)})

    def handle_publish_check_login(self):
        """检查平台登录状态"""
        try:
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            data = json.loads(post_data.decode('utf-8'))
            
            platform = data.get('platform', '')
            if not platform:
                self.send_json_response({'success': False, 'error': '请指定平台'})
                return
            
            from Core.publish_service import get_publish_service
            service = get_publish_service()
            result = service.check_login_status(platform)
            self.send_json_response({
                'success': True,
                'platform': platform,
                **result
            })
        except Exception as e:
            print(f"❌ 检查登录状态失败 {e}")
            self.send_json_response({'success': False, 'error': str(e)})

    def handle_publish_clear_login(self):
        """清除指定平台的登录信息"""
        try:
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            data = json.loads(post_data.decode('utf-8'))
            
            platform = data.get('platform', '')
            if not platform:
                self.send_json_response({'success': False, 'error': '请指定平台'})
                return
            
            from Core.publish_service import get_publish_service
            service = get_publish_service()
            result = service.clear_login(platform)
            self.send_json_response(result)
        except Exception as e:
            print(f"❌ 清除登录信息失败 {e}")
            self.send_json_response({'success': False, 'error': str(e)})

    def handle_publish_upload(self):
        """发布视频到指定平台"""
        try:
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            data = json.loads(post_data.decode('utf-8'))
            
            platform = data.get('platform', '')
            video_path = data.get('video_path', '')
            title = data.get('title', '')
            tags = data.get('tags', [])
            cover_path = data.get('cover_path', '')
            is_scheduled = self._parse_bool(data.get('is_scheduled', False))
            publish_date = self._validate_publish_datetime(data.get('publish_date')) if is_scheduled else 0
            
            if not platform:
                self.send_json_response({'success': False, 'error': '请指定平台'})
                return
            
            if not video_path:
                self.send_json_response({'success': False, 'error': '请指定视频路径'})
                return
            
            # 构建完整路径
            project_root = PROJECT_ROOT
            if not os.path.isabs(video_path):
                # 尝试多个可能的路径
                possible_paths = [
                    project_root / video_path,
                    project_root / self.RESULT_DIR / video_path,
                    project_root / self.RESULT_DIR / 'bgm' / video_path,
                    project_root / self.RESULT_DIR / 'material' / video_path,
                    project_root / self.RESULT_DIR / 'subtitle' / video_path,
                    project_root / self.RESULT_DIR / 'digital_human' / video_path,
                ]
                for p in possible_paths:
                    if p.exists():
                        video_path = str(p)
                        break
            
            print(f"📤 发布视频到{platform}")
            print(f"   视频: {video_path}")
            print(f"   标题: {title}")
            print(f"   标签: {tags}")
            print(f"   封面: {cover_path}")
            print(f"   定时发布: {is_scheduled}, 时间: {publish_date}")
            
            # 解析封面路径
            if cover_path and not os.path.isabs(cover_path):
                cover_path_clean = cover_path.lstrip('/').lstrip('\\')
                possible_cover_paths = [
                    project_root / cover_path_clean,
                    project_root / self.RESULT_DIR / 'cover' / os.path.basename(cover_path),
                    project_root / self.RESULT_DIR / cover_path_clean,
                ]
                for p in possible_cover_paths:
                    if p.exists():
                        cover_path = str(p)
                        break
            if cover_path and os.path.exists(cover_path):
                print(f"   封面文件确认存在: {cover_path}")
            elif cover_path:
                print(f"   ⚠️ 封面文件不存在: {cover_path}，将不设置封面")
                cover_path = ''
            
            # 如果没有封面，自动从视频中提取一帧作为封面
            if not cover_path and os.path.exists(video_path):
                try:
                    cover_dir = self.get_result_subdir('cover')
                    cover_dir.mkdir(parents=True, exist_ok=True)
                    import time as _time
                    auto_cover_path = str(cover_dir / f'auto_cover_{int(_time.time())}.jpg')
                    import subprocess
                    cmd = [BUNDLED_FFMPEG, '-i', video_path, '-ss', '1', '-vframes', '1', '-q:v', '2', '-y', auto_cover_path]
                    subprocess.run(cmd, capture_output=True, timeout=30)
                    if os.path.exists(auto_cover_path):
                        cover_path = auto_cover_path
                        print(f"   🖼️ 已自动从视频提取封面: {cover_path}")
                    else:
                        print(f"   ⚠️ 自动提取封面失败")
                except Exception as e:
                    print(f"   ⚠️ 自动提取封面异常: {e}")
            
            from Core.publish_service import get_publish_service
            service = get_publish_service()
            result = service.publish_video(platform, video_path, title, tags, cover_path, publish_date=publish_date)
            self.send_json_response(result)
        except Exception as e:
            print(f"❌ 发布失败: {e}")
            import traceback
            traceback.print_exc()
            self.send_json_response({'success': False, 'error': str(e)})

    def handle_publish_upload_all(self):
        """发布视频到所有平台"""
        try:
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            data = json.loads(post_data.decode('utf-8'))
            
            video_path = data.get('video_path', '')
            title = data.get('title', '')
            tags = data.get('tags', [])
            cover_path = data.get('cover_path', '')
            platforms = data.get('platforms', ['douyin', 'tencent', 'xiaohongshu'])
            is_draft = data.get('is_draft', False)
            submit_wait = data.get('submit_wait', 3)
            is_scheduled = self._parse_bool(data.get('is_scheduled', False))
            publish_date = self._validate_publish_datetime(data.get('publish_date')) if is_scheduled else 0
            if is_scheduled and is_draft:
                self.send_json_response({'success': False, 'error': '定时发布不能和保存草稿同时使用'})
                return
            
            if not video_path:
                self.send_json_response({'success': False, 'error': '请指定视频路径'})
                return
            
            # 构建完整路径
            project_root = PROJECT_ROOT
            video_path = str(video_path).strip()
            if video_path.startswith(('http://', 'https://')):
                try:
                    from urllib.parse import urlparse, unquote
                    video_path = unquote(urlparse(video_path).path or video_path)
                except Exception:
                    pass

            video_path_for_match = video_path.replace('\\', '/')
            video_path_rel = video_path_for_match.lstrip('/\\')
            if (not os.path.isabs(video_path)) or video_path_for_match.startswith('/result/'):
                possible_paths = [
                    project_root / video_path_rel,
                    project_root / video_path,
                    project_root / self.RESULT_DIR / video_path_rel,
                    project_root / self.RESULT_DIR / os.path.basename(video_path_rel),
                    project_root / self.RESULT_DIR / 'bgm' / os.path.basename(video_path_rel),
                    project_root / self.RESULT_DIR / 'material' / os.path.basename(video_path_rel),
                    project_root / self.RESULT_DIR / 'subtitle' / os.path.basename(video_path_rel),
                    project_root / self.RESULT_DIR / 'digital_human' / os.path.basename(video_path_rel),
                ]
                for p in possible_paths:
                    if p.exists():
                        video_path = str(p)
                        break
            
            print(f"📤 一键发布视频到所有平台")
            print(f"   视频: {video_path}")
            print(f"   标题: {title}")
            print(f"   标签: {tags}")
            print(f"   平台: {platforms}")
            print(f"   封面: {cover_path}")
            print(f"   草稿模式: {is_draft}")
            print(f"   定时发布: {is_scheduled}, 时间: {publish_date}")
            
            # 解析封面路径
            if cover_path and not os.path.isabs(cover_path):
                # 去掉开头的 / 或 \ (前端可能传 /result/cover/xxx.jpg)
                cover_path_clean = cover_path.lstrip('/').lstrip('\\')
                possible_cover_paths = [
                    project_root / cover_path_clean,
                    project_root / self.RESULT_DIR / 'cover' / os.path.basename(cover_path),
                    project_root / self.RESULT_DIR / cover_path_clean,
                ]
                for p in possible_cover_paths:
                    if p.exists():
                        cover_path = str(p)
                        break
            if cover_path and os.path.exists(cover_path):
                print(f"   封面文件确认存在: {cover_path}")
            elif cover_path:
                print(f"   ⚠️ 封面文件不存在: {cover_path}，将不设置封面")
                cover_path = ''
            
            # 如果没有封面，自动从视频中提取一帧作为封面
            if not cover_path and os.path.exists(video_path):
                try:
                    cover_dir = self.get_result_subdir('cover')
                    cover_dir.mkdir(parents=True, exist_ok=True)
                    import time as _time
                    auto_cover_path = str(cover_dir / f'auto_cover_{int(_time.time())}.jpg')
                    import subprocess
                    cmd = [BUNDLED_FFMPEG, '-i', video_path, '-ss', '1', '-vframes', '1', '-q:v', '2', '-y', auto_cover_path]
                    subprocess.run(cmd, capture_output=True, timeout=30)
                    if os.path.exists(auto_cover_path):
                        cover_path = auto_cover_path
                        print(f"   🖼️ 已自动从视频提取封面: {cover_path}")
                    else:
                        print(f"   ⚠️ 自动提取封面失败")
                except Exception as e:
                    print(f"   ⚠️ 自动提取封面异常: {e}")
            
            from Core.publish_service import get_publish_service
            service = get_publish_service()
            result = service.publish_to_all(video_path, title, tags, cover_path, platforms, is_draft=is_draft, submit_wait=submit_wait, publish_date=publish_date)
            self.send_json_response(result)
        except Exception as e:
            print(f"❌ 一键发布失败 {e}")
            import traceback
            traceback.print_exc()
            self.send_json_response({'success': False, 'error': str(e)})
