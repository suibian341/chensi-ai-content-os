import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ProviderError } from '../lib/http.js';
import { readAssetFile } from '../lib/storage.js';

const mimeByExtension = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp'
};

export function extensionMime(filename) {
  return mimeByExtension[path.extname(String(filename || '')).toLowerCase()] || 'application/octet-stream';
}

export function audioFormat(filename, mimeType = '') {
  const extension = path.extname(String(filename || '')).toLowerCase().replace('.', '');
  if (['wav', 'mp3', 'm4a', 'aac', 'ogg', 'pcm'].includes(extension)) return extension;
  if (mimeType === 'audio/wav') return 'wav';
  if (mimeType === 'audio/mpeg') return 'mp3';
  if (mimeType === 'audio/mp4') return 'm4a';
  throw new ProviderError('VOICE_SAMPLE_FORMAT_UNSUPPORTED', '声音样本必须是 WAV、MP3、M4A、AAC、OGG 或 PCM 文件');
}

export function runCommand(command, args, { timeoutMs = 120_000, errorCode = 'MEDIA_COMMAND_FAILED', errorMessage = '媒体处理失败' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const append = (current, chunk) => `${current}${chunk}`.slice(-1_000_000);
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      child.kill();
      reject(new ProviderError('MEDIA_TIMEOUT', '媒体处理超时', { retryable: true }));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new ProviderError('MEDIA_TOOL_UNAVAILABLE', `无法启动 ${command}`, { details: error.message }));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      reject(new ProviderError(errorCode, errorMessage, { details: stderr.slice(-4_000) || stdout.slice(-4_000) }));
    });
  });
}

async function fromExplicit(value, timeoutMs) {
  const source = String(value || '').trim();
  if (!source) return null;
  if (/^https?:\/\//i.test(source)) {
    let response;
    try {
      response = await fetch(source, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new ProviderError('SOURCE_DOWNLOAD_FAILED', '素材下载失败', { retryable: true, details: error.message });
    }
    if (!response.ok) throw new ProviderError('SOURCE_DOWNLOAD_FAILED', `素材下载失败：HTTP ${response.status}`);
    const filename = path.basename(new URL(source).pathname) || 'source.bin';
    return {
      filename,
      mimeType: response.headers.get('content-type')?.split(';')[0] || extensionMime(filename),
      data: Buffer.from(await response.arrayBuffer()),
      sourceUrl: source
    };
  }
  const filePath = path.resolve(source);
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile()) throw new ProviderError('SOURCE_FILE_NOT_FOUND', '填写的素材文件不存在');
  return { filename: path.basename(filePath), mimeType: extensionMime(filePath), filePath, data: await fs.readFile(filePath) };
}

async function fromAsset(asset) {
  const loaded = await readAssetFile(asset);
  return {
    assetId: asset.id,
    filename: asset.name || path.basename(loaded.filePath),
    mimeType: asset.mimeType || extensionMime(asset.name),
    filePath: loaded.filePath,
    data: loaded.data,
    cleanup: loaded.cleanup
  };
}

export async function findSource({ explicit, assetId, assets = [], mimePrefix, timeoutMs }) {
  const selectedId = String(assetId || '').trim();
  if (selectedId) {
    const selected = assets.find((item) => item.id === selectedId && item.storageKey);
    if (!selected) throw new ProviderError('ASSET_NOT_FOUND', '选择的素材不存在或文件未落盘');
    if (!String(selected.mimeType || '').startsWith(mimePrefix)) {
      throw new ProviderError('ASSET_TYPE_MISMATCH', `选择的素材必须是 ${mimePrefix.replace('/', '')} 类型`);
    }
    return fromAsset(selected);
  }

  const direct = await fromExplicit(explicit, timeoutMs);
  if (direct) return direct;
  const asset = assets.find((item) => String(item.mimeType || '').startsWith(mimePrefix) && item.storageKey);
  if (!asset) return null;
  return fromAsset(asset);
}

export async function probeDuration(source, config) {
  const { stdout } = await runCommand(config.ffprobePath, [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', source
  ], {
    timeoutMs: Math.min(config.timeoutMs, 30_000),
    errorCode: 'MEDIA_PROBE_FAILED',
    errorMessage: '无法读取媒体文件信息'
  });
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new ProviderError('MEDIA_DURATION_INVALID', '媒体文件没有可识别的有效时长');
  }
  return duration;
}

export function pickPayload(payload, key) {
  if (payload && Object.hasOwn(payload, key)) return payload[key];
  return payload?.data && typeof payload.data === 'object' ? payload.data[key] : undefined;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
