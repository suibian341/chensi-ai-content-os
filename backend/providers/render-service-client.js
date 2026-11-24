/**
 * Shared HTTP client for the private video render service.
 *
 * Both execution paths talk to the same service and differ only in what they ask
 * it for:
 *
 *   remote-video.js      -> "render this locally"      (the private ffmpeg box)
 *   remote-video-ims.js  -> "decide the edit, render nothing" (Aliyun IMS runs it)
 *
 * Keeping the transport, auth header and tenant handling in one place means the
 * two paths cannot silently disagree about how the service is addressed.
 */
import { ProviderError } from '../lib/http.js';

export function joinUrl(baseUrl, pathname) {
  if (/^https?:\/\//i.test(String(pathname || '').trim())) return String(pathname).trim();
  return `${String(baseUrl || '').replace(/\/+$/, '')}/${String(pathname || '').replace(/^\/+/, '')}`;
}

export function requestSignal(signal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

export function tenantId(task, project) {
  return String(task?.userId || project?.ownerUserId || project?.userId || project?.id || '').trim();
}

export function serviceHeaders(config, tenant, extra = {}) {
  return {
    authorization: `Bearer ${config.apiKey}`,
    'x-render-tenant': tenant,
    ...extra,
  };
}

async function errorPayload(response) {
  try {
    return JSON.parse(await response.text());
  } catch {
    return null;
  }
}

export async function serviceFetch(config, tenant, pathname, options = {}) {
  let response;
  try {
    response = await fetch(joinUrl(config.url, pathname), {
      ...options,
      headers: serviceHeaders(config, tenant, options.headers),
      signal: requestSignal(options.signal, options.timeoutMs || Math.min(config.timeoutMs, 60_000)),
      ...(options.body && typeof options.body.pipe === 'function' ? { duplex: 'half' } : {}),
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw new ProviderError(
      timedOut ? 'VIDEO_RENDER_SERVICE_TIMEOUT' : 'VIDEO_RENDER_SERVICE_UNREACHABLE',
      timedOut ? '剪辑服务请求超时' : '暂时无法连接剪辑服务',
      { retryable: true, details: error instanceof Error ? error.message : String(error) },
    );
  }
  if (!response.ok) {
    const payload = await errorPayload(response);
    throw new ProviderError(
      payload?.error?.code || 'VIDEO_RENDER_SERVICE_ERROR',
      payload?.error?.message || `剪辑服务返回 HTTP ${response.status}`,
      {
        status: response.status,
        retryable: response.status === 408 || response.status === 429 || response.status >= 500,
        details: payload,
      },
    );
  }
  return response;
}

export async function serviceJson(config, tenant, pathname, options = {}) {
  const response = await serviceFetch(config, tenant, pathname, {
    ...options,
    headers: {
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  try {
    return await response.json();
  } catch (error) {
    throw new ProviderError('VIDEO_RENDER_SERVICE_INVALID_RESPONSE', '剪辑服务返回了无效数据', {
      retryable: true,
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

export function sleep(ms, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(signal.reason || new Error('Task canceled'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('Task canceled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
