import { randomUUID } from 'node:crypto';
import { Signer } from '@volcengine/openapi';
import { ProviderError } from '../lib/http.js';
import { deleteStoredFile, saveAssetFile, signedReadUrl } from '../lib/storage.js';
import { getProviderConfig } from './config.js';
import { sleep } from './media.js';
import { synthesizeVoice } from './voice.js';

const ACTION_SUBMIT = 'CVSubmitTask';
const ACTION_RESULT = 'CVGetResult';
const API_VERSION = '2022-08-31';
const LARGE_RATIOS = new Set(['9:16', '16:9', '3:4', '4:3']);
const FAILED_STATUSES = new Set(['not_found', 'expired', 'failed', 'error', 'cancelled', 'canceled']);

function responseMessage(payload, fallback) {
  return String(payload?.message || payload?.msg || payload?.ResponseMetadata?.Error?.Message || fallback);
}

function parseResponseData(payload) {
  const raw = payload?.data?.resp_data;
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}

function providerErrorCode(payload, fallback = 'TALKING_PHOTO_PROVIDER_ERROR') {
  const code = Number(payload?.code ?? payload?.status);
  if (code === 50411 || code === 50412) return 'TALKING_PHOTO_CONTENT_REJECTED';
  if (code === 50429 || code === 429) return 'TALKING_PHOTO_RATE_LIMITED';
  return fallback;
}

async function volcengineJson(config, action, body, errorCode = 'TALKING_PHOTO_PROVIDER_ERROR') {
  const endpoint = new URL(config.baseUrl);
  endpoint.searchParams.set('Action', action);
  endpoint.searchParams.set('Version', API_VERSION);
  const serialized = JSON.stringify(body);
  const request = {
    region: config.region,
    method: 'POST',
    pathname: endpoint.pathname || '/',
    params: { Action: action, Version: API_VERSION },
    headers: { Host: endpoint.host, 'Content-Type': 'application/json' },
    body: serialized
  };
  const signer = new Signer(request, config.service);
  signer.addAuthorization({
    accessKeyId: config.accessKeyId,
    secretKey: config.secretKey,
    ...(config.sessionToken ? { sessionToken: config.sessionToken } : {})
  });

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: request.headers,
      body: serialized,
      signal: AbortSignal.timeout(config.requestTimeoutMs)
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError'
      || /timeout|timed out/i.test(String(error?.message || ''));
    throw new ProviderError(
      timedOut ? 'TALKING_PHOTO_SERVICE_TIMEOUT' : 'TALKING_PHOTO_SERVICE_UNREACHABLE',
      timedOut ? '数字人口播服务连接超时，请稍后重试' : '暂时无法连接数字人口播服务，请稍后重试',
      { retryable: true, details: error?.message || String(error) }
    );
  }
  const payload = await response.json().catch(() => null);
  const businessCode = Number(payload?.code ?? payload?.status);
  if (!response.ok || businessCode !== 10000) {
    throw new ProviderError(
      providerErrorCode(payload, errorCode),
      responseMessage(payload, `数字人口播服务请求失败：HTTP ${response.status}`),
      {
        status: response.status >= 400 && response.status < 500 ? response.status : 502,
        retryable: response.status === 408 || response.status === 429 || response.status >= 500,
        details: payload
      }
    );
  }
  return payload;
}

async function providerJsonWithRetry(config, action, body, errorCode, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await volcengineJson(config, action, body, errorCode);
    } catch (error) {
      lastError = error;
      if (!(error instanceof ProviderError) || !error.retryable || attempt >= attempts - 1) throw error;
      await sleep(Math.min(2_000, 300 * (attempt + 1)));
    }
  }
  throw lastError;
}

function normalizeAspectRatio(value) {
  const ratio = String(value || '').trim();
  return ['auto', '9:16', '16:9', '1:1', '3:4', '4:3', '4:5', '5:4'].includes(ratio) ? ratio : '9:16';
}

function estimatedSpeechSeconds(text) {
  const source = String(text || '').trim();
  const han = (source.match(/[\u3400-\u9fff]/g) || []).length;
  const words = (source.replace(/[\u3400-\u9fff]/g, ' ').match(/[\p{L}\p{N}]+/gu) || []).length;
  const punctuationPauses = (source.match(/[，。！？；：,.!?;:]/g) || []).length * 0.14;
  return Math.max(1, han / 4.2 + words / 2.7 + punctuationPauses);
}

function driveMode(config, ratio, script) {
  const requested = String(config.driveMode || 'auto').trim().toLowerCase();
  const estimatedSeconds = estimatedSpeechSeconds(script);
  let selected = requested;
  if (selected === 'auto') {
    selected = LARGE_RATIOS.has(ratio) && estimatedSeconds <= config.largeMaxSeconds ? 'large' : 'standard';
  }
  if (selected === 'large' && (!LARGE_RATIOS.has(ratio) || estimatedSeconds > config.largeMaxSeconds)) {
    throw new ProviderError(
      'TALKING_PHOTO_LARGE_MODE_LIMIT',
      `自然动作模式仅支持 9:16、16:9、3:4、4:3，且单段口播不能超过约 ${config.largeMaxSeconds} 秒`,
      { status: 400, details: { aspectRatio: ratio, estimatedSeconds } }
    );
  }
  if (selected === 'expressive') {
    return { mode: selected, createReqKey: 'realman_avatar_picture_create_role_loopy', videoReqKey: 'realman_avatar_picture_loopy', estimatedSeconds };
  }
  if (selected === 'large') {
    return { mode: selected, createReqKey: 'realman_avatar_picture_create_role_loopyb', videoReqKey: 'realman_avatar_picture_loopyb', estimatedSeconds };
  }
  return { mode: 'standard', createReqKey: 'realman_avatar_picture_create_role', videoReqKey: 'realman_avatar_picture_v2', estimatedSeconds };
}

function progressValue(payload) {
  const responseData = parseResponseData(payload);
  const value = Number(responseData.progress ?? payload?.data?.progress);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
}

async function submitTask(config, reqKey, fields, errorCode) {
  const payload = await providerJsonWithRetry(config, ACTION_SUBMIT, { req_key: reqKey, ...fields }, errorCode, 2);
  const taskId = String(payload?.data?.task_id || '').trim();
  if (!taskId) throw new ProviderError('TALKING_PHOTO_INVALID_RESPONSE', '数字人口播服务没有返回任务编号', { details: payload });
  return taskId;
}

async function pollTask(config, reqKey, taskId, { kind, progressStart, progressEnd, onProgress }) {
  const deadline = Date.now() + config.timeoutMs;
  while (Date.now() < deadline) {
    const payload = await providerJsonWithRetry(
      config,
      ACTION_RESULT,
      { req_key: reqKey, task_id: taskId },
      kind === 'role' ? 'TALKING_PHOTO_ROLE_STATUS_FAILED' : 'TALKING_PHOTO_VIDEO_STATUS_FAILED',
      3
    );
    const status = String(payload?.data?.status || '').trim().toLowerCase();
    const responseData = parseResponseData(payload);
    if (FAILED_STATUSES.has(status)) {
      throw new ProviderError(
        kind === 'role' ? 'TALKING_PHOTO_ROLE_FAILED' : 'TALKING_PHOTO_TASK_FAILED',
        responseMessage(responseData, kind === 'role' ? '人物形象创建失败' : '数字人口播生成失败'),
        { details: payload }
      );
    }
    if (status === 'done') {
      const innerCode = Number(responseData?.code ?? 0);
      if (innerCode !== 0) {
        throw new ProviderError(
          kind === 'role' ? 'TALKING_PHOTO_ROLE_FAILED' : 'TALKING_PHOTO_TASK_FAILED',
          responseMessage(responseData, kind === 'role' ? '人物形象创建失败' : '数字人口播生成失败'),
          { details: payload }
        );
      }
      await onProgress(progressEnd, kind === 'role' ? '人物形象已准备' : '数字人口播视频已生成');
      return { payload, responseData };
    }
    const rawProgress = progressValue(payload);
    const mapped = rawProgress === null ? progressStart : progressStart + Math.round((progressEnd - progressStart) * rawProgress / 100);
    await onProgress(mapped, kind === 'role'
      ? (status === 'generating' ? '正在准备人物形象' : '人物形象任务正在排队')
      : (status === 'generating' ? '数字人口播正在生成' : '数字人口播任务正在排队'));
    await sleep(config.pollIntervalMs);
  }
  throw new ProviderError(
    kind === 'role' ? 'TALKING_PHOTO_ROLE_TIMEOUT' : 'TALKING_PHOTO_TASK_TIMEOUT',
    kind === 'role' ? '人物形象创建超时，请稍后重试' : '数字人口播生成超时，请稍后重试',
    { retryable: true }
  );
}

function cachedResource(project, imageAssetId, createReqKey) {
  return (project.outputs || []).find((item) => (
    item.template === 'talking-photo'
    && item.sourceAssetId === imageAssetId
    && item.resourceReqKey === createReqKey
    && String(item.resourceId || '').trim()
  ))?.resourceId || null;
}

function absoluteAssetUrl(asset) {
  return [asset?.sourceUrl, asset?.providerUrl, asset?.url]
    .map((item) => String(item || '').trim())
    .find((item) => /^https?:\/\//i.test(item)) || null;
}

function defaultResolveImageUrl(asset) {
  return signedReadUrl(asset) || absoluteAssetUrl(asset);
}

async function defaultPublishNarration({ project, audio, taskKey }) {
  const assetId = `talking-photo-input-${randomUUID()}`;
  const name = `talking-photo-narration-${taskKey || assetId}.mp3`;
  const stored = await saveAssetFile({
    userId: project.ownerId,
    projectId: project.id,
    assetId,
    name,
    mimeType: audio.mimeType || 'audio/mpeg',
    data: audio.data
  });
  const record = { ...stored, name, mimeType: audio.mimeType || 'audio/mpeg' };
  const url = signedReadUrl(record);
  if (!url) {
    await deleteStoredFile(record).catch(() => {});
    throw new ProviderError('TALKING_PHOTO_PUBLIC_STORAGE_REQUIRED', '数字人口播需要对象存储签名地址，请先配置 OSS 后再生成', { status: 503 });
  }
  return { url, cleanup: () => deleteStoredFile(record).catch(() => {}) };
}

export function talkingPhotoDownloadHeaders() {
  return {};
}

export function fetchTalkingPhotoMedia(url, options = {}, config = getProviderConfig().talkingPhoto) {
  const { timeoutMs, ...requestOptions } = options;
  return fetch(url, {
    ...requestOptions,
    signal: requestOptions.signal || AbortSignal.timeout(Number(timeoutMs || config.downloadTimeoutMs) || 5 * 60_000)
  });
}

export async function checkTalkingPhotoConnection() {
  const config = getProviderConfig().talkingPhoto;
  if (!config.enabled) throw new ProviderError('TALKING_PHOTO_NOT_CONFIGURED', '数字人口播功能尚未配置，请联系管理员', { status: 503 });
  const payload = await providerJsonWithRetry(
    config,
    ACTION_RESULT,
    { req_key: config.standardVideoReqKey, task_id: `connection-check-${randomUUID()}` },
    'TALKING_PHOTO_CONNECTION_CHECK_FAILED',
    1
  );
  const status = String(payload?.data?.status || '').trim().toLowerCase();
  if (status && !['not_found', 'expired', 'in_queue', 'generating', 'done'].includes(status)) {
    throw new ProviderError('TALKING_PHOTO_CONNECTION_CHECK_FAILED', responseMessage(payload, '数字人口播连接检查失败'), { details: payload });
  }
  return {
    ready: true,
    mode: 'domestic',
    supportsVoiceCloning: false,
    requiresVoiceSelection: true,
    reusesMediaVoices: true,
    driveMode: config.driveMode,
    pricePerSecondCny: config.pricePerSecondCny,
    rolePriceCny: config.rolePriceCny
  };
}

export async function listTalkingPhotoVoices() {
  return [];
}

export async function cloneTalkingPhotoVoice() {
  throw new ProviderError('TALKING_PHOTO_VOICE_CLONE_UNSUPPORTED', '数字人口播已直接复用媒体实验室声音，无需重复复刻', { status: 409 });
}

export async function deleteTalkingPhotoVoice() {
  return false;
}

export async function renderTalkingPhoto(input, project, {
  onSubmitted,
  onProgress = async () => {},
  resolveImageUrl = defaultResolveImageUrl,
  publishNarration = defaultPublishNarration
} = {}) {
  const config = getProviderConfig().talkingPhoto;
  if (!config.enabled) throw new ProviderError('TALKING_PHOTO_NOT_CONFIGURED', '数字人口播功能尚未配置，请联系管理员', { status: 503 });
  if (!input.consent) throw new ProviderError('CONSENT_REQUIRED', '生成数字人口播前必须确认肖像和素材授权', { status: 400 });
  const script = String(input.script || '').trim();
  if (!script) throw new ProviderError('TALKING_PHOTO_SCRIPT_REQUIRED', '请输入数字人口播文案', { status: 400 });
  if (script.length > 5_000) throw new ProviderError('TALKING_PHOTO_SCRIPT_TOO_LONG', '数字人口播文案不能超过 5000 个字符', { status: 400 });

  const selectedVoiceId = String(input.voiceId || '').trim();
  const voice = (project.voices || []).find((item) => item.id === selectedVoiceId || item.engineVoiceId === selectedVoiceId);
  if (!voice || voice.digitalHumanCompatible === false || voice.voiceService === 'talking_photo' || String(voice.provider || '').toLowerCase().startsWith('heygen')) {
    throw new ProviderError('ACCOUNT_VOICE_NOT_FOUND', '请选择媒体实验室中已复刻的声音', { status: 404 });
  }
  const engineVoiceId = String(voice.engineVoiceId || voice.id).trim();

  const imageAssetId = String(input.imageAssetId || '').trim();
  const imageAsset = (project.assets || []).find((item) => item.id === imageAssetId && item.storageKey && String(item.mimeType || '').startsWith('image/'));
  if (!imageAsset) throw new ProviderError('TALKING_PHOTO_IMAGE_REQUIRED', '请选择当前项目中的人物图片', { status: 400 });
  if (!['image/jpeg', 'image/png'].includes(String(imageAsset.mimeType || '').toLowerCase())) {
    throw new ProviderError('TALKING_PHOTO_IMAGE_FORMAT_INVALID', '数字人口播人物图片仅支持 JPG 或 PNG 格式', { status: 400 });
  }
  const knownSize = Number(imageAsset.sizeBytes);
  if (Number.isFinite(knownSize) && knownSize > config.maxImageBytes) {
    throw new ProviderError('TALKING_PHOTO_IMAGE_SIZE_INVALID', `人物图片不能超过 ${Math.round(config.maxImageBytes / 1024 / 1024)} MB`, { status: 400 });
  }
  const imageUrl = await resolveImageUrl(imageAsset, { project, input });
  if (!/^https?:\/\//i.test(String(imageUrl || ''))) {
    throw new ProviderError('TALKING_PHOTO_PUBLIC_STORAGE_REQUIRED', '人物图片需要可限时访问的 OSS 地址，请先配置对象存储', { status: 503 });
  }
  await onProgress(10, '人物图片已准备');

  const aspectRatio = normalizeAspectRatio(input.aspectRatio || config.aspectRatio);
  const mode = driveMode(config, aspectRatio, script);
  const speechProgress = async (value, stage = '') => {
    const numeric = Number(value);
    const normalized = Number.isFinite(numeric) ? Math.max(0, Math.min(100, numeric)) : 50;
    await onProgress(10 + Math.round(normalized * 0.14), stage || '正在生成口播声音');
  };
  const narration = await synthesizeVoice({
    text: script,
    voiceId: engineVoiceId,
    language: String(input.language || voice.language || '').trim()
  }, project, { onProgress: speechProgress });
  await onProgress(20, '口播声音已生成');

  const existingResourceId = cachedResource(project, imageAssetId, mode.createReqKey);
  const resourceId = existingResourceId || await (async () => {
    const roleTaskId = await submitTask(config, mode.createReqKey, { image_url: imageUrl }, 'TALKING_PHOTO_ROLE_CREATE_FAILED');
    await onProgress(24, '人物形象任务已提交');
    const completedRole = await pollTask(config, mode.createReqKey, roleTaskId, { kind: 'role', progressStart: 26, progressEnd: 40, onProgress });
    const createdResourceId = String(completedRole.responseData?.resource_id || '').trim();
    if (!createdResourceId) throw new ProviderError('TALKING_PHOTO_INVALID_RESPONSE', '人物形象已完成，但没有返回形象编号', { details: completedRole.payload });
    return createdResourceId;
  })();
  if (existingResourceId) await onProgress(40, '已复用人物形象');

  let publishedNarration;
  try {
    publishedNarration = await publishNarration({ project, input, audio: narration, taskKey: String(input.idempotencyKey || '').trim() || randomUUID() });
    if (!/^https?:\/\//i.test(String(publishedNarration?.url || ''))) {
      throw new ProviderError('TALKING_PHOTO_PUBLIC_STORAGE_REQUIRED', '口播音频需要可限时访问的 OSS 地址，请先配置对象存储', { status: 503 });
    }
    await onProgress(44, '口播声音已安全上传');
    const videoTaskId = await submitTask(config, mode.videoReqKey, { resource_id: resourceId, audio_url: publishedNarration.url }, 'TALKING_PHOTO_VIDEO_CREATE_FAILED');
    await Promise.resolve(onSubmitted?.(videoTaskId)).catch(() => {});
    await onProgress(48, '数字人口播任务已提交');
    const completed = await pollTask(config, mode.videoReqKey, videoTaskId, { kind: 'video', progressStart: 50, progressEnd: 78, onProgress });
    const previewUrls = Array.isArray(completed.responseData?.preview_url) ? completed.responseData.preview_url : [];
    const videoUrl = String(completed.payload?.data?.video_url || previewUrls[0] || completed.responseData?.video_url || '').trim();
    if (!videoUrl) throw new ProviderError('TALKING_PHOTO_INVALID_RESPONSE', '数字人口播任务已完成，但没有返回视频地址', { details: completed.payload });
    const duration = Number(completed.responseData?.video?.VideoMeta?.Duration ?? completed.responseData?.duration);
    return {
      provider: 'domestic-talking-photo',
      model: mode.mode,
      externalTaskId: videoTaskId,
      output: {
        videoUrl,
        durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : mode.estimatedSeconds,
        imageAssetId,
        sourceScript: script,
        speechScript: script,
        voiceId: voice.id,
        engineVoiceId,
        voiceName: voice.name || null,
        aspectRatio,
        driveMode: mode.mode,
        engine: mode.mode,
        resourceId,
        resourceReqKey: mode.createReqKey,
        videoReqKey: mode.videoReqKey,
        providerPricePerSecondCny: config.pricePerSecondCny,
        providerRolePriceCny: config.rolePriceCny
      }
    };
  } finally {
    await publishedNarration?.cleanup?.();
  }
}
