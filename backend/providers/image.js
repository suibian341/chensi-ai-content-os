import { fetchJson, joinUrl, ProviderError } from '../lib/http.js';
import { getProviderConfig } from './config.js';

function imageEndpoint(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return base.endsWith('/images/generations') ? base : joinUrl(base, 'images/generations');
}

function grsaiEndpoint(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (base.endsWith('/generate')) return base;
  return joinUrl(base, 'v1/api/generate');
}

function grsaiStatusEndpoint(baseUrl, taskId) {
  return `${grsaiEndpoint(baseUrl).replace(/\/+$/, '')}/${encodeURIComponent(taskId)}`;
}

const standardAspectRatios = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']);
const standardPixelSizes = new Set(['1024x1024', '1672x941', '941x1672', '1443x1090', '1090x1443', '1536x1024', '1024x1536']);
const vipRatioSizes = new Map([
  ['1:1', '2048x2048'],
  ['16:9', '2048x1152'],
  ['9:16', '1152x2048'],
  ['4:3', '2048x1536'],
  ['3:4', '1536x2048'],
  ['3:2', '1536x1024'],
  ['2:3', '1024x1536']
]);

function validVipPixelSize(value) {
  const match = String(value || '').match(/^(\d{3,4})x(\d{3,4})$/i);
  if (!match) return false;
  const width = Number(match[1]);
  const height = Number(match[2]);
  const pixels = width * height;
  return width % 16 === 0
    && height % 16 === 0
    && Math.max(width, height) <= 3840
    && Math.max(width, height) / Math.min(width, height) <= 3
    && pixels >= 655_360
    && pixels <= 8_294_400;
}

function normalizeAspectRatio(input, config) {
  const vip = /gpt-image-2-vip/i.test(config.model);
  const value = String(input.aspectRatio || config.defaultAspectRatio || (vip ? '2048x2048' : '1:1')).trim().toLowerCase();
  if (vip && vipRatioSizes.has(value)) return vipRatioSizes.get(value);
  if (vip && validVipPixelSize(value)) return value;
  if (!vip && (standardAspectRatios.has(value) || standardPixelSizes.has(value))) return value;
  throw new ProviderError(
    'IMAGE_ASPECT_RATIO_INVALID',
    vip ? '当前高清图片模式需要有效的 1K-4K 像素尺寸' : '当前图片模式不支持该比例或像素尺寸',
    { status: 400, details: { model: config.model, aspectRatio: value } }
  );
}

function providerHeaders(config) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  return headers;
}

function imagePrompt(input) {
  const prompt = String(input.prompt || '').trim();
  const style = String(input.style || '').trim();
  return style ? `${prompt}\n视觉风格：${style}` : prompt;
}

function resultError(payload) {
  const status = String(payload?.status || '').toLowerCase();
  const message = String(payload?.error || payload?.message || '图片生成失败');
  if (status === 'violation') return new ProviderError('IMAGE_CONTENT_VIOLATION', message, { status: 422, details: payload });
  if (status === 'failed') return new ProviderError('IMAGE_GENERATION_FAILED', message, { retryable: true, details: payload });
  return null;
}

function extractGrsaiUrl(payload) {
  const item = Array.isArray(payload?.results) ? payload.results[0] : null;
  return item?.url || item?.image_url || '';
}

function imageProviderProgress(payload) {
  const raw = payload?.progress ?? payload?.percent ?? payload?.percentage ?? payload?.data?.progress ?? payload?.data?.percent;
  const value = Number.parseFloat(String(raw ?? '').replace('%', ''));
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
}

async function waitForGrsaiResult(config, initial, { onProgress = async () => {} } = {}) {
  const taskId = String(initial?.id || '').trim();
  if (!taskId) throw new ProviderError('IMAGE_EMPTY_RESPONSE', '图片服务没有返回任务编号', { details: initial });
  const deadline = Date.now() + config.timeoutMs;
  const intervalMs = Math.max(250, Number(config.pollIntervalMs) || 2_000);
  let payload = initial;
  while (Date.now() < deadline) {
    const failure = resultError(payload);
    if (failure) throw failure;
    const status = String(payload?.status || '').toLowerCase();
    if (['succeeded', 'success', 'completed', 'done'].includes(status)) {
      await onProgress(70, '图片生成完成');
      return payload;
    }
    const providerProgress = imageProviderProgress(payload);
    await onProgress(
      providerProgress === null ? (['running', 'processing'].includes(status) ? 48 : 34) : 34 + Math.round(providerProgress * 0.34),
      ['running', 'processing'].includes(status) ? '图片正在生成' : '图片任务已排队'
    );
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    payload = await fetchJson(grsaiStatusEndpoint(config.baseUrl, taskId), {
      method: 'GET',
      headers: providerHeaders(config),
      timeoutMs: Math.min(config.timeoutMs, 20_000)
    });
  }
  throw new ProviderError('IMAGE_GENERATION_TIMEOUT', '图片生成任务轮询超时', { retryable: true, details: { taskId } });
}

async function generateGrsaiImage(input, config, options = {}) {
  if (!config.apiKey) throw new ProviderError('IMAGE_NOT_CONFIGURED', '图片生成功能尚未配置，当前不可用', { status: 503 });
  const requestedReplyType = String(input.replyType || config.replyType || 'json').toLowerCase();
  const replyType = ['json', 'async'].includes(requestedReplyType) ? requestedReplyType : 'json';
  const images = Array.isArray(input.images) ? input.images.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 4) : [];
  const aspectRatio = normalizeAspectRatio(input, config);
  const payload = await fetchJson(grsaiEndpoint(config.baseUrl), {
    method: 'POST',
    headers: providerHeaders(config),
    timeoutMs: config.timeoutMs,
    body: JSON.stringify({
      model: config.model,
      prompt: imagePrompt(input),
      ...(images.length ? { images } : {}),
      aspectRatio,
      replyType
    })
  });
  await options.onProgress?.(32, replyType === 'async' ? '图片任务已提交' : '图片结果已返回');
  const completed = replyType === 'async' ? await waitForGrsaiResult(config, payload, options) : payload;
  const failure = resultError(completed);
  if (failure) throw failure;
  const url = extractGrsaiUrl(completed);
  if (!url) throw new ProviderError('IMAGE_EMPTY_RESPONSE', '图片服务没有返回图片地址', { retryable: true, details: completed });
  await options.onProgress?.(70, '图片生成完成');
  return {
    provider: 'grsai-gpt-image',
    model: config.model,
    externalTaskId: completed.id || payload.id || null,
    output: { url, revisedPrompt: '', aspectRatio, status: completed.status || 'succeeded' }
  };
}

async function generateOpenAiCompatibleImage(input, config, options = {}) {
  const payload = await fetchJson(imageEndpoint(config.baseUrl), {
    method: 'POST',
    headers: providerHeaders(config),
    timeoutMs: config.timeoutMs,
    body: JSON.stringify({
      model: config.model,
      prompt: imagePrompt(input),
      n: 1,
      size: input.size || '1024x1024',
      response_format: 'url'
    })
  });
  const item = payload?.data?.[0] || payload?.images?.[0];
  const url = item?.url || item?.image_url;
  if (!url) throw new ProviderError('IMAGE_EMPTY_RESPONSE', '图片服务没有返回图片地址');
  await options.onProgress?.(70, '图片生成完成');
  return { provider: 'openai-compatible-image', model: config.model, output: { url, revisedPrompt: item.revised_prompt || '' } };
}

export async function generateImage(input, options = {}) {
  const config = getProviderConfig().image;
  if (!config.enabled || !config.model || !config.baseUrl) {
    throw new ProviderError('IMAGE_NOT_CONFIGURED', '文生图 API 尚未配置，当前功能不可用', { status: 503 });
  }
  if (config.provider === 'grsai-gpt-image' || /gpt-image-2/i.test(config.model) || /grsai/i.test(config.baseUrl)) {
    return generateGrsaiImage(input, config, options);
  }
  return generateOpenAiCompatibleImage(input, config, options);
}
