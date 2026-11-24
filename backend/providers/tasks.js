import { ProviderError } from '../lib/http.js';
import { createAvatar, renderAvatarVideo } from './digital-human.js';
import { generateImage } from './image.js';
import { renderVideo } from './video.js';
import { cloneVoice, createVoicePreview } from './voice.js';
import { readAssetFile } from '../lib/storage.js';
import { publishVideoToPlatforms } from './platform-publish.js';
import { cloneTalkingPhotoVoice, renderTalkingPhoto } from './talking-photo.js';

async function imageReferenceDataUrls(input, project) {
  const ids = [...new Set(Array.isArray(input.referenceAssetIds) ? input.referenceAssetIds.map(String).filter(Boolean) : [])];
  if (ids.length > 4) throw new ProviderError('IMAGE_REFERENCE_LIMIT', '参考图最多选择 4 张', { status: 400 });
  return Promise.all(ids.map(async (assetId) => {
    const asset = (project.assets || []).find((item) => item.id === assetId);
    if (!asset || !String(asset.mimeType || '').startsWith('image/')) {
      throw new ProviderError('IMAGE_REFERENCE_INVALID', '所选参考图不存在或不是图片素材', { status: 400, details: { assetId } });
    }
    const loaded = await readAssetFile(asset);
    try {
      return `data:${asset.mimeType};base64,${loaded.data.toString('base64')}`;
    } finally {
      await loaded.cleanup();
    }
  }));
}

function createPublishPackage(input, project) {
  const requestedOutputId = String(input.sourceOutputId || '').trim();
  const readyOutputs = (project.outputs || []).filter((item) => item.status === 'ready' && (item.url || item.accessUrl));
  const source = requestedOutputId ? readyOutputs.find((item) => item.id === requestedOutputId) : readyOutputs[0];
  if (!source) throw new ProviderError('PUBLISH_VIDEO_REQUIRED', '发布包必须基于已经真实生成的视频成片');
  const platforms = Array.isArray(input.platforms) ? input.platforms.filter(Boolean) : [];
  if (!platforms.length) throw new ProviderError('PUBLISH_PLATFORM_REQUIRED', '请至少选择一个发布平台');
  const title = String(input.title || project.copy?.publishTitle || '').trim();
  const tags = Array.isArray(project.copy?.tags) ? project.copy.tags : [];
  const platformSpecs = {
    '抖音': { aspectRatio: '9:16', titleMaxLength: 55, tagLimit: 5, subtitleSafeZone: '顶部 10% / 底部 22% 留空' },
    '小红书': { aspectRatio: '3:4 / 1:1', titleMaxLength: 20, tagLimit: 10, subtitleSafeZone: '底部 18% 留空' },
    '视频号': { aspectRatio: '9:16', titleMaxLength: 30, tagLimit: 8, subtitleSafeZone: '顶部 8% / 底部 20% 留空' },
    '快手': { aspectRatio: '9:16', titleMaxLength: 50, tagLimit: 5, subtitleSafeZone: '顶部 10% / 底部 22% 留空' },
    'B站': { aspectRatio: '16:9 / 9:16', titleMaxLength: 80, tagLimit: 10, subtitleSafeZone: '按投稿分区人工复核' },
    '百家号': { aspectRatio: '16:9 / 9:16', titleMaxLength: 30, tagLimit: 5, subtitleSafeZone: '按平台预览人工复核' }
  };
  return {
    provider: 'project-publish-adapter',
    model: null,
    externalTaskId: null,
    output: {
      sourceOutputId: source.id,
      sourceUrl: source.url || source.accessUrl,
      sourceTitle: source.title || '',
      sourceRatio: source.ratio || '',
      platforms,
      packageType: 'metadata_manifest',
      automaticPublishing: false,
      generatedMediaFiles: false,
      notice: '这是基于真实成片生成的发布参数清单，不会自动发布，也不会生成新的画幅文件。',
      formats: platforms.map((platform) => ({
        platform,
        ...(platformSpecs[platform] || { aspectRatio: source.ratio || '原始画幅', titleMaxLength: null, tagLimit: null, subtitleSafeZone: '按平台规则人工复核' }),
        title,
        tags
      }))
    }
  };
}

export async function executeTaskProvider(task, project, input, options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : async () => {};
  if (task.kind === 'image') {
    if (!String(input.prompt || '').trim()) throw new ProviderError('IMAGE_PROMPT_REQUIRED', '请填写图片生成提示词');
    const storedReferences = await imageReferenceDataUrls(input, project);
    const externalReferences = Array.isArray(input.images) ? input.images : [];
    await onProgress(14, storedReferences.length || externalReferences.length ? '参考图片已读取' : '生成参数已校验');
    return generateImage({ ...input, images: [...storedReferences, ...externalReferences].slice(0, 4) }, { onProgress });
  }
  if (task.kind === 'avatar_create') return createAvatar(input, project, { onProgress, onSubmitted: options.onExternalTaskId });
  if (task.kind === 'voice_clone') return cloneVoice(input, project, { onProgress });
  if (task.kind === 'voice_preview') return createVoicePreview(input, project, { onProgress });
  if (task.kind === 'talking_photo_voice_clone') return cloneTalkingPhotoVoice({ ...input, idempotencyKey: input.idempotencyKey || task.id }, project, { onSubmitted: options.onExternalTaskId, onProgress });
  if (task.kind === 'digital_human') return renderAvatarVideo(input, project, { onSubmitted: options.onExternalTaskId, onProgress });
  if (task.kind === 'talking_photo') return renderTalkingPhoto({ ...input, idempotencyKey: input.idempotencyKey || task.id }, project, { onSubmitted: options.onExternalTaskId, onProgress });
  if (task.kind === 'video') return renderVideo(task, input, project, { onProgress, onExternalTaskId: options.onExternalTaskId, signal: options.signal });
  if (task.kind === 'publish') {
    const result = createPublishPackage(input, project);
    await onProgress(88, '发布参数已生成');
    return result;
  }
  if (task.kind === 'platform_publish') return publishVideoToPlatforms(input, project, { userId: task.userId, onProgress });
  throw new ProviderError('TASK_KIND_UNSUPPORTED', '不支持的任务类型');
}
