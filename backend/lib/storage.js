import OSS from 'ali-oss';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getProviderConfig } from '../providers/config.js';

export class StorageError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable === true;
    this.details = options.details;
  }
}

let clientCache = new Map();
const CDN_CACHE_CONTROL = 'public, max-age=31536000, immutable';

function storageConfig() {
  return getProviderConfig().storage;
}

export function storageMode() {
  return storageConfig().driver === 'oss' ? 'oss' : 'local';
}

export function assertStorageReady() {
  const config = storageConfig();
  if (!['local', 'oss'].includes(config.driver)) {
    throw new StorageError('STORAGE_DRIVER_INVALID', '素材存储模式只能配置为 local 或 oss');
  }
  if (config.driver === 'oss' && !config.oss.configured) {
    throw new StorageError('OSS_NOT_CONFIGURED', 'OSS 配置不完整，请填写地域或 Endpoint、Bucket、AccessKey ID 和 AccessKey Secret');
  }
  if (process.env.NODE_ENV === 'production' && config.driver !== 'oss' && !config.allowLocalInProduction) {
    throw new StorageError('PRODUCTION_OBJECT_STORAGE_REQUIRED', '生产环境必须启用 OSS；如需临时诊断，请显式设置 IP_AGENT_ALLOW_LOCAL_STORAGE_IN_PRODUCTION=1');
  }
  return config;
}

function ossClient({ publicEndpoint = false } = {}) {
  const config = assertStorageReady();
  if (config.driver !== 'oss') throw new StorageError('OSS_NOT_ENABLED', '当前未启用 OSS 素材存储');
  const endpoint = publicEndpoint ? config.oss.endpoint : config.oss.internalEndpoint || config.oss.endpoint;
  const cacheKey = JSON.stringify([
    config.oss.region, config.oss.bucket, config.oss.accessKeyId,
    config.oss.accessKeySecret, config.oss.stsToken, endpoint, config.oss.secure,
  ]);
  if (!clientCache.has(cacheKey)) {
    if (clientCache.size > 4) clientCache = new Map();
    clientCache.set(cacheKey, new OSS({
      region: config.oss.region || undefined,
      bucket: config.oss.bucket,
      accessKeyId: config.oss.accessKeyId,
      accessKeySecret: config.oss.accessKeySecret,
      stsToken: config.oss.stsToken || undefined,
      endpoint: endpoint || undefined,
      secure: config.oss.secure,
      timeout: 120_000,
    }));
  }
  return clientCache.get(cacheKey);
}

async function renameWithRetry(source, destination) {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await fs.rename(source, destination);
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error?.code) || attempt === 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
  throw lastError;
}

export function safeFilename(value, fallback = 'asset.bin') {
  const base = path.basename(String(value || fallback)).normalize('NFKC');
  const cleaned = base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '').trim();
  return (cleaned || fallback).slice(0, 180);
}

export function normalizeStorageKey(storageKey) {
  const key = String(storageKey || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!key || key.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new StorageError('INVALID_STORAGE_KEY', '素材存储路径无效');
  }
  return key;
}

export function resolveStorageKey(storageKey) {
  const root = storageConfig().root;
  const key = normalizeStorageKey(storageKey);
  const resolved = path.resolve(root, ...key.split('/'));
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new StorageError('INVALID_STORAGE_KEY', '素材存储路径越界');
  }
  return resolved;
}

function decodeBase64(value) {
  const text = String(value || '').trim();
  const encoded = text.includes(',') && text.startsWith('data:') ? text.slice(text.indexOf(',') + 1) : text;
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded.replace(/\s/g, ''))) {
    throw new StorageError('INVALID_UPLOAD', '素材文件编码无效');
  }
  return Buffer.from(encoded, 'base64');
}

export function assetStorageKey({ userId = '', projectId, assetId, name, generated = false }) {
  const filename = safeFilename(name);
  const tenant = safeFilename(userId || 'shared', 'shared');
  const project = safeFilename(projectId, 'project');
  const asset = safeFilename(assetId, 'asset');
  return normalizeStorageKey(`users/${tenant}/projects/${project}/${generated ? 'generated' : 'assets'}/${asset}/${filename}`);
}

async function putBuffer(storageKey, buffer, mimeType = 'application/octet-stream') {
  const config = assertStorageReady();
  const key = normalizeStorageKey(storageKey);
  if (config.driver === 'oss') {
    try {
      const result = await ossClient().put(key, buffer, { mime: mimeType, headers: { 'Cache-Control': CDN_CACHE_CONTROL } });
      return { etag: String(result?.res?.headers?.etag || '').replace(/^"|"$/g, '') || null };
    } catch (error) {
      throw new StorageError('OSS_UPLOAD_FAILED', '素材上传到 OSS 失败', { status: 502, retryable: true, details: error?.message || String(error) });
    }
  }
  const destination = resolveStorageKey(key);
  const temporary = `${destination}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.writeFile(temporary, buffer);
    await renameWithRetry(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
  return { etag: null };
}

export async function saveAssetFile({ userId, projectId, assetId, name, mimeType = 'application/octet-stream', data }) {
  const config = assertStorageReady();
  const buffer = Buffer.isBuffer(data) ? data : decodeBase64(data);
  if (!buffer.length) throw new StorageError('EMPTY_UPLOAD', '素材文件不能为空');
  if (buffer.length > config.maxBytes) {
    throw new StorageError('UPLOAD_TOO_LARGE', `素材文件不能超过 ${Math.round(config.maxBytes / 1024 / 1024)} MB`, { status: 413 });
  }
  const storageKey = assetStorageKey({ userId, projectId, assetId, name });
  const uploaded = await putBuffer(storageKey, buffer, mimeType);
  return {
    storageKey,
    sizeBytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    etag: uploaded.etag,
  };
}

export async function createDirectUpload({ userId, projectId, assetId, name, mimeType, sizeBytes }) {
  const config = assertStorageReady();
  const size = Number(sizeBytes);
  if (!Number.isInteger(size) || size <= 0) throw new StorageError('EMPTY_UPLOAD', '素材文件不能为空', { status: 400 });
  if (size > config.maxBytes) {
    throw new StorageError('UPLOAD_TOO_LARGE', `素材文件不能超过 ${Math.round(config.maxBytes / 1024 / 1024)} MB`, { status: 413 });
  }
  const storageKey = assetStorageKey({ userId, projectId, assetId, name });
  if (config.driver === 'oss') {
    const contentType = String(mimeType || 'application/octet-stream');
    const uploadUrl = ossClient({ publicEndpoint: true }).signatureUrl(storageKey, {
      method: 'PUT',
      expires: config.directUploadExpiresSeconds,
      'Content-Type': contentType,
    });
    return {
      driver: 'oss', storageKey, uploadUrl, method: 'PUT',
      headers: { 'Content-Type': contentType, 'Cache-Control': CDN_CACHE_CONTROL },
      expiresIn: config.directUploadExpiresSeconds,
    };
  }
  return { driver: 'local', storageKey, uploadUrl: null, method: 'PUT', headers: { 'Content-Type': String(mimeType || 'application/octet-stream') }, expiresIn: config.directUploadExpiresSeconds };
}

export async function saveDirectUploadStream({ storageKey, stream, sizeBytes, mimeType = 'application/octet-stream' }) {
  const config = assertStorageReady();
  if (config.driver !== 'local') throw new StorageError('DIRECT_UPLOAD_TARGET_INVALID', 'OSS 模式必须直接上传到签名地址', { status: 409 });
  const size = Number(sizeBytes);
  if (!Number.isInteger(size) || size <= 0 || size > config.maxBytes) throw new StorageError('UPLOAD_SIZE_INVALID', '素材文件大小无效', { status: 413 });
  const destination = resolveStorageKey(storageKey);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  let received = 0;
  const hash = createHash('sha256');
  stream.on('data', (chunk) => {
    received += chunk.length;
    hash.update(chunk);
    if (received > config.maxBytes || received > size) stream.destroy(new StorageError('UPLOAD_SIZE_INVALID', '上传内容超过声明大小', { status: 413 }));
  });
  try {
    await pipeline(stream, createWriteStream(temporary, { flags: 'wx' }));
    if (received !== size) throw new StorageError('UPLOAD_SIZE_MISMATCH', '上传内容大小与声明不一致', { status: 400 });
    await renameWithRetry(temporary, destination);
    return { storageKey: normalizeStorageKey(storageKey), sizeBytes: received, sha256: hash.digest('hex'), mimeType };
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export async function statStoredObject(item) {
  if (!item?.storageKey) throw new StorageError('ASSET_FILE_MISSING', '该素材没有已保存的文件', { status: 404 });
  const config = assertStorageReady();
  const storageKey = normalizeStorageKey(item.storageKey);
  if (config.driver === 'oss') {
    try {
      const result = await ossClient().getObjectMeta(storageKey);
      const headers = result?.res?.headers || {};
      const size = Number(headers['content-length'] || headers['x-oss-object-size'] || 0);
      return {
        storageKey,
        sizeBytes: size,
        etag: String(headers.etag || '').replace(/^"|"$/g, '') || null,
        mimeType: headers['content-type'] || item.mimeType || 'application/octet-stream',
        lastModified: headers['last-modified'] ? new Date(headers['last-modified']) : null,
      };
    } catch (error) {
      const missing = Number(error?.status) === 404 || error?.code === 'NoSuchKey';
      throw new StorageError(missing ? 'ASSET_FILE_MISSING' : 'OSS_HEAD_FAILED', missing ? '素材文件不存在' : '无法读取 OSS 素材信息', { status: missing ? 404 : 502, retryable: !missing, details: error?.message || String(error) });
    }
  }
  const filePath = resolveStorageKey(storageKey);
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile()) throw new StorageError('ASSET_FILE_MISSING', '素材文件不存在', { status: 404 });
  return { storageKey, filePath, sizeBytes: stat.size, etag: null, mimeType: item.mimeType || 'application/octet-stream', lastModified: stat.mtime };
}

// Register an object written by a cloud renderer without downloading it to the API host.
export async function registerExistingObject({ storageKey, sizeBytes = 0, mimeType = 'application/octet-stream', sha256 = null, etag = null, filename = null }) {
  const key = normalizeStorageKey(storageKey);
  const meta = await statStoredObject({ storageKey: key, mimeType });
  return {
    storageKey: key,
    filename: filename || safeFilename(path.basename(key)),
    sizeBytes: Number(meta.sizeBytes || sizeBytes || 0),
    sha256: sha256 || null,
    etag: etag || meta.etag || null,
    mimeType: meta.mimeType || mimeType,
    lastModified: meta.lastModified || null,
  };
}

export async function readAssetFile(asset, { includeData = true, onProgress = null } = {}) {
  const meta = await statStoredObject(asset);
  if (storageMode() === 'local') {
    return { filePath: meta.filePath, data: includeData ? await fs.readFile(meta.filePath) : null, cleanup: async () => {} };
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chensi-object-'));
  const filePath = path.join(directory, safeFilename(asset.name || path.basename(meta.storageKey)));
  try {
    const response = await ossClient().getStream(meta.storageKey);
    let receivedBytes = 0;
    let lastProgress = -1;
    let progressUpdates = Promise.resolve();
    const meter = new Transform({
      transform(chunk, encoding, callback) {
        receivedBytes += chunk.length;
        if (typeof onProgress === 'function' && meta.sizeBytes > 0) {
          const measured = Math.min(100, Math.floor((receivedBytes / meta.sizeBytes) * 100));
          const progress = measured === 100 ? 100 : Math.floor(measured / 2) * 2;
          if (progress > lastProgress) {
            lastProgress = progress;
            progressUpdates = progressUpdates.then(() => onProgress(progress / 100));
          }
        }
        callback(null, chunk);
      },
    });
    await pipeline(response.stream, meter, createWriteStream(filePath, { flags: 'wx' }));
    await progressUpdates;
    return {
      filePath,
      data: includeData ? await fs.readFile(filePath) : null,
      cleanup: () => fs.rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    if (error instanceof StorageError) throw error;
    throw new StorageError('OSS_DOWNLOAD_FAILED', '从 OSS 读取素材失败', { status: 502, retryable: true, details: error?.message || String(error) });
  }
}

export async function statAssetFile(asset, { onProgress = null } = {}) {
  const loaded = await readAssetFile(asset, { includeData: false, onProgress });
  const stat = await fs.stat(loaded.filePath);
  if (!stat.isFile()) {
    await loaded.cleanup();
    throw new StorageError('ASSET_FILE_MISSING', '素材文件不存在', { status: 404 });
  }
  return { filePath: loaded.filePath, stat, cleanup: loaded.cleanup };
}

export async function deleteStoredFile(item) {
  if (!item?.storageKey) return false;
  const key = normalizeStorageKey(item.storageKey);
  if (storageMode() === 'oss') {
    try {
      await ossClient().delete(key);
    } catch (error) {
      if (Number(error?.status) !== 404 && error?.code !== 'NoSuchKey') {
        throw new StorageError('OSS_DELETE_FAILED', '删除 OSS 素材失败', { status: 502, retryable: true, details: error?.message || String(error) });
      }
    }
    return true;
  }
  await fs.rm(resolveStorageKey(key), { force: true });
  return true;
}

export async function prepareGeneratedFile({ userId, projectId, taskId, name }) {
  const filename = safeFilename(name, 'output.bin');
  const storageKey = assetStorageKey({ userId, projectId, assetId: taskId, name: filename, generated: true });
  if (storageMode() === 'local') {
    const filePath = resolveStorageKey(storageKey);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    return { filename, storageKey, filePath, temporaryDirectory: null };
  }
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'chensi-generated-'));
  return { filename, storageKey, filePath: path.join(temporaryDirectory, filename), temporaryDirectory };
}

export async function commitPreparedFile(prepared, { mimeType = 'application/octet-stream', cleanup = true } = {}) {
  const stat = await fs.stat(prepared.filePath).catch(() => null);
  if (!stat?.isFile() || stat.size <= 0) throw new StorageError('GENERATED_FILE_EMPTY', '生成文件为空');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(prepared.filePath)) hash.update(chunk);
  const sha256 = hash.digest('hex');
  let etag = null;
  try {
    if (storageMode() === 'oss') {
      const result = await ossClient().put(normalizeStorageKey(prepared.storageKey), prepared.filePath, {
        mime: mimeType,
        headers: { 'Cache-Control': CDN_CACHE_CONTROL },
      });
      etag = String(result?.res?.headers?.etag || '').replace(/^"|"$/g, '') || null;
    }
    return { ...prepared, sizeBytes: stat.size, sha256, etag };
  } catch (error) {
    throw new StorageError('OSS_UPLOAD_FAILED', '生成结果保存到 OSS 失败', { status: 502, retryable: true, details: error?.message || String(error) });
  } finally {
    if (cleanup && prepared.temporaryDirectory) await fs.rm(prepared.temporaryDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

function cdnUrl(storageKey, config) {
  const encodedPath = `/${normalizeStorageKey(storageKey).split('/').map(encodeURIComponent).join('/')}`;
  if (!config.cdn.authKey) return `https://${config.cdn.domain}${encodedPath}`;
  if (config.cdn.authType !== 'a') throw new StorageError('CDN_AUTH_TYPE_UNSUPPORTED', '当前仅支持阿里云 CDN A 鉴权方式');
  const now = Math.floor(Date.now() / 1000);
  const timestamp = Math.ceil(now / config.cdn.expiresSeconds) * config.cdn.expiresSeconds + config.cdn.expiresSeconds;
  const random = '0';
  const uid = '0';
  const digest = createHash('md5').update(`${encodedPath}-${timestamp}-${random}-${uid}-${config.cdn.authKey}`).digest('hex');
  return `https://${config.cdn.domain}${encodedPath}?auth_key=${timestamp}-${random}-${uid}-${digest}`;
}

export function signedReadUrl(item, { disposition = 'inline', filename = '', preferOss = false } = {}) {
  if (!item?.storageKey) throw new StorageError('ASSET_FILE_MISSING', '该素材没有已保存的文件', { status: 404 });
  const config = assertStorageReady();
  if (config.driver !== 'oss') return null;
  // Cloud renderers must fetch the object from OSS itself. CDN A-auth URLs
  // are intended for browser delivery and are not accepted by IMS as input.
  const cdnReady = !preferOss && config.cdn.domain && config.cdn.authKey && config.cdn.authType === 'a';
  if (cdnReady) return cdnUrl(item.storageKey, config);
  const response = {};
  if (disposition === 'attachment') response['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(safeFilename(filename || item.name || 'download'))}`;
  return ossClient({ publicEndpoint: true }).signatureUrl(normalizeStorageKey(item.storageKey), {
    method: 'GET',
    expires: config.readUrlExpiresSeconds,
    ...(Object.keys(response).length ? { response } : {}),
  });
}

export function formatSize(sizeBytes) {
  const bytes = Number(sizeBytes || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
