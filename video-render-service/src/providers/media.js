import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ProviderError } from '../lib/http.js';
import { currentRenderSignal } from '../lib/render-context.js';
import { statAssetFile } from '../lib/storage.js';

const mimeByExtension = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
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
  throw new ProviderError('VOICE_SAMPLE_FORMAT_UNSUPPORTED', 'Unsupported audio format');
}

export function runCommand(command, args, {
  timeoutMs = 120_000,
  errorCode = 'MEDIA_COMMAND_FAILED',
  errorMessage = 'Media processing failed',
} = {}) {
  return new Promise((resolve, reject) => {
    const signal = currentRenderSignal();
    if (signal?.aborted) {
      reject(new ProviderError('RENDER_CANCELED', 'Render canceled', { status: 499 }));
      return;
    }
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;
    const append = (current, chunk) => `${current}${chunk}`.slice(-1_000_000);
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      callback();
    };
    const abort = () => {
      child.kill();
      finish(() => reject(new ProviderError('RENDER_CANCELED', 'Render canceled', { status: 499 })));
    };
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new ProviderError('MEDIA_TIMEOUT', 'Media processing timed out', { retryable: true })));
    }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', (error) => {
      finish(() => reject(new ProviderError('MEDIA_TOOL_UNAVAILABLE', `Unable to start ${command}`, { details: error.message })));
    });
    child.once('close', (code) => {
      finish(() => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(new ProviderError(errorCode, errorMessage, { details: stderr.slice(-4_000) || stdout.slice(-4_000) }));
      });
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
      throw new ProviderError('SOURCE_DOWNLOAD_FAILED', 'Unable to download source media', { retryable: true, details: error.message });
    }
    if (!response.ok) throw new ProviderError('SOURCE_DOWNLOAD_FAILED', `Source download returned HTTP ${response.status}`);
    const filename = path.basename(new URL(source).pathname) || 'source.bin';
    return {
      filename,
      mimeType: response.headers.get('content-type')?.split(';')[0] || extensionMime(filename),
      data: Buffer.from(await response.arrayBuffer()),
      sourceUrl: source,
    };
  }
  const filePath = path.resolve(source);
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile()) throw new ProviderError('SOURCE_FILE_NOT_FOUND', 'Source media does not exist');
  return { filename: path.basename(filePath), mimeType: extensionMime(filePath), filePath, data: await fs.readFile(filePath) };
}

async function fromAsset(asset) {
  // Resolve the path only. Callers pass `filePath` straight to ffmpeg/ffprobe, so
  // reading the bytes here would pull whole videos into the Node heap for nothing.
  // Auto-edit resolves every candidate b-roll asset at once, so on a project with
  // 200+ assets the previous `fs.readFile` pushed the heap to ~10 GB and stalled
  // ffprobe until MEDIA_TIMEOUT (observed in production). Keep `data` unset.
  const { filePath } = await statAssetFile(asset);
  return {
    assetId: asset.id,
    filename: asset.name || path.basename(filePath),
    mimeType: asset.mimeType || extensionMime(asset.name),
    filePath,
  };
}

export async function findSource({ explicit, assetId, assets = [], mimePrefix, timeoutMs }) {
  const selectedId = String(assetId || '').trim();
  if (selectedId) {
    const selected = assets.find((item) => item.id === selectedId && item.storageKey);
    if (!selected) throw new ProviderError('ASSET_NOT_FOUND', 'Selected asset is missing', { status: 400 });
    if (!String(selected.mimeType || '').startsWith(mimePrefix)) {
      throw new ProviderError('ASSET_TYPE_MISMATCH', 'Selected asset has an invalid media type', { status: 400 });
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
    '-of', 'default=noprint_wrappers=1:nokey=1', source,
  ], {
    timeoutMs: Math.min(config.timeoutMs, 30_000),
    errorCode: 'MEDIA_PROBE_FAILED',
    errorMessage: 'Unable to inspect media',
  });
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new ProviderError('MEDIA_DURATION_INVALID', 'Media duration is invalid');
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

