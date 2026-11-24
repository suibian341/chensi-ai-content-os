export class ProviderError extends Error {
  constructor(code, message, { status = 0, retryable = false, details = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.details = details;
  }
}

export function joinUrl(baseUrl, pathname) {
  return `${String(baseUrl || '').replace(/\/+$/, '')}/${String(pathname || '').replace(/^\/+/, '')}`;
}

export async function fetchJson(url, options = {}) {
  const { timeoutMs = 20_000, headers = {}, ...requestOptions } = options;
  let response;
  try {
    response = await fetch(url, {
      ...requestOptions,
      headers,
      signal: requestOptions.signal || AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw new ProviderError(
      timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNREACHABLE',
      timedOut ? '外部能力调用超时' : '无法连接外部能力服务',
      { retryable: true, details: error instanceof Error ? error.message : String(error) }
    );
  }

  const raw = await response.text();
  let payload = null;
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = { raw };
    }
  }
  if (!response.ok) {
    const message = payload?.error?.message || payload?.error || payload?.detail?.message || payload?.detail || payload?.message;
    throw new ProviderError('PROVIDER_HTTP_ERROR', String(message || `外部服务返回 HTTP ${response.status}`), {
      status: response.status,
      retryable: response.status === 408 || response.status === 429 || response.status >= 500,
      details: payload
    });
  }
  return payload;
}

export function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  const text = String(value ?? '')
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let candidate = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (start < 0) {
      if (char !== '{') continue;
      start = index;
      depth = 1;
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        candidate = text.slice(start, index + 1);
        break;
      }
    }
  }
  if (!candidate) throw new ProviderError('PROVIDER_INVALID_JSON', '模型没有返回完整的结构化结果', { details: { outputLength: text.length, truncated: start >= 0 } });
  try {
    const parsed = JSON.parse(candidate);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch (error) {
    throw new ProviderError('PROVIDER_INVALID_JSON', '模型返回的 JSON 格式无效', {
      details: { parseError: error instanceof Error ? error.message : String(error), outputLength: text.length }
    });
  }
}
