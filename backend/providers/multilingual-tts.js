import { randomUUID } from 'node:crypto';
import { fetchJson, ProviderError } from '../lib/http.js';
import { getProviderConfig } from './config.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function requestUrl(config) {
  const url = new URL(config.endpoint);
  if (config.apiKey && !url.searchParams.has('api_key')) url.searchParams.set('api_key', config.apiKey);
  return url;
}

function decodeAudio(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.trim();
  const base64 = normalized.startsWith('data:') ? normalized.slice(normalized.indexOf(',') + 1) : normalized;
  try {
    const data = Buffer.from(base64.replace(/\s/g, ''), 'base64');
    return data.length ? data : null;
  } catch {
    return null;
  }
}

function responseAudio(payload) {
  const candidates = [
    payload?.audio,
    payload?.audio?.data,
    payload?.data,
    payload?.data?.audio,
    payload?.data?.audio?.data,
    payload?.audio_data,
    payload?.result?.audio,
    payload?.result?.audio?.data
  ];
  for (const candidate of candidates) {
    const data = decodeAudio(candidate);
    if (data) return data;
  }
  return null;
}

function normalizeSpeechText(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(/```(?:text|uyghur|arabic)?/gi, '')
    .replace(/```/g, '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '')
    .replace(/^\s*(?:text|speech(?:\s+text)?|口播文案)\s*[:：]\s*/i, '')
    .replace(/[“”「」『』]/g, '')
    .replace(/^['"]|['"]$/g, '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function compactReadableText(value) {
  return String(value || '')
    .replace(/[^\p{L}\p{N}\s\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF，。！？、,.!?；：;:（）()「」“”‘’'"%％+\-]/gu, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export async function synthesizeMultilingual(input, project, { onProgress = async () => {} } = {}) {
  const config = getProviderConfig().multilingualTts;
  if (!config.enabled) {
    throw new ProviderError('MULTILINGUAL_TTS_NOT_CONFIGURED', '维吾尔语文本合成尚未配置，请配置多语言语音服务', { status: 503 });
  }
  const text = normalizeSpeechText(input.text);
  if (!text) throw new ProviderError('TTS_TEXT_REQUIRED', '请输入要合成的文案', { status: 400 });
  if (text.length > 10_000) throw new ProviderError('TTS_TEXT_TOO_LONG', '文案不能超过 10000 个字符', { status: 400 });

  await onProgress(18, '维吾尔语口播文案已准备');
  let payload;
  try {
    let lastError;
    const candidates = [text];
    const compact = compactReadableText(text);
    if (compact && compact !== text) candidates.push(compact);
    for (const candidate of candidates) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          payload = await fetchJson(requestUrl(config), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            timeoutMs: config.timeoutMs,
            body: JSON.stringify({
              model: config.model,
              text_prompt: candidate,
              audio_config: {
                format: 'mp3',
                sample_rate: 24_000,
                speech_rate: 0,
                loudness_rate: 0,
                pitch_rate: 0,
                enable_subtitle: true
              }
            })
          });
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          const readableRatioError = error instanceof ProviderError
            && Number(error.details?.code) === 40402002;
          if (readableRatioError && candidate !== candidates.at(-1)) break;
          if (!(error instanceof ProviderError) || !error.retryable || attempt >= 2) throw error;
          await sleep(800 * (attempt + 1));
        }
      }
      if (!lastError) break;
    }
    if (lastError) throw lastError;
  } catch (error) {
    if (error instanceof ProviderError) {
      throw new ProviderError('MULTILINGUAL_TTS_REQUEST_FAILED', '多语言语音合成请求失败，请检查服务配置后重试', {
        status: error.status,
        retryable: error.retryable,
        details: (() => {
          const upstream = error.details && typeof error.details === 'object' ? error.details : {};
          const upstreamMessage = String(upstream?.message || upstream?.error?.message || upstream?.detail?.message || error.message || '').trim();
          return { ...upstream, upstreamCode: upstream?.code ?? null, upstreamMessage: upstreamMessage || null };
        })()
      });
    }
    throw new ProviderError('MULTILINGUAL_TTS_REQUEST_FAILED', '多语言语音合成请求失败，请稍后重试', { retryable: true, details: error?.message || String(error) });
  }

  const code = Number(payload?.code ?? payload?.status ?? 0);
  if (code && ![0, 200].includes(code)) {
    throw new ProviderError('MULTILINGUAL_TTS_PROVIDER_ERROR', String(payload?.message || payload?.error || '多语言语音合成失败'), { details: payload });
  }
  const data = responseAudio(payload);
  if (!data) throw new ProviderError('MULTILINGUAL_TTS_INVALID_RESPONSE', '多语言语音服务没有返回可用音频数据', { details: payload });
  await onProgress(28, '维吾尔语口播音频已生成');
  return {
    data,
    filename: `multilingual-tts-${randomUUID()}.mp3`,
    mimeType: 'audio/mpeg',
    voiceId: null,
    language: String(input.language || 'ug-CN').trim(),
    durationSeconds: Number.isFinite(Number(payload?.duration)) ? Number(payload.duration) : null,
    subtitle: payload?.subtitle || null,
    provider: 'volcengine-seed-audio-multilingual',
    model: config.model
  };
}
