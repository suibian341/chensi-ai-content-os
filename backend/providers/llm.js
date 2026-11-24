import { fetchJson, joinUrl, parseJsonObject, ProviderError } from '../lib/http.js';
import { getProviderConfig } from './config.js';

function chatEndpoint(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return base.endsWith('/chat/completions') ? base : joinUrl(base, 'chat/completions');
}

function responsesEndpoint(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (base.endsWith('/responses')) return base;
  if (base.endsWith('/chat/completions')) return `${base.slice(0, -'/chat/completions'.length)}/responses`;
  return joinUrl(base, 'responses');
}

function useResponsesApi(config) {
  const baseUrl = String(config.baseUrl || '');
  if (/\/chat\/completions\/?$/i.test(baseUrl)) return false;
  if (/\/responses\/?$/i.test(baseUrl)) return true;
  return /doubao-seed-evolving/i.test(config.model) || /^gpt-5(?:\.\d+)?(?:[-_].*)?$/i.test(config.model);
}

function requestConfig(providerConfig, hasVideo) {
  return hasVideo || !providerConfig.textLlm?.dedicated
    ? providerConfig.llm
    : providerConfig.textLlm;
}

function providerLabel(config, responsesApi) {
  if (/ark\.cn-beijing\.volces\.com/i.test(config.baseUrl) || /doubao/i.test(config.model)) {
    return 'volcengine-ark-responses';
  }
  return responsesApi ? 'openai-responses' : 'openai-compatible';
}

function extractContent(payload) {
  const direct = payload?.output_text ?? payload?.choices?.[0]?.message?.content ?? payload?.content;
  if (typeof direct === 'string') return direct;
  if (Array.isArray(direct)) {
    const text = direct.map((item) => item?.text || item?.output_text || item?.content || '').join('');
    if (text) return text;
  }

  return (Array.isArray(payload?.output) ? payload.output : [])
    .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .map((item) => item?.text || item?.output_text || '')
    .join('');
}

function structuredPrompt({ system, input, schema }) {
  return `${system}\n只输出合法 JSON 对象，不要输出 Markdown。JSON 结构：${JSON.stringify(schema)}\n用户输入：${JSON.stringify(input)}`;
}

export function responsesBody(config, request) {
  const content = [];
  if (request.video?.url) {
    content.push({ type: 'input_video', video_url: request.video.url, fps: Number(request.video.fps) || 2 });
  }
  content.push({ type: 'input_text', text: structuredPrompt(request) });
  return {
    model: config.model,
    input: [
      {
        role: 'user',
        content
      }
    ],
    text: { format: { type: 'json_object' } },
    reasoning: { effort: 'minimal' },
    ...(/^gpt-5/i.test(config.model) ? {} : { temperature: 0.1 }),
    max_output_tokens: request.maxOutputTokens || 8192,
    store: false
  };
}

function chatBody(config, request) {
  return {
    model: config.model,
    temperature: 0.35,
    // Structured output is enforced by the prompt/parser; some compatible
    // gateways reject the optional response_format field.
    messages: [
      { role: 'system', content: `${request.system}\n只输出 JSON 对象，不要输出 Markdown。JSON 结构：${JSON.stringify(request.schema)}` },
      { role: 'user', content: JSON.stringify(request.input) }
    ]
  };
}

function canFallbackToChat(error) {
  if (!(error instanceof ProviderError)) return false;
  if (['PROVIDER_TIMEOUT', 'PROVIDER_UNREACHABLE'].includes(error.code)) return true;
  return [400, 404, 405, 408, 422, 500, 501, 502, 503].includes(Number(error.status));
}

function hasRequiredFields(value, required) {
  return required.every((field) => value[field] !== undefined && value[field] !== null);
}

export async function generateStructured({ purpose, system, input, schema, required = [], video = null, timeoutMs = null }) {
  const providerConfig = getProviderConfig();
  const hasVideo = Boolean(video?.url || video?.data?.length);
  const config = requestConfig(providerConfig, hasVideo);
  if (!config.enabled) {
    throw new ProviderError('LLM_NOT_CONFIGURED', '大模型尚未配置，当前功能不可用', { status: 503 });
  }

  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  const responsesApi = useResponsesApi(config);
  if (hasVideo && !responsesApi) {
    throw new ProviderError('MULTIMODAL_PROVIDER_REQUIRED', '当前内容模型不支持视频拆解，请配置支持 input_video 的 Ark Responses 模型', { status: 503 });
  }
  const videoUrl = video?.url || (video?.data?.length ? `data:${video.mimeType || 'video/mp4'};base64,${video.data.toString('base64')}` : '');
  const request = {
    system,
    input,
    schema,
    video: videoUrl ? { url: videoUrl, fps: video?.fps || 2 } : null,
    maxOutputTokens: purpose === 'benchmark' ? 16_384 : 8_192
  };
  const requestedTimeoutMs = Number(timeoutMs);
  const requestTimeoutMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
    ? requestedTimeoutMs
    : purpose === 'benchmark' ? Math.max(config.timeoutMs, 10 * 60_000) : config.timeoutMs;
  let payload;
  let usedResponsesApi = responsesApi;
  try {
    payload = await fetchJson(responsesApi ? responsesEndpoint(config.baseUrl) : chatEndpoint(config.baseUrl), {
      method: 'POST', headers,
      timeoutMs: responsesApi && !hasVideo && config.dedicated ? Math.min(requestTimeoutMs, 10_000) : requestTimeoutMs,
      body: JSON.stringify(responsesApi ? responsesBody(config, request) : chatBody(config, request))
    });
  } catch (error) {
    if (!responsesApi || hasVideo || !canFallbackToChat(error)) throw error;
    usedResponsesApi = false;
    payload = await fetchJson(chatEndpoint(config.baseUrl), {
      method: 'POST', headers, timeoutMs: requestTimeoutMs,
      body: JSON.stringify(chatBody(config, request))
    });
  }
  if (usedResponsesApi && payload?.status === 'incomplete') {
    throw new ProviderError('PROVIDER_OUTPUT_TRUNCATED', '模型输出达到长度上限，请重新拆解', { retryable: true, details: payload.incomplete_details || null });
  }
  const data = parseJsonObject(extractContent(payload));
  if (!hasRequiredFields(data, required)) {
    throw new ProviderError('PROVIDER_SCHEMA_MISMATCH', `模型返回缺少字段：${required.filter((field) => data[field] === undefined).join('、')}`);
  }
  return { data, meta: { provider: providerLabel(config, usedResponsesApi), model: config.model, accountId: config.accountId || null, purpose, multimodal: Boolean(videoUrl) } };
}
