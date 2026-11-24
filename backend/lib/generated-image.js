import path from 'node:path';
import { getProviderConfig } from '../providers/config.js';
import { ProviderError } from './http.js';
import { formatSize, saveAssetFile } from './storage.js';

const extensionByMime = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['image/avif', '.avif']
]);

const mimeByExtension = new Map([...extensionByMime].map(([mimeType, extension]) => [extension, mimeType]));

function inferredMimeType(sourceUrl, headerValue = '') {
  const headerMime = String(headerValue || '').split(';')[0].trim().toLowerCase();
  if (extensionByMime.has(headerMime)) return headerMime;
  try {
    return mimeByExtension.get(path.extname(new URL(sourceUrl).pathname).toLowerCase()) || '';
  } catch {
    return '';
  }
}

function decodeDataImage(sourceUrl) {
  const match = String(sourceUrl || '').match(/^data:(image\/(?:png|jpeg|webp|gif|avif));base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) return null;
  return { mimeType: match[1].toLowerCase(), data: Buffer.from(match[2].replace(/\s/g, ''), 'base64') };
}

async function downloadImage(sourceUrl, timeoutMs) {
  const embedded = decodeDataImage(sourceUrl);
  if (embedded) return embedded;
  if (!/^https?:\/\//i.test(String(sourceUrl || ''))) {
    throw new ProviderError('IMAGE_RESULT_URL_INVALID', '图片服务返回的结果地址无效');
  }
  let response;
  try {
    response = await fetch(sourceUrl, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new ProviderError('IMAGE_RESULT_DOWNLOAD_FAILED', '生成图片下载失败，暂时无法加入素材库', { retryable: true, details: error.message });
  }
  if (!response.ok) {
    throw new ProviderError('IMAGE_RESULT_DOWNLOAD_FAILED', `生成图片下载失败：HTTP ${response.status}`, { retryable: response.status >= 500 });
  }
  const mimeType = inferredMimeType(sourceUrl, response.headers.get('content-type'));
  if (!mimeType) throw new ProviderError('IMAGE_RESULT_TYPE_INVALID', '图片服务返回的文件类型不受支持');
  const maxBytes = getProviderConfig().storage.maxBytes;
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > maxBytes) throw new ProviderError('IMAGE_RESULT_TOO_LARGE', '生成图片超过素材库单文件大小限制');
  const data = Buffer.from(await response.arrayBuffer());
  if (!data.length) throw new ProviderError('IMAGE_RESULT_EMPTY', '图片服务返回了空文件', { retryable: true });
  if (data.length > maxBytes) throw new ProviderError('IMAGE_RESULT_TOO_LARGE', '生成图片超过素材库单文件大小限制');
  return { mimeType, data };
}

export async function saveGeneratedImageAsset({ project, image, assetId, timeoutMs = 30_000 }) {
  const existing = image.assetId && (project.assets || []).find((item) => item.id === image.assetId && item.storageKey);
  if (existing) {
    image.sourceUrl ||= image.url;
    image.url = existing.accessUrl;
    image.accessUrl = existing.accessUrl;
    return existing;
  }

  const sourceUrl = image.sourceUrl || image.url;
  const downloaded = await downloadImage(sourceUrl, timeoutMs);
  const extension = extensionByMime.get(downloaded.mimeType) || '.img';
  const name = `${String(project.name || 'AI生成图片').trim()}-${String(image.id || assetId).slice(-8)}${extension}`;
  const stored = await saveAssetFile({
    userId: project.ownerId,
    projectId: project.id,
    assetId,
    name,
    mimeType: downloaded.mimeType,
    data: downloaded.data
  });
  const asset = {
    id: assetId,
    name,
    kind: 'AI生成',
    mimeType: downloaded.mimeType,
    description: String(image.prompt || 'AI 生成图片'),
    tags: ['AI生成', image.style].filter(Boolean),
    sourceType: 'generated-image',
    sourceId: image.id,
    originalUrl: sourceUrl,
    createdAt: image.createdAt || new Date().toISOString(),
    ...stored,
    size: formatSize(stored.sizeBytes),
    accessUrl: `/api/assets/${assetId}/content`
  };
  project.assets ||= [];
  project.assets.unshift(asset);
  image.assetId = asset.id;
  image.sourceUrl = sourceUrl;
  image.url = asset.accessUrl;
  image.accessUrl = asset.accessUrl;
  return asset;
}
