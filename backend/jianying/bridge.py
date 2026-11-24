import importlib.metadata
import json
import os
import re
import shutil
import sys
import time
import uuid


RESULT_PREFIX = "__CHENSI_JIANYING_RESULT__"


def emit(payload):
    print(f"{RESULT_PREFIX}{json.dumps(payload, ensure_ascii=False)}", flush=True)


def fail(code, message, status=503, details=None):
    emit({"success": False, "code": code, "error": message, "status": status, "details": details})
    raise SystemExit(1)


def safe_name(value):
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(value or "剪映草稿")).strip(" .")
    return (name or "剪映草稿")[:80]


def unique_name(root, requested):
    base = safe_name(requested)
    if not os.path.exists(os.path.join(root, base)):
        return base
    suffix = time.strftime("%Y%m%d-%H%M%S")
    candidate = safe_name(f"{base}-{suffix}")
    index = 2
    while os.path.exists(os.path.join(root, candidate)):
        candidate = safe_name(f"{base}-{suffix}-{index}")
        index += 1
    return candidate


def copy_material(source, target_directory, fallback_name):
    source = os.path.abspath(str(source or ""))
    if not os.path.isfile(source):
        fail("JIANYING_SOURCE_MISSING", f"剪映导入素材不存在：{source}", 404)
    extension = os.path.splitext(source)[1] or os.path.splitext(fallback_name)[1]
    target = os.path.join(target_directory, safe_name(os.path.basename(source) or fallback_name))
    if os.path.abspath(source).lower() != os.path.abspath(target).lower():
        shutil.copy2(source, target)
    return target


def normalized_path(value):
    return os.path.abspath(value).replace("\\", "/")


def write_json_atomic(path, payload):
    temporary = f"{path}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
    try:
        with open(temporary, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)


def update_metadata(draft_path, draft_root, draft_name, duration):
    now_seconds = int(time.time())
    now_microseconds = int(time.time() * 1_000_000)
    normalized_draft_path = normalized_path(draft_path)
    normalized_root = normalized_path(draft_root)
    draft_id = str(uuid.uuid4()).upper()
    content_path = os.path.join(draft_path, "draft_content.json")
    with open(content_path, "r", encoding="utf-8") as handle:
        content = json.load(handle)
    content["id"] = draft_id
    content["name"] = draft_name
    content["path"] = normalized_draft_path
    content["create_time"] = content.get("create_time") or now_seconds
    content["update_time"] = now_seconds
    write_json_atomic(content_path, content)

    meta_path = os.path.join(draft_path, "draft_meta_info.json")
    with open(meta_path, "r", encoding="utf-8") as handle:
        meta = json.load(handle)
    meta["draft_name"] = draft_name
    meta["draft_fold_path"] = normalized_draft_path
    meta["draft_root_path"] = normalized_root
    meta["draft_id"] = draft_id
    meta["tm_draft_create"] = now_microseconds
    meta["tm_draft_modified"] = now_microseconds
    meta["tm_duration"] = int(duration)
    meta.setdefault("draft_is_invisible", False)
    meta.setdefault("draft_is_cloud_temp_draft", False)
    meta.setdefault("draft_is_pippit_draft", False)
    meta.setdefault("draft_is_web_article_video", False)
    meta.setdefault("streaming_edit_draft_ready", True)
    write_json_atomic(meta_path, meta)
    return meta


def register_draft(index_path, draft_path, draft_root, draft_name, metadata, material_size):
    index_path = os.path.abspath(str(index_path or os.path.join(draft_root, "root_meta_info.json")))
    os.makedirs(os.path.dirname(index_path), exist_ok=True)
    if os.path.isfile(index_path):
        with open(index_path, "r", encoding="utf-8-sig") as handle:
            index = json.load(handle)
    else:
        index = {"all_draft_store": [], "draft_ids": 0, "root_path": normalized_path(draft_root)}

    stores = index.get("all_draft_store")
    if not isinstance(stores, list):
        fail("JIANYING_INDEX_INVALID", f"剪映草稿索引格式无效：{index_path}", 500)
    normalized_draft_path = normalized_path(draft_path)
    normalized_root = normalized_path(draft_root)
    draft_id = str(metadata["draft_id"])
    stores = [
        item for item in stores
        if str(item.get("draft_id") or "").upper() != draft_id.upper()
        and normalized_path(str(item.get("draft_fold_path") or draft_root)).lower() != normalized_draft_path.lower()
    ]
    record = {
        "cloud_draft_cover": False,
        "cloud_draft_sync": False,
        "draft_cloud_last_action_download": False,
        "draft_cloud_purchase_info": "",
        "draft_cloud_template_id": "",
        "draft_cloud_tutorial_info": "",
        "draft_cloud_videocut_purchase_info": "",
        "draft_cover": f"{normalized_draft_path}/draft_cover.jpg",
        "draft_fold_path": normalized_draft_path,
        "draft_id": draft_id,
        "draft_is_ai_shorts": False,
        "draft_is_cloud_temp_draft": False,
        "draft_is_invisible": False,
        "draft_is_pippit_draft": False,
        "draft_is_web_article_video": False,
        "draft_json_file": f"{normalized_draft_path}/draft_content.json",
        "draft_name": draft_name,
        "draft_new_version": "",
        "draft_root_path": normalized_root,
        "draft_timeline_materials_size": int(material_size),
        "draft_type": "",
        "draft_web_article_video_enter_from": "",
        "pippit_avatar_url": "",
        "pippit_extra_info": "",
        "pippit_id": "",
        "pippit_user_name": "",
        "streaming_edit_draft_ready": True,
        "tm_draft_cloud_completed": "",
        "tm_draft_cloud_entry_id": -1,
        "tm_draft_cloud_modified": 0,
        "tm_draft_cloud_parent_entry_id": -1,
        "tm_draft_cloud_space_id": -1,
        "tm_draft_cloud_user_id": -1,
        "tm_draft_create": int(metadata["tm_draft_create"]),
        "tm_draft_modified": int(metadata["tm_draft_modified"]),
        "tm_draft_removed": 0,
        "tm_duration": int(metadata["tm_duration"]),
    }
    index["all_draft_store"] = [record, *stores]
    index["draft_ids"] = len(index["all_draft_store"])
    index.setdefault("root_path", normalized_path(os.path.dirname(index_path)))

    backup_path = f"{index_path}.chensi.bak"
    if os.path.isfile(index_path):
        shutil.copy2(index_path, backup_path)
    write_json_atomic(index_path, index)

    with open(index_path, "r", encoding="utf-8-sig") as handle:
        verified = json.load(handle)
    registered = any(str(item.get("draft_id") or "").upper() == draft_id.upper() for item in verified.get("all_draft_store", []))
    if not registered:
        fail("JIANYING_INDEX_VERIFY_FAILED", "剪映草稿已生成，但写入草稿列表索引后校验失败", 500)
    return index_path


def import_draft(payload):
    try:
        import pyJianYingDraft as draft
    except Exception as error:
        fail(
            "JIANYING_DEPENDENCY_MISSING",
            "缺少 pyJianYingDraft 依赖，请先运行 npm run setup:jianying",
            503,
            str(error),
        )

    draft_root = os.path.abspath(str(payload.get("draftRoot") or ""))
    if not os.path.isdir(draft_root):
        fail("JIANYING_DRAFT_ROOT_MISSING", f"未找到剪映草稿目录：{draft_root}", 409)
    draft_name = unique_name(draft_root, payload.get("draftName"))
    draft_path = os.path.abspath(os.path.join(draft_root, draft_name))
    if os.path.dirname(draft_path).lower() != draft_root.lower():
        fail("JIANYING_DRAFT_PATH_INVALID", "剪映草稿路径越界", 400)

    created = False
    try:
        folder = draft.DraftFolder(draft_root)
        script = folder.create_draft(
            draft_name,
            max(320, int(payload.get("width") or 1080)),
            max(320, int(payload.get("height") or 1920)),
            max(1, min(120, int(payload.get("fps") or 30))),
        )
        created = True
        materials_dir = os.path.join(draft_path, "materials")
        os.makedirs(materials_dir, exist_ok=True)
        video_path = copy_material(payload.get("videoPath"), materials_dir, "source-video.mp4")
        video_material = draft.VideoMaterial(video_path)
        duration = int(video_material.duration)
        if duration <= 0:
            fail("JIANYING_VIDEO_DURATION_INVALID", "无法读取成片时长", 422)
        script.append_track(draft.TrackSpec(draft.TrackType.video, "主视频"))
        script.add_segment(
            draft.VideoSegment(
                video_material,
                draft.Timerange(0, duration),
                source_timerange=draft.Timerange(0, duration),
            ),
            "主视频",
        )

        subtitle_count = 0
        subtitle_source = payload.get("subtitlePath")
        if subtitle_source:
            subtitle_path = copy_material(subtitle_source, materials_dir, "subtitles.srt")
            script.import_srt(subtitle_path, "字幕")
            with open(subtitle_path, "r", encoding="utf-8-sig") as handle:
                subtitle_count = len(re.findall(r"(?m)^\d+\s*$", handle.read()))
        script.save()
        metadata = update_metadata(draft_path, draft_root, draft_name, duration)
        material_size = sum(
            os.path.getsize(os.path.join(current_root, filename))
            for current_root, _, filenames in os.walk(materials_dir)
            for filename in filenames
        )
        index_path = register_draft(
            payload.get("indexPath"),
            draft_path,
            draft_root,
            draft_name,
            metadata,
            material_size,
        )
        emit({
            "success": True,
            "draftName": draft_name,
            "draftPath": draft_path,
            "durationSeconds": round(duration / 1_000_000, 3),
            "subtitleCount": subtitle_count,
            "indexRegistered": True,
            "indexPath": index_path,
            "library": "pyJianYingDraft",
            "libraryVersion": importlib.metadata.version("pyJianYingDraft"),
        })
    except SystemExit:
        if created and os.path.dirname(draft_path).lower() == draft_root.lower():
            shutil.rmtree(draft_path, ignore_errors=True)
        raise
    except Exception as error:
        if created and os.path.dirname(draft_path).lower() == draft_root.lower():
            shutil.rmtree(draft_path, ignore_errors=True)
        fail("JIANYING_IMPORT_FAILED", f"剪映草稿生成失败：{error}", 500, type(error).__name__)


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except Exception as error:
        fail("JIANYING_INPUT_INVALID", "剪映草稿请求参数无法解析", 400, str(error))
    if payload.get("action") != "import":
        fail("JIANYING_ACTION_UNSUPPORTED", "不支持的剪映草稿操作", 400)
    import_draft(payload)


if __name__ == "__main__":
    main()
