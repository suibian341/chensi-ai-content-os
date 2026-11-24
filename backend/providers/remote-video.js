import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ProviderError } from '../lib/http.js';
import { commitPreparedFile, deleteStoredFile, prepareGeneratedFile, signedReadUrl, statAssetFile, statStoredObject, storageMode } from '../lib/storage.js';
import { getProviderConfig } from './config.js';
import { joinUrl, serviceFetch, serviceJson, sleep as sleepUntil, tenantId } from './render-service-client.js';

const fileHashCache = new Map();

async function localAssetInfo(asset) {
  const { filePath, stat, cleanup } = await statAssetFile(asset);
  const cacheKey = `${filePath}:${stat.size}:${stat.mtimeMs}`;
  let sha256 = /^[a-f0-9]{64}$/i.test(String(asset.sha256 || ''))
    ? String(asset.sha256).toLowerCase()
    : fileHashCache.get(cacheKey);
  if (!sha256) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filePath)) hash.update(chunk);
    sha256 = hash.digest('hex');
    fileHashCache.set(cacheKey, sha256);
    if (fileHashCache.size > 2_000) fileHashCache.delete(fileHashCache.keys().next().value);
  }
  return { filePath, sizeBytes: stat.size, sha256, cleanup };
}

async function objectAssetInfo(asset, storedMeta = null) {
  const meta = storedMeta || await statStoredObject(asset);
  const cacheKey = `${meta.storageKey}:${meta.sizeBytes}:${meta.etag || meta.lastModified?.getTime?.() || ''}`;
  const declaredHash = [asset.sha256, asset.contentHash]
    .map((value) => String(value || '').trim().toLowerCase())
    .find((value) => /^[a-f0-9]{64}$/.test(value));
  return {
    sizeBytes: Number(meta.sizeBytes || asset.sizeBytes || 0),
    sha256: declaredHash || fileHashCache.get(cacheKey) || '',
    // Sent along so the render service can identify the object without a digest; it
    // comes from the same HEAD that produced the size, so it costs nothing.
    etag: String(meta.etag || asset.etag || '').trim() || '',
    sourceUrl: signedReadUrl(asset),
    cacheKey,
  };
}

function isGeneratedAsset(asset) {
  const sourceType = String(asset?.sourceType || '').toLowerCase();
  const storageKey = String(asset?.storageKey || '').replace(/\\/g, '/').toLowerCase();
  return Boolean(
    asset?.sourceOutputId
    || sourceType.includes('generated')
    || sourceType.includes('output')
    || storageKey.includes('/generated/')
    || /auto[-_\s]?edit/i.test(String(asset?.name || '')),
  );
}

function assetDescriptor(asset) {
  return {
    id: String(asset?.id || ''),
    name: String(asset?.name || asset?.id || '未命名素材'),
    storageKey: asset?.storageKey ? String(asset.storageKey) : null,
  };
}

function missingAssetError(asset, cause = null) {
  const descriptor = assetDescriptor(asset);
  const causeDetails = cause?.details ?? (cause?.message ? String(cause.message) : null);
  return new ProviderError(
    'ASSET_FILE_MISSING',
    `素材文件不存在：${descriptor.name}`,
    {
      status: Number(cause?.status) || 404,
      retryable: false,
      details: {
        asset: descriptor,
        storageMode: storageMode(),
        causeCode: cause?.code || 'ASSET_FILE_MISSING',
        ...(causeDetails == null ? {} : { cause: causeDetails }),
      },
    },
  );
}

async function validateAssetAvailability(assets, requiredIds = new Set()) {
  const metadata = new Map();
  const missing = [];
  await mapWithConcurrency(assets, storageMode() === 'oss' ? 3 : 1, async (asset) => {
    try {
      metadata.set(String(asset.id), await statStoredObject(asset));
    } catch (error) {
      if (error?.code === 'ASSET_FILE_MISSING') missing.push(assetDescriptor(asset));
      else throw error;
    }
  });
  if (missing.length) {
    const ordered = assets
      .map((asset) => missing.find((item) => item.id === String(asset.id)))
      .filter(Boolean);
    const requiredMissing = ordered.filter((item) => requiredIds.has(item.id));
    if (requiredMissing.length) {
      throw new ProviderError(
        'ASSET_FILE_MISSING',
        `素材文件不存在：${requiredMissing.map((item) => item.name).join('、')}`,
        {
          status: 404,
          retryable: false,
          details: { missingAssets: requiredMissing, storageMode: storageMode() },
        },
      );
    }
    return { metadata, missing: ordered };
  }
  return { metadata, missing: [] };
}

function requiredAssets(input, project) {
  const template = String(input.template || 'vlog');
  const selectedIds = new Set([
    ...(Array.isArray(input.videoAssetIds) ? input.videoAssetIds : []),
    input.videoAssetId,
    input.audioAssetId,
  ].map((item) => String(item || '').trim()).filter(Boolean));
  if (!selectedIds.size && input.videoSample) {
    throw new ProviderError(
      'VIDEO_REMOTE_ASSET_REQUIRED',
      '使用远端剪辑服务时，请先将视频上传到素材库再选择',
      { status: 400 },
    );
  }
  const assets = Array.isArray(project?.assets) ? project.assets : [];
  const selected = assets.filter((asset) => selectedIds.has(String(asset.id)) && asset.storageKey);
  if (template !== 'vlog') return selected;
  const mainId = String(input.videoAssetId || input.videoAssetIds?.[0] || '').trim();
  const videos = assets.filter((asset) => (
    asset.storageKey
    && String(asset.mimeType || '').startsWith('video/')
    && (String(asset.id) === mainId || !isGeneratedAsset(asset))
  ));
  return [...new Map([...videos, ...selected].map((asset) => [String(asset.id), asset])).values()];
}

function assetReference(asset, remoteAssetId, sha256) {
  return {
    id: asset.id,
    remoteAssetId,
    name: asset.name,
    mimeType: asset.mimeType,
    kind: asset.kind,
    tags: asset.tags,
    description: asset.description,
    autoEditCategory: asset.autoEditCategory,
    category: asset.category,
    highlightScore: asset.highlightScore,
    sha256,
    contentHash: asset.contentHash,
    visualFingerprint: asset.visualFingerprint,
    perceptualHash: asset.perceptualHash,
    sourceOutputId: asset.sourceOutputId,
    sourceType: asset.sourceType || (String(asset.storageKey || '').replace(/\\/g, '/').includes('/generated/') ? 'generated' : ''),
    createdAt: asset.createdAt,
  };
}

async function syncLocalAsset(config, tenant, asset, signal) {
  const info = await localAssetInfo(asset);
  try {
    const prepared = await serviceJson(config, tenant, '/v1/assets/prepare', {
      method: 'POST',
      body: JSON.stringify({
        sha256: info.sha256,
        sizeBytes: info.sizeBytes,
        name: asset.name,
        mimeType: asset.mimeType,
      }),
      signal,
    });
    if (!prepared.exists) {
      await serviceFetch(config, tenant, prepared.uploadUrl, {
        method: 'PUT',
        body: createReadStream(info.filePath),
        timeoutMs: config.timeoutMs,
        signal,
        headers: {
          'content-type': asset.mimeType || 'application/octet-stream',
          'content-length': String(info.sizeBytes),
          'x-content-sha256': info.sha256,
        },
      });
    }
    return { reference: assetReference(asset, prepared.assetId, info.sha256), sizeBytes: info.sizeBytes };
  } finally {
    await info.cleanup();
  }
}

async function syncObjectAsset(config, tenant, asset, signal, storedMeta = null) {
  const info = await objectAssetInfo(asset, storedMeta);
  if (!info.sourceUrl || !Number.isSafeInteger(info.sizeBytes) || info.sizeBytes <= 0) {
    throw new ProviderError('VIDEO_REMOTE_ASSET_INVALID', '无法读取待剪辑素材的对象存储信息', { status: 409 });
  }
  const imported = await serviceJson(config, tenant, '/v1/assets/import', {
    method: 'POST',
    timeoutMs: config.timeoutMs,
    signal,
    body: JSON.stringify({
      sourceUrl: info.sourceUrl,
      sha256: info.sha256 || undefined,
      // The object's etag, so a service that already cached this content can answer
      // without downloading it again.
      etag: info.etag || undefined,
      sizeBytes: info.sizeBytes,
      name: asset.name,
      mimeType: asset.mimeType,
    }),
  });
  const sha256 = String(imported.sha256 || info.sha256 || '').toLowerCase();
  if (!imported.assetId || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new ProviderError('VIDEO_RENDER_SERVICE_INVALID_RESPONSE', '剪辑服务没有返回有效的素材校验信息', { retryable: true });
  }
  fileHashCache.set(info.cacheKey, sha256);
  if (fileHashCache.size > 2_000) fileHashCache.delete(fileHashCache.keys().next().value);
  return { reference: assetReference(asset, imported.assetId, sha256), sizeBytes: info.sizeBytes };
}

export async function syncAsset(config, tenant, asset, signal, storedMeta = null) {
  try {
    return await (storageMode() === 'oss'
      ? syncObjectAsset(config, tenant, asset, signal, storedMeta)
      : syncLocalAsset(config, tenant, asset, signal));
  } catch (error) {
    if (error?.code === 'ASSET_FILE_MISSING') throw missingAssetError(asset, error);
    throw error;
  }
}

/**
 * Object metadata for an asset, so a caller can hand it to `syncAsset` and avoid a
 * second HEAD request for the same object.
 */
export async function fetchAssetMeta(asset) {
  return statStoredObject(asset);
}

/** Bounded-concurrency map, exported for callers that fan out over an asset library. */
export async function mapAssets(items, concurrency, worker) {
  return mapWithConcurrency(items, concurrency, worker);
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const run = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

function sleep(ms, signal) {
  return sleepUntil(ms, signal);
}

async function cancelRemoteJob(config, tenant, jobId) {
  if (!jobId) return;
  await serviceFetch(config, tenant, `/v1/render-jobs/${encodeURIComponent(jobId)}`, {
    method: 'DELETE',
    timeoutMs: 10_000,
  }).catch(() => {});
}

async function downloadResult(config, tenant, pathname, prepared, expected = {}, signal) {
  const response = await serviceFetch(config, tenant, pathname, {
    method: 'GET',
    timeoutMs: config.timeoutMs,
    signal,
  });
  if (!response.body) throw new ProviderError('VIDEO_RENDER_DOWNLOAD_EMPTY', '剪辑服务没有返回成片文件', { retryable: true });
  const temporary = `${prepared.filePath}.${process.pid}.${randomUUID()}.tmp`;
  const hash = createHash('sha256');
  let sizeBytes = 0;
  const verifier = new Transform({
    transform(chunk, encoding, callback) {
      sizeBytes += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), verifier, createWriteStream(temporary, { flags: 'wx' }));
    const digest = hash.digest('hex');
    if (!sizeBytes || (expected.sizeBytes && sizeBytes !== Number(expected.sizeBytes)) || (expected.sha256 && digest !== expected.sha256)) {
      throw new ProviderError('VIDEO_RENDER_DOWNLOAD_INTEGRITY', '剪辑成片下载校验失败', { retryable: true });
    }
    await fs.rename(temporary, prepared.filePath);
    return { sizeBytes, sha256: digest };
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

function algorithmLabel(template) {
  if (template === 'talking-head') return '口播智能剪辑';
  return '智能视频剪辑';
}

function editSummary(template, output) {
  if (template === 'talking-head') return '口播停顿与节奏已完成智能优化';
  return `已完成 ${Number(output.segmentCount) || 1} 段画面智能剪辑与转场`;
}

export async function renderRemoteVideo(task, input = {}, project, options = {}) {
  const config = getProviderConfig().videoRenderService;
  if (!config.url || !config.apiKey) {
    throw new ProviderError('VIDEO_RENDER_SERVICE_NOT_CONFIGURED', '私有剪辑服务尚未完整配置', { status: 503 });
  }
  const tenant = tenantId(task, project);
  if (!tenant) throw new ProviderError('VIDEO_RENDER_TENANT_REQUIRED', '无法确定剪辑任务所属账号', { status: 400 });
  const template = String(input.template || 'vlog').trim() || 'vlog';
  if (!['vlog', 'talking-head'].includes(template)) {
    throw new ProviderError('VIDEO_TEMPLATE_UNSUPPORTED', '当前仅支持 AI 自动剪辑和口播去气口', { status: 400 });
  }
  input = { ...input, template };
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : async () => {};
  const assets = requiredAssets(input, project);
  if (!assets.length) throw new ProviderError('VIDEO_ASSET_REQUIRED', '请先选择已经上传的素材', { status: 400 });

  const signal = options.signal;
  const requiredIds = new Set([
    ...(Array.isArray(input.videoAssetIds) ? input.videoAssetIds : []),
    input.videoAssetId,
    input.audioAssetId,
  ].map((item) => String(item || '').trim()).filter(Boolean));
  const assetCheck = await validateAssetAvailability(assets, requiredIds);
  const assetMetadata = assetCheck.metadata;
  const availableAssets = assets.filter((asset) => assetMetadata.has(String(asset.id)));
  if (!availableAssets.length) throw new ProviderError('VIDEO_ASSET_REQUIRED', '没有可用的已上传素材，请重新上传后再生成', { status: 400 });
  const skippedAssetWarning = assetCheck.missing.length
    ? `已跳过 ${assetCheck.missing.length} 个失效候选素材：${assetCheck.missing.map((item) => item.name).join('、')}`
    : null;
  const totalBytes = availableAssets.reduce((sum, asset) => sum + Math.max(1, Number(asset.sizeBytes) || 1), 0);
  let syncedBytes = 0;
  let lastSyncProgress = null;
  let syncedCount = 0;
  const syncedAssets = await mapWithConcurrency(availableAssets, storageMode() === 'oss' ? 3 : 1, async (asset) => {
    const synced = await syncAsset(config, tenant, asset, signal, assetMetadata.get(String(asset.id)));
    syncedBytes += Math.max(1, synced.sizeBytes);
    syncedCount += 1;
    const syncProgress = Math.min(10, 2 + Math.round((syncedBytes / totalBytes) * 8));
    if (syncProgress !== lastSyncProgress || syncedCount === availableAssets.length) {
      lastSyncProgress = syncProgress;
      await onProgress(syncProgress, `素材已同步 ${syncedCount}/${assets.length}`);
    }
    return synced;
  });
  const references = syncedAssets.map((item) => item.reference);

  const created = await serviceJson(config, tenant, '/v1/render-jobs', {
    method: 'POST',
    body: JSON.stringify({
      template: input.template || 'vlog',
      input,
      project: {
        id: project.id,
        name: project.name,
        assets: references,
        outputs: (project.outputs || []).filter((item) => item.template === 'vlog').slice(0, 8),
      },
    }),
    signal,
  });
  const jobId = created.id;
  const abortRemote = () => { void cancelRemoteJob(config, tenant, jobId); };
  signal?.addEventListener('abort', abortRemote, { once: true });
  if (signal?.aborted) {
    await cancelRemoteJob(config, tenant, jobId);
    throw signal.reason || new Error('Task canceled');
  }
  await options.onExternalTaskId?.(jobId, 'private-video-render-service');
  const deadline = Date.now() + config.timeoutMs;
  let remote = created;
  let lastRemoteProgress = null;
  let lastRemoteStage = '';
  while (!['completed', 'failed', 'canceled'].includes(remote.status)) {
    if (Date.now() >= deadline) {
      await cancelRemoteJob(config, tenant, jobId);
      throw new ProviderError('VIDEO_RENDER_SERVICE_TIMEOUT', '剪辑服务处理超时，远端任务已取消', { retryable: true });
    }
    await sleep(config.pollIntervalMs, signal);
    remote = await serviceJson(config, tenant, `/v1/render-jobs/${encodeURIComponent(jobId)}`, { signal });
    const remoteProgress = Math.min(90, Math.max(10, Number(remote.progress) || 10));
    const remoteStage = remote.stage || '视频正在剪辑';
    if (remoteProgress !== lastRemoteProgress || remoteStage !== lastRemoteStage) {
      lastRemoteProgress = remoteProgress;
      lastRemoteStage = remoteStage;
      await onProgress(remoteProgress, remoteStage);
    }
  }
  if (remote.status !== 'completed' || !remote.result?.output?.contentUrl) {
    throw new ProviderError(
      remote.error?.code || 'VIDEO_RENDER_REMOTE_FAILED',
      remote.error?.message || '剪辑服务未能完成任务',
      { retryable: remote.status === 'canceled' || remote.error?.code === 'RENDER_TIMEOUT', details: remote.error || null },
    );
  }

  const output = remote.result.output;
  const prepared = await prepareGeneratedFile({
    userId: project.ownerId,
    projectId: project.id,
    taskId: task.id,
    name: output.filename || `${input.title || project.name || 'video'}-${input.template || 'vlog'}.mp4`,
  });
  let subtitle = null;
  let storedVideo = null;
  let storedSubtitle = null;
  try {
    const downloaded = await downloadResult(config, tenant, output.contentUrl, prepared, {
      sizeBytes: output.sizeBytes,
      sha256: output.sha256,
    }, signal);
    if (output.subtitleUrl) {
      subtitle = await prepareGeneratedFile({
        userId: project.ownerId,
        projectId: project.id,
        taskId: `${task.id}-subtitles`,
        name: output.subtitleFilename || 'subtitles.srt',
      });
      await downloadResult(config, tenant, output.subtitleUrl, subtitle, { sha256: output.subtitleSha256 }, signal);
    }
    storedVideo = await commitPreparedFile(prepared, { mimeType: 'video/mp4' });
    storedSubtitle = subtitle
      ? await commitPreparedFile(subtitle, { mimeType: 'application/x-subrip; charset=utf-8' })
      : null;
    return {
      provider: 'private-video-render-service',
      model: remote.result.model || null,
      externalTaskId: jobId,
      output: {
        ...output,
        warning: skippedAssetWarning,
        algorithm: algorithmLabel(input.template || output.template),
        editSummary: editSummary(input.template || output.template, output),
        filename: storedVideo.filename,
        storageKey: storedVideo.storageKey,
        sizeBytes: storedVideo.sizeBytes || downloaded.sizeBytes,
        sha256: storedVideo.sha256,
        etag: storedVideo.etag,
        subtitleFilename: storedSubtitle?.filename || null,
        subtitleStorageKey: storedSubtitle?.storageKey || null,
      },
    };
  } catch (error) {
    if (storedVideo) await deleteStoredFile(storedVideo).catch(() => {});
    if (storedSubtitle) await deleteStoredFile(storedSubtitle).catch(() => {});
    await fs.rm(prepared.filePath, { force: true }).catch(() => {});
    if (subtitle) await fs.rm(subtitle.filePath, { force: true }).catch(() => {});
    if (prepared.temporaryDirectory) await fs.rm(prepared.temporaryDirectory, { recursive: true, force: true }).catch(() => {});
    if (subtitle?.temporaryDirectory) await fs.rm(subtitle.temporaryDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
