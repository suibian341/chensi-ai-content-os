import path from 'node:path';
import { fetchJson, ProviderError } from '../lib/http.js';
import { getProviderConfig } from './config.js';
import { findSource, pickPayload, sleep } from './media.js';
import { synthesizeVoice } from './voice.js';
import { synthesizeMultilingual } from './multilingual-tts.js';
import { prepareSpeechScript } from './speech-language.js';

function endpoint(config, pathname) {
  return `${config.baseUrl.replace(/\/+$/, '')}/${pathname.replace(/^\/+/, '')}`;
}

function validatePayload(payload) {
  if (String(payload?.code ?? 0) !== '0') throw new ProviderError('SKYHUMAN_PROVIDER_ERROR', '数字人任务处理失败', { details: payload });
  return payload;
}

async function skyJson(config, method, pathname, body = null, query = null) {
  const url = new URL(endpoint(config, pathname));
  for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, value);
  return validatePayload(await fetchJson(url, {
    method,
    headers: { Authorization: `Bearer ${config.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    timeoutMs: config.timeoutMs,
    ...(body ? { body: JSON.stringify(body) } : {})
  }));
}

async function upload(config, source) {
  const extension = path.extname(source.filename).toLowerCase().replace('.', '');
  if (!extension) throw new ProviderError('SKYHUMAN_FILE_TYPE_INVALID', '素材文件缺少扩展名');
  const ticket = await skyJson(config, 'POST', '/api/v2/fly/upload/create_upload_url', { file_extension: extension });
  const uploadUrl = pickPayload(ticket, 'upload_url');
  const contentType = pickPayload(ticket, 'content_type');
  const fileId = pickPayload(ticket, 'file_id');
  if (![uploadUrl, contentType, fileId].every((value) => typeof value === 'string' && value)) throw new ProviderError('SKYHUMAN_INVALID_RESPONSE', '数字人任务没有返回有效上传信息');
  let response;
  try {
    response = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': contentType }, body: source.data, signal: AbortSignal.timeout(config.uploadTimeoutMs) });
  } catch (error) {
    throw new ProviderError('SKYHUMAN_UPLOAD_FAILED', '数字人素材上传失败', { retryable: true, details: error.message });
  }
  if (![200, 201, 204].includes(response.status)) throw new ProviderError('SKYHUMAN_UPLOAD_FAILED', `数字人素材上传失败：HTTP ${response.status}`);
  return fileId;
}

async function poll(config, pathname, taskId, resultKey, { onProgress = async () => {}, queuedProgress = 44, runningProgress = 56, completedProgress = 70, label = '数字人' } = {}) {
  const deadline = Date.now() + config.timeoutMs;
  while (Date.now() < deadline) {
    const payload = await skyJson(config, 'GET', pathname, null, { task_id: taskId });
    const status = Number(pickPayload(payload, 'status'));
    if (status === 3) {
      const result = pickPayload(payload, resultKey);
      if (!result) throw new ProviderError('SKYHUMAN_INVALID_RESPONSE', '数字人任务没有返回生成结果');
      await onProgress(completedProgress, `${label}生成完成`);
      return { payload, result };
    }
    if (status === 4) throw new ProviderError('SKYHUMAN_TASK_FAILED', '数字人生成失败', { details: payload });
    if (![1, 2].includes(status)) throw new ProviderError('SKYHUMAN_INVALID_RESPONSE', '数字人任务返回了未知状态', { details: payload });
    const rawProgress = Number(pickPayload(payload, 'progress') ?? pickPayload(payload, 'percent'));
    const mappedProgress = Number.isFinite(rawProgress)
      ? queuedProgress + Math.round(Math.max(0, Math.min(100, rawProgress)) * (completedProgress - queuedProgress) / 100)
      : status === 2 ? runningProgress : queuedProgress;
    await onProgress(mappedProgress, status === 2 ? `${label}正在生成` : `${label}任务已排队`);
    await sleep(config.pollIntervalMs);
  }
  throw new ProviderError('SKYHUMAN_TASK_TIMEOUT', '数字人生成超时', { retryable: true });
}

export async function createAvatar(input, project, { onProgress = async () => {}, onSubmitted } = {}) {
  const config = getProviderConfig().digitalHuman;
  if (!config.enabled) throw new ProviderError('SKYHUMAN_NOT_CONFIGURED', '数字人功能尚未配置', { status: 503 });
  if (!input.consent) throw new ProviderError('CONSENT_REQUIRED', '创建数字人前必须确认形象授权');
  const configuredAvatar = String(input.avatarId || config.avatarId || '').trim();
  if (configuredAvatar) return { provider: 'skyhuman-direct', model: null, externalTaskId: null, output: { avatarId: configuredAvatar, avatarTaskId: null, videoSourceAssetId: null } };
  const videoSource = await findSource({ explicit: input.videoSample, assetId: input.videoAssetId, assets: project.assets, mimePrefix: 'video/', timeoutMs: config.uploadTimeoutMs });
  if (!videoSource) throw new ProviderError('DIGITAL_HUMAN_VIDEO_REQUIRED', '请先上传真实形象参考视频');
  await onProgress(16, '形象视频已读取');
  let videoFileId;
  try {
    videoFileId = await upload(config, videoSource);
  } finally {
    await videoSource.cleanup?.();
  }
  await onProgress(30, '形象视频已上传');
  const submitted = await skyJson(config, 'POST', '/api/v2/fly/avatar/create_by_video', { title: String(input.name || project.name).trim(), file_id: videoFileId });
  const avatarTaskId = pickPayload(submitted, 'task_id');
  if (!avatarTaskId) throw new ProviderError('SKYHUMAN_INVALID_RESPONSE', '数字人形象任务没有返回任务 ID');
  await Promise.resolve(onSubmitted?.(avatarTaskId)).catch(() => {});
  await onProgress(40, '形象任务已提交');
  const avatarId = (await poll(config, '/api/v2/fly/avatar/task', avatarTaskId, 'avatar', { onProgress, label: '形象' })).result;
  return { provider: 'skyhuman-direct', model: null, externalTaskId: avatarTaskId, output: { avatarId, avatarTaskId, videoSourceAssetId: videoSource.assetId || null } };
}

export async function renderAvatarVideo(input, project, { onSubmitted, onProgress = async () => {} } = {}) {
  const config = getProviderConfig().digitalHuman;
  if (!config.enabled) throw new ProviderError('SKYHUMAN_NOT_CONFIGURED', '数字人功能尚未配置', { status: 503 });
  if (!input.consent) throw new ProviderError('CONSENT_REQUIRED', '生成数字人前必须确认形象授权');
  const avatarId = String(input.avatarId || '').trim();
  if (!avatarId) throw new ProviderError('DIGITAL_HUMAN_AVATAR_REQUIRED', '请选择已创建的数字人形象');
  const savedAvatar = (project.avatars || []).find((item) => item.id === avatarId || item.avatarId === avatarId);
  if (!savedAvatar) throw new ProviderError('ACCOUNT_AVATAR_NOT_FOUND', '选择的数字人形象不存在或不属于当前账号', { status: 404 });
  const providerAvatarId = String(savedAvatar.avatarId || savedAvatar.id).trim();
  const language = String(input.language || savedAvatar?.language || 'zh-CN').trim();
  const languageLabel = String(input.languageLabel || savedAvatar?.languageLabel || language).trim();
  const hasDriverAudio = Boolean(input.audioSample || input.audioAssetId);
  let audio = null;
  let voiceId = null;
  let voiceName = null;
  let preparedScript = null;
  if (String(input.script || '').trim() && !(language === 'ug-CN' && hasDriverAudio)) {
    preparedScript = await prepareSpeechScript({ script: input.script, language, languageLabel });
    await onProgress(16, '口播文案已准备');
    let speech;
    // The regular digital-human material flow must only use voices created by
    // the Media Lab/Volcengine voice flow. HeyGen voices belong exclusively to
    // the independent talking-photo flow and must never be sent to this API.
    const speechProgress = async (value, stage = '') => {
      const numeric = Number(value);
      const normalized = Number.isFinite(numeric) ? Math.max(0, Math.min(100, numeric)) : 50;
      const mapped = 16 + Math.round(normalized * 0.1);
      await onProgress(Math.min(26, mapped), stage || '口播音频生成中');
    };
    if (language === 'ug-CN') {
      speech = await synthesizeMultilingual({ text: preparedScript.speechText, language, languageLabel }, project, { onProgress: speechProgress });
    } else {
      const voice = (project.voices || []).find((item) => item.id === input.voiceId || item.engineVoiceId === input.voiceId);
      if (!voice) throw new ProviderError('ACCOUNT_VOICE_NOT_FOUND', '选择的声音不存在或不属于当前账号', { status: 404 });
      if (voice.voiceService === 'talking_photo' || String(voice.provider || '').startsWith('heygen')) {
        throw new ProviderError('DIGITAL_HUMAN_VOICE_INCOMPATIBLE', '口播音色只能用于数字人口播，不能用于数字人素材', { status: 400 });
      }
      voiceId = String(voice.engineVoiceId || voice.id).trim();
      voiceName = String(voice.name || '').trim() || null;
      speech = await synthesizeVoice({ text: preparedScript.speechText, voiceId, language, languageLabel }, project, { onProgress: speechProgress });
    }
    audio = {
      filename: speech.filename,
      mimeType: speech.mimeType,
      data: speech.data,
      generatedByText: true,
      generatedVoiceId: voiceId,
      speechProvider: speech.provider || null,
      speechModel: speech.model || null
    };
    await onProgress(28, '口播音频已生成');
  } else if (hasDriverAudio) {
    audio = await findSource({ explicit: input.audioSample, assetId: input.audioAssetId, assets: project.assets, mimePrefix: 'audio/', timeoutMs: config.uploadTimeoutMs });
    await onProgress(28, '驱动音频已读取');
  }
  if (!audio) throw new ProviderError('DIGITAL_HUMAN_AUDIO_OR_SCRIPT_REQUIRED', '请选择驱动音频，或输入文案并选择已克隆声音');
  let audioFileId;
  try {
    audioFileId = await upload(config, audio);
  } finally {
    await audio.cleanup?.();
  }
  await onProgress(38, '驱动音频已上传');
  const submitted = await skyJson(config, 'POST', '/api/v2/fly/video/create_by_audio', { title: String(input.name || project.name).trim(), avatar: providerAvatarId, file_id: audioFileId });
  const videoTaskId = pickPayload(submitted, 'task_id');
  if (!videoTaskId) throw new ProviderError('SKYHUMAN_INVALID_RESPONSE', '数字人视频任务没有返回任务 ID');
  if (typeof onSubmitted === 'function') {
    await Promise.resolve(onSubmitted(videoTaskId)).catch((error) => {
      console.warn('persisting SkyHuman video task ID failed', error?.message || error);
    });
  }
  await onProgress(44, '数字人任务已提交');
  const completed = await poll(config, '/api/v2/fly/video/task', videoTaskId, 'video_url', { onProgress, queuedProgress: 46, runningProgress: 58, completedProgress: 72, label: '数字人成片' });
  const rawDuration = pickPayload(completed.payload, 'duration');
  return {
    provider: 'skyhuman-direct', model: audio.speechModel || null, externalTaskId: videoTaskId,
    output: {
      avatarId, providerAvatarId, voiceId, voiceName, voiceService: voiceId ? 'media_lab' : null, videoUrl: completed.result,
      pose: savedAvatar?.pose || '', style: savedAvatar?.style || '', language, languageLabel,
      sourceScript: preparedScript?.sourceText || null,
      speechScript: preparedScript?.speechText || null,
      scriptTransformed: preparedScript?.transformed === true,
      scriptTransformMode: preparedScript?.transformMode || null,
      translationProvider: preparedScript?.translationProvider || null,
      translationModel: preparedScript?.translationModel || null,
      speechProvider: audio.speechProvider || null,
      speechModel: audio.speechModel || null,
      durationSeconds: Number.isFinite(Number(rawDuration)) ? Number(rawDuration) : null,
      videoSourceAssetId: savedAvatar?.videoSourceAssetId || null,
      audioSourceAssetId: audio.assetId || null,
      generatedAudio: audio.generatedByText ? {
        data: audio.data,
        filename: audio.filename,
        mimeType: audio.mimeType,
        voiceId: audio.generatedVoiceId || null,
        provider: audio.speechProvider || null,
        model: audio.speechModel || null
      } : null
    }
  };
}

export async function createDigitalHuman(input, project) {
  return input.mode === 'create_avatar' ? createAvatar(input, project) : renderAvatarVideo(input, project);
}
