import { ProviderError } from '../lib/http.js';
import { getProviderConfig } from './config.js';

function serviceConfig() {
  const config = getProviderConfig().videoRenderService;
  if (!config.enabled || !config.url || !config.apiKey) {
    throw new ProviderError('BACKGROUND_MUSIC_SERVICE_NOT_CONFIGURED', '背景音乐服务尚未配置', { status: 503 });
  }
  return config;
}

function serviceUrl(config, pathname) {
  return `${config.url.replace(/\/+$/, '')}/${String(pathname).replace(/^\/+/, '')}`;
}

async function errorPayload(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function serviceFetch(pathname, { userId, headers = {}, timeoutMs, ...options } = {}) {
  const config = serviceConfig();
  let response;
  try {
    response = await fetch(serviceUrl(config, pathname), {
      ...options,
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'x-render-tenant': String(userId || 'background-music-admin'),
        ...headers,
      },
      signal: options.signal || AbortSignal.timeout(timeoutMs || Math.min(config.timeoutMs, 120_000)),
    });
  } catch (error) {
    throw new ProviderError('BACKGROUND_MUSIC_SERVICE_UNREACHABLE', '暂时无法连接背景音乐服务', {
      retryable: true,
      details: error instanceof Error ? error.message : String(error),
    });
  }
  if (!response.ok) {
    const payload = await errorPayload(response);
    throw new ProviderError(
      payload?.error?.code || 'BACKGROUND_MUSIC_SERVICE_ERROR',
      payload?.error?.message || `背景音乐服务返回 HTTP ${response.status}`,
      { status: response.status, retryable: response.status >= 500, details: payload },
    );
  }
  return response;
}

function publicTrack(track) {
  return {
    id: track.id,
    name: track.name,
    mimeType: track.mimeType,
    sizeBytes: Number(track.sizeBytes) || 0,
    durationSeconds: Number(track.durationSeconds) || 0,
    createdAt: track.createdAt,
    previewUrl: `/api/background-music/${encodeURIComponent(track.id)}/content`,
  };
}

export async function listBackgroundMusic({ userId } = {}) {
  const response = await serviceFetch('/v1/background-music', { userId, headers: { accept: 'application/json' } });
  const payload = await response.json();
  return (Array.isArray(payload?.items) ? payload.items : []).map(publicTrack);
}

export async function uploadBackgroundMusic({ userId, name, mimeType, data, system = false }) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
  const response = await serviceFetch('/v1/background-music', {
    userId: system ? 'system' : userId,
    method: 'POST',
    body: buffer,
    headers: {
      accept: 'application/json',
      'content-type': mimeType,
      'content-length': String(buffer.length),
      'x-background-music-name': encodeURIComponent(name),
    },
  });
  return publicTrack(await response.json());
}

export async function deleteBackgroundMusic(id, { userId, system = false } = {}) {
  const response = await serviceFetch(`/v1/background-music/${encodeURIComponent(id)}`, {
    userId: system ? 'system' : userId,
    method: 'DELETE',
    headers: { accept: 'application/json' },
  });
  return publicTrack(await response.json());
}

export function fetchBackgroundMusicContent(id, { userId, range, signal, method = 'GET' } = {}) {
  return serviceFetch(`/v1/background-music/${encodeURIComponent(id)}/content`, {
    userId,
    method,
    signal,
    timeoutMs: 5 * 60_000,
    headers: range ? { range } : {},
  });
}
