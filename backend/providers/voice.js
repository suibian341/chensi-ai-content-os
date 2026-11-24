import { randomUUID } from 'node:crypto';
import { fetchJson, ProviderError } from '../lib/http.js';
import { getProviderConfig } from './config.js';
import { audioFormat, findSource, sleep } from './media.js';
import { synthesizeMultilingual } from './multilingual-tts.js';

const defaultPreviewText = '你好，我是辰思ai为你创建的数字人声音，做运营宣发，就找辰思AI，一用就顺手，越用越省心。';

function headers(config) {
  return {
    'Content-Type': 'application/json',
    'X-Api-Key': config.apiKey,
    'X-Api-Request-Id': randomUUID()
  };
}

export function voiceProviderError(payload, fallbackError = null) {
  const code = Number(payload?.code ?? fallbackError?.details?.code ?? 0);
  const message = String(payload?.message ?? fallbackError?.message ?? '').trim();
  const details = payload || fallbackError?.details || null;
  if (code === 45000030 || /resource not granted/i.test(message)) {
    return new ProviderError(
      'VOICE_CLONE_NOT_ENABLED',
      '当前语音配置没有声音克隆训练权限，或账号下没有可用音色槽位。请开通声音克隆能力后重试',
      { status: fallbackError?.status || 403, details }
    );
  }
  if (code === 55000000 || /resource id is mismatched/i.test(message)) {
    return new ProviderError(
      'VOICE_RESOURCE_MISMATCH',
      '当前 API Key 所属项目没有可用于 V3 声音复刻的音色槽位或资源权限',
      { status: fallbackError?.status || 400, details }
    );
  }
  if ([45001114, 45001122].includes(code)) {
    return new ProviderError('VOICE_SAMPLE_QUALITY_LOW', '录音中人声不够清晰，请在安静环境重新录制', { details });
  }
  if (code === 45001108) {
    return new ProviderError('VOICE_SAMPLE_FORMAT_INVALID', '录音格式无法识别，请更换音频文件', { details });
  }
  if (code === 45001123) {
    return new ProviderError('VOICE_TRAINING_LIMIT', '该音色已达到训练次数上限', { details });
  }
  if ([45001124, 45001125, 45001127, 45001128].includes(code)) {
    return new ProviderError('VOICE_CONTENT_REJECTED', '录音或试听文本未通过内容审核', { details });
  }
  if (fallbackError) return fallbackError;
  return new ProviderError('VOICE_PROVIDER_ERROR', '声音克隆任务处理失败', { details: { ...details, upstreamMessage: message || null } });
}

function validatePayload(payload) {
  const code = Number(payload?.code ?? 0);
  if (code !== 0) {
    throw voiceProviderError(payload);
  }
  return payload;
}

function cloneResult(payload, fallbackId) {
  const statuses = Array.isArray(payload?.speaker_status) ? payload.speaker_status.filter((item) => item && typeof item === 'object') : [];
  const rawStatus = String(payload?.status ?? '0').toLowerCase();
  const mapped = { running: 1, success: 2, failed: 3 }[rawStatus];
  const status = mapped || Number(rawStatus) || 0;
  return {
    voiceId: payload?.speaker_id && payload.speaker_id !== 'custom_speaker_id' ? payload.speaker_id : fallbackId,
    status,
    previewUrl: statuses.find((item) => item.demo_audio)?.demo_audio || null,
    providerStatuses: statuses
  };
}

function prepaidSpeakerSet(config) {
  return new Set((config.prepaidSpeakerIds || []).map((item) => String(item || '').trim()).filter(Boolean));
}

function assertPrepaidResult(config, result, expectedSpeakerId) {
  if (config.billingMode !== 'prepaid') return;
  const actualSpeakerId = String(result?.voiceId || '').trim();
  if (prepaidSpeakerSet(config).has(actualSpeakerId)) return;
  throw new ProviderError(
    'VOICE_PREPAID_RESPONSE_INVALID',
    '预付费音色服务返回的音色与已配置槽位不一致，已停止生成',
    { status: 502, details: { expectedSpeakerId, actualSpeakerId } }
  );
}

async function post(config, endpoint, body) {
  try {
    return validatePayload(await fetchJson(endpoint, {
      method: 'POST',
      headers: headers(config),
      timeoutMs: config.timeoutMs,
      body: JSON.stringify(body)
    }));
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    throw voiceProviderError(error.details, error);
  }
}

export async function cloneVoice(input, project, { onProgress = async () => {} } = {}) {
  const config = getProviderConfig().voice;
  if (!config.enabled) throw new ProviderError('VOICE_NOT_CONFIGURED', '声音克隆功能尚未配置', { status: 503 });
  if (!input.consent) throw new ProviderError('CONSENT_REQUIRED', '声音克隆前必须确认拥有声音授权');
  const prepaid = config.billingMode === 'prepaid';
  // Never let a legacy custom_speaker_id sentinel leak into a prepaid request.
  // A prepaid request must always target an existing console-provisioned slot.
  const requestedSpeakerId = String(input.prepaidSpeakerId || input.speakerId || '').trim();
  const prepaidSpeakerId = prepaid
    ? (requestedSpeakerId && requestedSpeakerId !== 'custom_speaker_id' ? requestedSpeakerId : String(config.prepaidSpeakerIds?.[0] || '').trim())
    : '';
  if (prepaid && !prepaidSpeakerId) {
    throw new ProviderError('VOICE_PREPAID_SPEAKER_REQUIRED', '当前为预付费声音模式，请在后台配置火山控制台提供的音色槽位 ID（speaker_id，通常以 S_ 开头）');
  }
  if (prepaid && !prepaidSpeakerSet(config).has(prepaidSpeakerId)) {
    throw new ProviderError('VOICE_PREPAID_SPEAKER_NOT_ALLOWED', '当前仅允许使用后台配置的预付费音色槽位，请勿传入其他音色 ID', { status: 400 });
  }
  const source = await findSource({ explicit: input.sample, assetId: input.sampleAssetId, assets: project.assets, mimePrefix: 'audio/', timeoutMs: config.timeoutMs });
  if (!source) throw new ProviderError('VOICE_SAMPLE_REQUIRED', '请先在素材库上传 10 至 30 秒的真实声音样本');
  if (source.data.length > config.maxBytes) {
    await source.cleanup?.();
    throw new ProviderError('VOICE_SAMPLE_TOO_LARGE', '声音样本超过声音接口大小限制');
  }
  await onProgress(16, '声音样本已读取');
  const trainingSpeakerId = prepaidSpeakerId || `user_${randomUUID().replaceAll('-', '')}_voice`;
  let payload;
  try {
    payload = await post(config, config.cloneEndpoint, {
      speaker_id: prepaid ? trainingSpeakerId : 'custom_speaker_id',
      ...(prepaid ? {} : { custom_speaker_id: trainingSpeakerId }),
      model_type: config.modelType,
      audio: { data: source.data.toString('base64'), format: audioFormat(source.filename, source.mimeType) },
      language: config.language,
      ...(String(input.sampleText || '').trim() ? { text: String(input.sampleText).trim() } : {}),
      extra_params: {
        enable_audio_denoise: true,
        voice_clone_denoise_model_id: '',
        demo_text: String(input.demoText || config.demoText || '').trim()
      }
    });
  } finally {
    await source.cleanup?.();
  }
  await onProgress(36, '声音训练任务已提交');
  let result = cloneResult(payload, trainingSpeakerId);
  assertPrepaidResult(config, result, trainingSpeakerId);
  const deadline = Date.now() + config.timeoutMs;
  while (result.status === 1 && Date.now() < deadline) {
    await onProgress(48, '声音模型正在训练');
    await sleep(config.pollIntervalMs);
    result = cloneResult(await post(config, config.statusEndpoint, prepaid
      ? { speaker_id: trainingSpeakerId }
      : { speaker_id: 'custom_speaker_id', custom_speaker_id: trainingSpeakerId }), trainingSpeakerId);
    assertPrepaidResult(config, result, trainingSpeakerId);
  }
  if (![2, 4].includes(result.status)) {
    if (result.status === 1) throw new ProviderError('VOICE_TRAINING_TIMEOUT', '声音模型训练超时', { retryable: true });
    throw new ProviderError('VOICE_TRAINING_FAILED', '声音模型训练失败', { details: result.providerStatuses });
  }
  await onProgress(60, '声音模型训练完成');
  const previewText = String(input.demoText || config.demoText || defaultPreviewText).trim() || defaultPreviewText;
  const previewAudio = await synthesizeVoice({ text: previewText, voiceId: result.voiceId }, project, { onProgress });
  return {
    provider: 'volcengine-direct',
    model: `voice-clone-${config.modelType}`,
    externalTaskId: trainingSpeakerId,
    output: {
      voiceId: result.voiceId,
      engineVoiceId: result.voiceId,
      status: 'ready',
      previewUrl: result.previewUrl,
      previewText,
      previewAudio,
      sourceAssetId: source.assetId || null
    }
  };
}

function ttsPayload(config, text, voiceId) {
  if (config.ttsEndpoint.includes('/api/v3/tts/unidirectional')) {
    return {
      user: { uid: config.uid },
      req_params: { text, speaker: voiceId, audio_params: { format: 'mp3', sample_rate: 24000 } }
    };
  }
  return {
    app: { appid: config.appId, token: config.apiKey, cluster: config.cluster },
    user: { uid: config.uid },
    audio: { voice_type: voiceId, encoding: 'mp3', speed_ratio: 1, volume_ratio: 1, pitch_ratio: 1 },
    request: { reqid: randomUUID(), text, text_type: 'plain', operation: 'query' }
  };
}

export async function synthesizeVoice(input, project, { onProgress = async () => {} } = {}) {
  const text = String(input.text || '').trim();
  const voiceId = String(input.voiceId || '').trim();
  if (!text) throw new ProviderError('TTS_TEXT_REQUIRED', '请输入要合成的文案');
  if (String(input.language || '').trim() === 'ug-CN') {
    return synthesizeMultilingual(input, project, { onProgress });
  }
  const config = getProviderConfig().voice;
  if (!config.enabled) throw new ProviderError('VOICE_NOT_CONFIGURED', '语音生成功能尚未配置', { status: 503 });
  if (!config.ttsEndpoint.includes('/api/v3/tts/unidirectional') && !config.appId) throw new ProviderError('TTS_APP_ID_REQUIRED', '声音克隆可用，但文案转语音还需要配置语音合成 App ID', { status: 503 });
  if (!voiceId) throw new ProviderError('TTS_VOICE_REQUIRED', '请选择已克隆的声音');
  if (text.length > 10_000) throw new ProviderError('TTS_TEXT_TOO_LONG', '文案不能超过 10000 个字符');
  if (config.billingMode === 'prepaid' && /^custom_speaker_id$|^custom_|^user_/i.test(voiceId)) {
    throw new ProviderError('VOICE_PREPAID_SPEAKER_NOT_ALLOWED', '当前为预付费模式，不允许使用后付费自定义音色', { status: 400 });
  }
  let response;
  try {
    response = await fetch(config.ttsEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(config.ttsEndpoint.includes('/api/v3/tts/unidirectional') ? { 'X-Api-Key': config.apiKey, 'X-Api-Resource-Id': config.resourceId } : { Authorization: `Bearer;${config.apiKey}` }) },
      timeoutMs: config.timeoutMs,
      body: JSON.stringify(ttsPayload(config, text, voiceId)),
      signal: AbortSignal.timeout(config.timeoutMs)
    });
  } catch (error) {
    throw new ProviderError('TTS_REQUEST_FAILED', '火山 TTS 请求失败，请检查 TTS 接口配置', { retryable: true, details: error.message });
  }
  const raw = await response.text();
  const payloads = raw.split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  const payload = payloads[0] || null;
  if (!response.ok) throw new ProviderError('TTS_PROVIDER_ERROR', `火山 TTS 返回 HTTP ${response.status}`, { details: payload });
  const failed = payloads.find((item) => {
    const code = Number(item?.code ?? item?.status ?? 0);
    return code && ![0, 3000, 20_000_000].includes(code);
  });
  if (failed) throw new ProviderError('TTS_PROVIDER_ERROR', failed.message || '火山 TTS 合成失败', { details: failed });
  const chunks = payloads.map((item) => item?.data || item?.audio?.data || item?.audio_data || item?.data?.audio).filter((item) => typeof item === 'string' && item.length >= 16).map((item) => Buffer.from(item, 'base64'));
  if (!chunks.length) throw new ProviderError('TTS_INVALID_RESPONSE', '火山 TTS 没有返回可用音频数据', { details: payloads.slice(-3) });
  await onProgress(68, '语音合成完成');
  return { data: Buffer.concat(chunks), filename: `tts-${randomUUID()}.mp3`, mimeType: 'audio/mpeg', voiceId, language: String(input.language || '').trim() || null };
}

export async function createVoicePreview(input, project, { onProgress = async () => {} } = {}) {
  const voice = (project.voices || []).find((item) => item.id === input.voiceId || item.engineVoiceId === input.voiceId);
  const voiceId = String(voice?.engineVoiceId || '').trim();
  if (!voiceId) throw new ProviderError('VOICE_NOT_FOUND', '选择的声音不存在');
  const config = getProviderConfig().voice;
  const previewText = String(input.previewText || config.demoText || defaultPreviewText).trim() || defaultPreviewText;
  const previewAudio = await synthesizeVoice({ text: previewText, voiceId }, project, { onProgress });
  return {
    provider: 'volcengine-tts-direct',
    model: `voice-preview-${config.modelType}`,
    externalTaskId: voiceId,
    output: { voiceId: voice.id, engineVoiceId: voiceId, previewText, previewAudio }
  };
}
