import http from 'node:http';
import path from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getProviderConfig, commandAvailable } from './providers/config.js';
import { renderVideo } from './video-engine/index.js';
import { resolveStorageKey, safeFilename } from './lib/storage.js';
import { runWithRenderSignal } from './lib/render-context.js';
import { BackgroundMusicError, createBackgroundMusicLibrary, isBackgroundMusicId } from './lib/background-music.js';

const TERMINAL_STATES = new Set(['completed', 'failed', 'canceled']);
// `vlog-plan` is the plan-only variant of `vlog`: it returns the compiled IMS
// Timeline instead of a file, for callers that render on Aliyun IMS. Without it
// here the plan branch below is unreachable — the request is rejected as an
// unsupported template before it ever reaches the dispatcher.
const SUPPORTED_TEMPLATES = new Set(['vlog', 'talking-head', 'industry-viral', 'vlog-plan']);
const ASSET_ID_PATTERN = /^a_([a-f0-9]{64})$/;

function shortId(value, length = 12) {
  const text = String(value || '');
  return text.length > length ? `${text.slice(0, length)}...` : text;
}

function logValue(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(String(value ?? ''));
}

function logEvent(logger, level, event, fields = {}) {
  const write = typeof logger?.[level] === 'function'
    ? logger[level].bind(logger)
    : typeof logger?.log === 'function'
      ? logger.log.bind(logger)
      : null;
  if (!write) return;
  const details = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${logValue(value)}`)
    .join(' ');
  write(`[video-render] ${new Date().toISOString()} ${level.toUpperCase()} ${event}${details ? ` ${details}` : ''}`);
}

function progressBar(progress, width = 20) {
  const completed = Math.round((Math.max(0, Math.min(100, progress)) / 100) * width);
  return `${'#'.repeat(completed)}${'-'.repeat(width - completed)}`;
}

function elapsedMs(job) {
  const started = Date.parse(job.startedAt || '');
  return Number.isFinite(started) ? Math.max(0, Date.now() - started) : 0;
}

function logJobProgress(logger, job, { force = false } = {}) {
  const progress = Math.max(0, Math.min(100, Math.round(Number(job.progress) || 0)));
  const stage = String(job.stage || '');
  if (!force && job.lastLoggedProgress === progress && job.lastLoggedStage === stage) return;
  job.lastLoggedProgress = progress;
  job.lastLoggedStage = stage;
  logEvent(logger, 'info', 'job.progress', {
    job: job.id,
    tenant: shortId(job.tenantKey, 8),
    template: job.template,
    bar: progressBar(progress),
    progress,
    stage,
    elapsedMs: elapsedMs(job),
  });
}

class ServiceError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function sha256Text(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function tenantIdentity(req) {
  const raw = String(req.headers['x-render-tenant'] || '').trim();
  if (!raw || raw.length > 180) throw new ServiceError('TENANT_REQUIRED', 'A valid render tenant is required', 400);
  return sha256Text(raw).slice(0, 32);
}

function isAuthorized(req, apiKeys) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!match || !apiKeys.length) return false;
  const supplied = Buffer.from(sha256Text(match[1].trim()), 'hex');
  return apiKeys.some((key) => timingSafeEqual(supplied, Buffer.from(sha256Text(key), 'hex')));
}

function json(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function publicError(error) {
  if (error instanceof ServiceError || error instanceof BackgroundMusicError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'The render service could not process the request' };
}

async function readJson(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new ServiceError('REQUEST_TOO_LARGE', 'Request body is too large', 413);
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    return value;
  } catch {
    throw new ServiceError('INVALID_JSON', 'Request body must be a JSON object', 400);
  }
}

function assetStorageKey(tenantKey, assetId) {
  const match = String(assetId || '').match(ASSET_ID_PATTERN);
  if (!match) throw new ServiceError('ASSET_ID_INVALID', 'Asset id is invalid', 400);
  return `${tenantKey}/assets/${match[1]}.bin`;
}

/**
 * Validate a URL the service is about to fetch on a tenant's behalf.
 *
 * Only HTTPS is accepted, and embedded credentials are refused, so a signed OSS
 * URL is the expected shape. Redirects are followed manually (see below) so the
 * same rule can be re-applied at every hop.
 */
function assertImportUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    throw new ServiceError('ASSET_IMPORT_URL_INVALID', 'Asset import URL is invalid', 400);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new ServiceError('ASSET_IMPORT_URL_INVALID', 'Asset import URL must use HTTPS without embedded credentials', 400);
  }
  return parsed;
}

/** Fetch a remote asset body, following a bounded number of HTTPS redirects. */
async function openImportedAsset(fetchImpl, sourceUrl, signal) {
  let current = assertImportUrl(sourceUrl);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    let response;
    try {
      response = await fetchImpl(current.toString(), { signal, redirect: 'manual' });
    } catch (error) {
      throw new ServiceError('ASSET_IMPORT_FAILED', `Unable to fetch the asset: ${error?.message || error}`, 502);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new ServiceError('ASSET_IMPORT_FAILED', 'Asset import redirect had no location', 502);
      current = assertImportUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok) {
      throw new ServiceError('ASSET_IMPORT_FAILED', `Asset import returned HTTP ${response.status}`, 502);
    }
    return response;
  }
  throw new ServiceError('ASSET_IMPORT_FAILED', 'Asset import followed too many redirects', 502);
}

function publicJob(job) {
  const result = job.status === 'completed' ? job.publicResult : null;
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    stage: job.stage,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    error: job.error,
    result,
  };
}

function cleanOutput(output = {}) {
  const cleaned = { ...output };
  for (const key of [
    'filePath',
    'storageKey',
    'subtitleStorageKey',
    'algorithm',
    'pipelineStages',
    'transitionPolicy',
    'scoreThreshold',
    'maxHighlights',
    'gapThreshold',
    'gapPadding',
    'editSummary',
    'outline',
    'clusters',
  ]) delete cleaned[key];
  cleaned.autoMatchPlan = Array.isArray(output.autoMatchPlan)
    ? output.autoMatchPlan.map((item) => ({
      assetId: item.assetId,
      assetCategory: item.assetCategory,
      timelineStartSeconds: item.timelineStartSeconds,
      timelineEndSeconds: item.timelineEndSeconds,
      durationSeconds: item.durationSeconds,
      assetStartSeconds: item.assetStartSeconds,
      assetEndSeconds: item.assetEndSeconds,
      transition: item.transition,
      transitionDurationSeconds: item.transitionDurationSeconds,
    }))
    : null;
  cleaned.highlights = Array.isArray(output.highlights)
    ? output.highlights.map((item) => ({
      id: item.id,
      start: item.start,
      end: item.end,
      title: item.title,
      text: item.text,
    }))
    : null;
  return cleaned;
}

function sanitizeAssetReference(reference, storageKey) {
  const tags = Array.isArray(reference.tags)
    ? reference.tags.map((item) => String(item).slice(0, 120)).slice(0, 50)
    : [];
  return {
    id: String(reference.id || '').slice(0, 180),
    name: safeFilename(reference.name, 'asset.bin'),
    mimeType: String(reference.mimeType || 'application/octet-stream').slice(0, 100),
    kind: String(reference.kind || '').slice(0, 120),
    tags,
    description: String(reference.description || '').slice(0, 4_000),
    autoEditCategory: String(reference.autoEditCategory || '').slice(0, 120),
    category: String(reference.category || '').slice(0, 120),
    highlightScore: Number(reference.highlightScore) || 0,
    sha256: String(reference.sha256 || '').slice(0, 64),
    // Preserved so the planner can build the shot timeline without measuring every
    // file: the caller already knows each asset's duration, and dropping it here
    // forced a full ffprobe pass over the library on every plan.
    ...(Number(reference.durationSeconds) > 0
      ? { durationSeconds: Number(reference.durationSeconds) }
      : {}),
    contentHash: String(reference.contentHash || '').slice(0, 180),
    visualFingerprint: String(reference.visualFingerprint || '').slice(0, 180),
    perceptualHash: String(reference.perceptualHash || '').slice(0, 180),
    sourceOutputId: String(reference.sourceOutputId || '').slice(0, 180),
    sourceType: String(reference.sourceType || '').slice(0, 120),
    createdAt: String(reference.createdAt || '').slice(0, 80),
    storageKey,
  };
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  let sizeBytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
    sizeBytes += chunk.length;
  }
  return { sha256: hash.digest('hex'), sizeBytes };
}

function parseRange(value, size) {
  const match = String(value || '').match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

async function serveFile(req, res, file) {
  const stat = await fs.stat(file.filePath).catch(() => null);
  if (!stat?.isFile()) throw new ServiceError('RESULT_NOT_FOUND', 'Render result is no longer available', 404);
  const headers = {
    'accept-ranges': 'bytes',
    'content-type': file.mimeType,
    'cache-control': 'private, max-age=86400, immutable',
    etag: `"${file.sha256}"`,
    'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
  };
  const rangeValue = req.headers.range;
  if (rangeValue) {
    const range = parseRange(rangeValue, stat.size);
    if (!range) {
      res.writeHead(416, { ...headers, 'content-range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${range.start}-${range.end}/${stat.size}`,
      'content-length': range.end - range.start + 1,
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file.filePath, { start: range.start, end: range.end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'content-length': stat.size });
  if (req.method === 'HEAD') res.end();
  else createReadStream(file.filePath).pipe(res);
}

function validateJobPayload(payload) {
  const template = String(payload.template || payload.input?.template || '').trim();
  if (!SUPPORTED_TEMPLATES.has(template)) throw new ServiceError('TEMPLATE_INVALID', 'Unsupported render template', 400);
  if (!payload.input || typeof payload.input !== 'object' || Array.isArray(payload.input)) {
    throw new ServiceError('INPUT_REQUIRED', 'Render input is required', 400);
  }
  if (!payload.project || typeof payload.project !== 'object' || Array.isArray(payload.project)) {
    throw new ServiceError('PROJECT_REQUIRED', 'Project metadata is required', 400);
  }
  const assets = Array.isArray(payload.project.assets) ? payload.project.assets : [];
  if (!assets.length || assets.length > 500) throw new ServiceError('ASSETS_INVALID', 'One to 500 assets are required', 400);
  return { template, assets };
}

export function createRenderService({ config = getProviderConfig(), logger = console, fetchImpl = fetch } = {}) {
  const jobs = new Map();
  const pendingUploads = new Map();
  const queue = [];
  const backgroundMusic = createBackgroundMusicLibrary(config);
  let activeJobs = 0;
  let closed = false;

  const lookupJob = (id, tenantKey) => {
    const job = jobs.get(id);
    if (!job || job.tenantKey !== tenantKey) throw new ServiceError('JOB_NOT_FOUND', 'Render job was not found', 404);
    return job;
  };

  const removeJobFiles = async (job) => {
    await Promise.all(Object.values(job.files || {}).map((file) => fs.rm(file.filePath, { force: true }).catch(() => {})));
  };

  const pumpQueue = () => {
    if (closed) return;
    while (activeJobs < config.service.queueConcurrency && queue.length) {
      const job = queue.shift();
      if (!job || job.status !== 'queued') continue;
      activeJobs += 1;
      void runJob(job).finally(() => {
        activeJobs -= 1;
        pumpQueue();
      });
    }
  };

  const runJob = async (job) => {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.stage = 'Preparing render';
    job.progress = Math.max(2, job.progress);
    job.controller = new AbortController();
    logEvent(logger, 'info', 'job.started', {
      job: job.id,
      tenant: shortId(job.tenantKey, 8),
      template: job.template,
      assets: job.project.assets.length,
      active: activeJobs,
      waiting: queue.filter((item) => item.status === 'queued').length,
    });
    logJobProgress(logger, job, { force: true });
    const timeout = setTimeout(() => {
      job.timedOut = true;
      logEvent(logger, 'warn', 'job.timeout', {
        job: job.id,
        tenant: shortId(job.tenantKey, 8),
        template: job.template,
        timeoutMs: config.service.jobTimeoutMs,
      });
      job.controller.abort();
    }, config.service.jobTimeoutMs);
    try {
      const result = await runWithRenderSignal(job.controller.signal, () => renderVideo(
        { id: job.id },
        { ...job.input, template: job.template },
        job.project,
        {
          onProgress: async (progress, stage) => {
            if (job.status !== 'running') return;
            const next = Math.max(job.progress, Math.min(95, Math.round(Number(progress) || 0)));
            job.progress = next;
            job.stage = String(stage || job.stage).slice(0, 180);
            logJobProgress(logger, job);
          },
        },
      ));
      if (job.cancelRequested || job.timedOut) {
        job.status = 'canceled';
        job.stage = job.timedOut ? 'Render timed out' : 'Render canceled';
        job.error = { code: job.timedOut ? 'RENDER_TIMEOUT' : 'RENDER_CANCELED', message: job.stage };
        logEvent(logger, 'warn', 'job.canceled', {
          job: job.id,
          tenant: shortId(job.tenantKey, 8),
          template: job.template,
          reason: job.stage,
          elapsedMs: elapsedMs(job),
        });
        return;
      }
      job.progress = Math.max(job.progress, 96);
      job.stage = 'Validating output';
      logJobProgress(logger, job);

      // Plan-only results describe work for another renderer (IMS) and have no
      // local file, so the hashing and download-URL steps do not apply. The
      // decisions themselves travel in the response payload.
      if (result.planOnly || !result.output?.storageKey) {
        job.files = {};
        job.publicResult = {
          provider: 'private-video-render-service',
          model: result.model || null,
          externalTaskId: job.id,
          output: {
            ...cleanOutput(result.output),
            planOnly: true,
            contentUrl: null,
            subtitleUrl: null,
          },
        };
        job.status = 'completed';
        job.progress = 100;
        job.stage = 'Plan completed';
        logJobProgress(logger, job);
        logEvent(logger, 'info', 'job.plan.completed', {
          job: job.id,
          tenant: shortId(job.tenantKey, 8),
          template: job.template,
          elapsedMs: elapsedMs(job),
          segments: result.output?.segmentCount ?? null,
        });
        return;
      }

      const outputPath = resolveStorageKey(result.output.storageKey);
      const videoHash = await hashFile(outputPath);
      const files = {
        video: {
          filePath: outputPath,
          filename: safeFilename(result.output.filename, 'output.mp4'),
          mimeType: 'video/mp4',
          ...videoHash,
        },
      };
      if (result.output.subtitleStorageKey) {
        const subtitlePath = resolveStorageKey(result.output.subtitleStorageKey);
        const subtitleHash = await hashFile(subtitlePath);
        files.subtitle = {
          filePath: subtitlePath,
          filename: safeFilename(result.output.subtitleFilename, 'subtitles.srt'),
          mimeType: String(result.output.subtitleFormat || '').toLowerCase() === 'ass'
            ? 'text/x-ass; charset=utf-8'
            : 'application/x-subrip; charset=utf-8',
          ...subtitleHash,
        };
      }
      job.files = files;
      job.publicResult = {
        provider: 'private-video-render-service',
        model: result.model || null,
        externalTaskId: job.id,
        output: {
          ...cleanOutput(result.output),
          filename: files.video.filename,
          sizeBytes: files.video.sizeBytes,
          sha256: files.video.sha256,
          contentUrl: `/v1/render-jobs/${job.id}/content`,
          subtitleFilename: files.subtitle?.filename || null,
          subtitleSha256: files.subtitle?.sha256 || null,
          subtitleUrl: files.subtitle ? `/v1/render-jobs/${job.id}/subtitles` : null,
        },
      };
      job.status = 'completed';
      job.progress = 100;
      job.stage = 'Render completed';
      logJobProgress(logger, job);
      logEvent(logger, 'info', 'job.completed', {
        job: job.id,
        tenant: shortId(job.tenantKey, 8),
        template: job.template,
        elapsedMs: elapsedMs(job),
        outputBytes: files.video.sizeBytes,
        subtitles: Boolean(files.subtitle),
      });
    } catch (error) {
      const canceled = job.cancelRequested || job.timedOut || error?.code === 'RENDER_CANCELED';
      job.status = canceled ? 'canceled' : 'failed';
      job.stage = job.timedOut ? 'Render timed out' : canceled ? 'Render canceled' : 'Render failed';
      job.error = {
        code: job.timedOut ? 'RENDER_TIMEOUT' : canceled ? 'RENDER_CANCELED' : 'RENDER_FAILED',
        message: job.stage,
      };
      logEvent(logger, canceled ? 'warn' : 'error', canceled ? 'job.canceled' : 'job.failed', {
        job: job.id,
        tenant: shortId(job.tenantKey, 8),
        template: job.template,
        code: error?.code || job.error.code,
        error: error?.message || job.stage,
        elapsedMs: elapsedMs(job),
      });
      await removeJobFiles(job);
    } finally {
      clearTimeout(timeout);
      job.completedAt = new Date().toISOString();
      job.controller = null;
      job.input = null;
      job.project = null;
    }
  };

  const prepareAsset = async (req, res, tenantKey) => {
    const payload = await readJson(req, config.service.maxJsonBytes);
    const sha256 = String(payload.sha256 || '').trim().toLowerCase();
    const sizeBytes = Number(payload.sizeBytes);
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new ServiceError('ASSET_HASH_INVALID', 'Asset SHA-256 is invalid', 400);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > config.storage.maxBytes) {
      throw new ServiceError('ASSET_SIZE_INVALID', 'Asset size is invalid', 400);
    }
    const assetId = `a_${sha256}`;
    const storageKey = assetStorageKey(tenantKey, assetId);
    const filePath = resolveStorageKey(storageKey);
    const stat = await fs.stat(filePath).catch(() => null);
    const exists = Boolean(stat?.isFile() && stat.size === sizeBytes);
    if (!exists) {
      pendingUploads.set(`${tenantKey}:${assetId}`, {
        assetId,
        sha256,
        sizeBytes,
        name: safeFilename(payload.name, 'asset.bin'),
        mimeType: String(payload.mimeType || 'application/octet-stream').slice(0, 100),
        expiresAt: Date.now() + 15 * 60_000,
      });
    }
    logEvent(logger, 'info', 'asset.prepared', {
      tenant: shortId(tenantKey, 8),
      asset: shortId(assetId),
      bytes: sizeBytes,
      cache: exists ? 'hit' : 'miss',
    });
    json(res, 200, {
      assetId,
      exists,
      uploadUrl: exists ? null : `/v1/assets/${assetId}/content`,
    });
  };

  const uploadAsset = async (req, res, tenantKey, assetId) => {
    const key = `${tenantKey}:${assetId}`;
    const pending = pendingUploads.get(key);
    if (!pending || pending.expiresAt < Date.now()) {
      pendingUploads.delete(key);
      throw new ServiceError('ASSET_PREPARE_REQUIRED', 'Prepare the asset before uploading it', 409);
    }
    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength !== pending.sizeBytes) {
      throw new ServiceError('ASSET_SIZE_MISMATCH', 'Asset size does not match prepare request', 400);
    }
    const storageKey = assetStorageKey(tenantKey, assetId);
    const destination = resolveStorageKey(storageKey);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    const hash = createHash('sha256');
    let sizeBytes = 0;
    const verifier = new Transform({
      transform(chunk, encoding, callback) {
        sizeBytes += chunk.length;
        if (sizeBytes > pending.sizeBytes || sizeBytes > config.storage.maxBytes) {
          callback(new ServiceError('ASSET_SIZE_MISMATCH', 'Uploaded asset is larger than expected', 400));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      logEvent(logger, 'info', 'asset.upload.started', {
        tenant: shortId(tenantKey, 8),
        asset: shortId(assetId),
        bytes: pending.sizeBytes,
      });
      await pipeline(req, verifier, createWriteStream(temporary, { flags: 'wx' }));
      const digest = hash.digest('hex');
      if (sizeBytes !== pending.sizeBytes || digest !== pending.sha256) {
        throw new ServiceError('ASSET_INTEGRITY_FAILED', 'Uploaded asset failed integrity verification', 400);
      }
      const existing = await fs.stat(destination).catch(() => null);
      if (existing?.isFile() && existing.size === sizeBytes) await fs.rm(temporary, { force: true });
      else {
        if (existing) await fs.rm(destination, { force: true });
        await fs.rename(temporary, destination);
      }
      pendingUploads.delete(key);
      logEvent(logger, 'info', 'asset.upload.completed', {
        tenant: shortId(tenantKey, 8),
        asset: shortId(assetId),
        bytes: sizeBytes,
      });
      json(res, 201, { assetId, sizeBytes, sha256: digest });
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  };

  /**
   * Import an asset the caller already stores elsewhere, streaming it straight to
   * disk.
   *
   * The main application runs on OSS, so it hands over a signed URL instead of
   * re-uploading bytes. That URL is short-lived and the object is large, so the
   * body must be streamed, never buffered.
   *
   * `sha256` is optional. When it is supplied the bytes are verified against it, as
   * with a normal upload. When it is omitted — which is the common case, because
   * the main application does not keep a digest for most assets — the service
   * computes the digest itself and uses it as the cache key, so a second import of
   * the same object still hits the cache. A `sha256` is therefore a verification
   * aid, not a requirement.
   *
   * Response contract (relied on by the main application's OSS sync path):
   *   201 { assetId, sha256, sizeBytes, exists: false }  freshly downloaded
   *   200 { assetId, sha256, sizeBytes, exists: true  }  already cached
   */
  const importAsset = async (req, res, tenantKey) => {
    const payload = await readJson(req, config.service.maxJsonBytes);
    // Validate the URL first: it is the one input that decides whether this
    // service will make an outbound request at all.
    assertImportUrl(payload.sourceUrl);
    const declaredHash = String(payload.sha256 || '').trim().toLowerCase();
    if (declaredHash && !/^[a-f0-9]{64}$/.test(declaredHash)) {
      throw new ServiceError('ASSET_HASH_INVALID', 'Asset SHA-256 is invalid', 400);
    }
    const declaredSize = Number(payload.sizeBytes);
    const hasSize = Number.isSafeInteger(declaredSize) && declaredSize > 0;
    if (payload.sizeBytes !== undefined && payload.sizeBytes !== null && !hasSize) {
      throw new ServiceError('ASSET_SIZE_INVALID', 'Asset size is invalid', 400);
    }
    if (hasSize && declaredSize > config.storage.maxBytes) {
      throw new ServiceError('ASSET_SIZE_INVALID', 'Asset size is invalid', 400);
    }

    // A cached copy is reused without touching the network, which is what makes a
    // re-run of the same project cheap. Without a declared digest there is nothing
    // to look up, so the download has to happen and the digest is learned from it.
    //
    // An object's etag is an equally good identity and the caller already holds it
    // from the same HEAD it uses for the size, so the mapping learned here is
    // remembered: a later call that supplies only the etag is answered from the cache
    // without downloading. Without this, a library is re-downloaded whenever the
    // caller has no digest for its objects.
    const declaredEtag = String(payload.etag || '').trim();
    const etagIndexFile = resolveStorageKey(`${tenantKey}/etag-index.json`);
    const readEtagIndex = async () => {
      try {
        return JSON.parse(await fs.readFile(etagIndexFile, 'utf8')) || {};
      } catch {
        return {};
      }
    };
    const rememberEtag = async (etag, digest) => {
      if (!etag || !digest) return;
      const index = await readEtagIndex();
      if (index[etag] === digest) return;
      index[etag] = digest;
      const temporary = `${etagIndexFile}.${process.pid}.tmp`;
      await fs.mkdir(path.dirname(etagIndexFile), { recursive: true }).catch(() => {});
      await fs.writeFile(temporary, JSON.stringify(index), 'utf8')
        .then(() => fs.rename(temporary, etagIndexFile))
        .catch(() => {});
    };

    if (!declaredHash && declaredEtag && hasSize) {
      const digest = (await readEtagIndex())[declaredEtag];
      if (digest) {
        const cachedPath = resolveStorageKey(assetStorageKey(tenantKey, `a_${digest}`));
        const cached = await fs.stat(cachedPath).catch(() => null);
        if (cached?.isFile() && cached.size === declaredSize) {
          logEvent(logger, 'info', 'asset.import.cached', {
            tenant: shortId(tenantKey, 8),
            asset: shortId(`a_${digest}`),
            bytes: declaredSize,
            via: 'etag',
          });
          json(res, 200, { assetId: `a_${digest}`, sha256: digest, sizeBytes: declaredSize, exists: true });
          return;
        }
      }
    }

    if (declaredHash && hasSize) {
      const cachedPath = resolveStorageKey(assetStorageKey(tenantKey, `a_${declaredHash}`));
      const cached = await fs.stat(cachedPath).catch(() => null);
      if (cached?.isFile() && cached.size === declaredSize) {
        const now = new Date();
        await fs.utimes(cachedPath, now, now).catch(() => {});
        logEvent(logger, 'info', 'asset.import.cached', {
          tenant: shortId(tenantKey, 8),
          asset: shortId(`a_${declaredHash}`),
          bytes: declaredSize,
        });
        json(res, 200, { assetId: `a_${declaredHash}`, sha256: declaredHash, sizeBytes: declaredSize, exists: true });
        return;
      }
    }

    // Stream to a staging path, since the final path is not known until the digest
    // is. Staging lives beside the assets directory so the move is a rename.
    const stagingDirectory = resolveStorageKey(`${tenantKey}/assets`);
    await fs.mkdir(stagingDirectory, { recursive: true });
    const temporary = path.join(stagingDirectory, `.import-${process.pid}-${randomUUID()}.tmp`);
    let received = 0;
    try {
      const response = await openImportedAsset(fetchImpl, payload.sourceUrl, AbortSignal.timeout(config.service.assetImportTimeoutMs));
      const hash = createHash('sha256');
      const limit = hasSize ? declaredSize : config.storage.maxBytes;
      const verifier = new Transform({
        transform(chunk, encoding, callback) {
          received += chunk.length;
          if (received > limit) {
            callback(new ServiceError('ASSET_SIZE_MISMATCH',
              hasSize ? 'Imported asset is larger than declared' : 'Imported asset exceeds the configured maximum size', 400));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      logEvent(logger, 'info', 'asset.import.started', {
        tenant: shortId(tenantKey, 8),
        bytes: hasSize ? declaredSize : undefined,
      });
      await pipeline(response.body, verifier, createWriteStream(temporary, { flags: 'wx' }));

      const digest = hash.digest('hex');
      if (declaredHash && digest !== declaredHash) {
        throw new ServiceError('ASSET_INTEGRITY_FAILED',
          `Imported asset failed integrity verification (got ${received} bytes / ${digest.slice(0, 12)})`, 400);
      }
      if (hasSize && received !== declaredSize) {
        throw new ServiceError('ASSET_INTEGRITY_FAILED',
          `Imported asset size mismatch (got ${received}, expected ${declaredSize})`, 400);
      }

      // The digest now decides the asset id, so the staging file becomes the cache
      // entry directly.
      const assetId = `a_${digest}`;
      // Remember the etag this content arrived with, so the next sync of the same
      // object is a lookup rather than another download.
      await rememberEtag(declaredEtag, digest);
      const destination = resolveStorageKey(assetStorageKey(tenantKey, assetId));
      const existing = await fs.stat(destination).catch(() => null);
      if (existing?.isFile() && existing.size === received) await fs.rm(temporary, { force: true });
      else {
        if (existing) await fs.rm(destination, { force: true });
        await fs.rename(temporary, destination);
      }
      logEvent(logger, 'info', 'asset.import.completed', {
        tenant: shortId(tenantKey, 8),
        asset: shortId(assetId),        bytes: received,
        verified: declaredHash ? 'declared' : 'computed',
      });
      json(res, 201, { assetId, sha256: digest, sizeBytes: received, exists: false });
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  };

  const createJob = async (req, res, tenantKey) => {
    const payload = await readJson(req, config.service.maxJsonBytes);
    const { template, assets } = validateJobPayload(payload);
    const mappedAssets = [];
    for (const reference of assets) {
      const originalId = String(reference?.id || '').trim();
      if (!originalId || originalId.length > 180) throw new ServiceError('ASSET_REFERENCE_INVALID', 'Asset reference id is invalid', 400);
      const remoteAssetId = String(reference.remoteAssetId || '').trim();
      const storageKey = assetStorageKey(tenantKey, remoteAssetId);
      const filePath = resolveStorageKey(storageKey);
      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat?.isFile()) throw new ServiceError('ASSET_NOT_READY', 'A referenced asset has not been uploaded', 409);
      mappedAssets.push(sanitizeAssetReference(reference, storageKey));
    }
    const jobId = `job_${randomUUID().replace(/-/g, '')}`;
    const projectHash = sha256Text(String(payload.project.id || 'project')).slice(0, 24);
    const input = { ...payload.input, template };
    delete input.videoSample;
    delete input.backgroundMusicPath;
    delete input.backgroundMusicName;
    const backgroundMusicId = String(input.backgroundMusicId || '').trim();
    if (backgroundMusicId) {
      if (!isBackgroundMusicId(backgroundMusicId)) {
        throw new ServiceError('BACKGROUND_MUSIC_ID_INVALID', 'Background music id is invalid', 400);
      }
      const selectedMusic = await backgroundMusic.resolve(backgroundMusicId);
      if (!selectedMusic) throw new ServiceError('BACKGROUND_MUSIC_NOT_FOUND', 'Selected background music is no longer available', 409);
      const volume = input.backgroundMusicVolume === undefined ? 0.18 : Number(input.backgroundMusicVolume);
      if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
        throw new ServiceError('BACKGROUND_MUSIC_VOLUME_INVALID', 'Background music volume must be between 0 and 1', 400);
      }
      input.backgroundMusicId = selectedMusic.id;
      input.backgroundMusicName = selectedMusic.name;
      input.backgroundMusicPath = selectedMusic.filePath;
      input.backgroundMusicVolume = Math.round(volume * 1000) / 1000;
    } else {
      delete input.backgroundMusicId;
      delete input.backgroundMusicVolume;
    }
    const history = Array.isArray(payload.project.outputs)
      ? payload.project.outputs.slice(0, 12).map((item) => ({
        id: String(item?.id || '').slice(0, 180),
        template: String(item?.template || '').slice(0, 80),
        autoMatchPlan: Array.isArray(item?.autoMatchPlan) ? item.autoMatchPlan.slice(0, 500) : null,
      }))
      : [];
    const job = {
      id: jobId,
      tenantKey,
      status: 'queued',
      progress: 1,
      stage: 'Queued',
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      error: null,
      publicResult: null,
      files: {},
      backgroundMusicId: input.backgroundMusicId || null,
      input,
      template,
      project: {
        id: `${tenantKey}-${projectHash}`,
        name: String(payload.project.name || 'video').slice(0, 180),
        assets: mappedAssets,
        outputs: history,
      },
    };
    jobs.set(jobId, job);
    queue.push(job);
    logEvent(logger, 'info', 'job.queued', {
      job: job.id,
      tenant: shortId(job.tenantKey, 8),
      template: job.template,
      assets: mappedAssets.length,
      waiting: queue.filter((item) => item.status === 'queued').length,
    });
    pumpQueue();
    json(res, 202, publicJob(job));
  };

  const cancelJob = async (res, job) => {
    if (TERMINAL_STATES.has(job.status)) {
      json(res, 200, publicJob(job));
      return;
    }
    job.cancelRequested = true;
    if (job.status === 'queued') {
      job.status = 'canceled';
      job.progress = 0;
      job.stage = 'Render canceled';
      job.completedAt = new Date().toISOString();
      job.error = { code: 'RENDER_CANCELED', message: job.stage };
      job.input = null;
      job.project = null;
      logEvent(logger, 'warn', 'job.canceled', {
        job: job.id,
        tenant: shortId(job.tenantKey, 8),
        template: job.template,
        reason: 'canceled while queued',
      });
    } else {
      logEvent(logger, 'warn', 'job.cancel.requested', {
        job: job.id,
        tenant: shortId(job.tenantKey, 8),
        template: job.template,
        progress: job.progress,
      });
      job.controller?.abort();
    }
    json(res, 202, publicJob(job));
  };

  const server = http.createServer(async (req, res) => {
    const requestStartedAt = Date.now();
    let requestPath = '';
    let requestTenantKey = '';
    let logRequest = false;
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.once('finish', () => {
      if (!logRequest) return;
      logEvent(logger, res.statusCode >= 400 ? 'warn' : 'info', 'http.request', {
        method: req.method,
        path: requestPath,
        status: res.statusCode,
        tenant: shortId(requestTenantKey, 8),
        elapsedMs: Date.now() - requestStartedAt,
      });
    });
    try {
      const url = new URL(req.url || '/', 'http://render-service.local');
      requestPath = url.pathname;
      logRequest = ['POST', 'PUT', 'DELETE'].includes(req.method || '');
      if (url.pathname === '/health' && req.method === 'GET') {
        const ffmpegReady = config.media.enabled && commandAvailable(config.media.ffmpegPath);
        const ffprobeReady = config.media.enabled && commandAvailable(config.media.ffprobePath);
        json(res, ffmpegReady && ffprobeReady ? 200 : 503, {
          status: ffmpegReady && ffprobeReady ? 'ready' : 'unavailable',
          queue: { active: activeJobs, waiting: queue.filter((item) => item.status === 'queued').length },
        });
        return;
      }
      if (!isAuthorized(req, config.service.apiKeys)) throw new ServiceError('UNAUTHORIZED', 'Valid service credentials are required', 401);
      const tenantKey = tenantIdentity(req);
      requestTenantKey = tenantKey;
      if (url.pathname === '/v1/background-music' && req.method === 'GET') {
        json(res, 200, { items: await backgroundMusic.list() });
        return;
      }
      if (url.pathname === '/v1/background-music' && req.method === 'POST') {
        let name = String(req.headers['x-background-music-name'] || 'background-music.mp3');
        try { name = decodeURIComponent(name); } catch {}
        const result = await backgroundMusic.upload(req, {
          name,
          mimeType: String(req.headers['content-type'] || 'application/octet-stream').split(';')[0],
          declaredLength: req.headers['content-length'],
        });
        logEvent(logger, 'info', result.created ? 'background-music.uploaded' : 'background-music.reused', {
          music: shortId(result.music.id),
          bytes: result.music.sizeBytes,
          durationSeconds: result.music.durationSeconds,
        });
        json(res, result.created ? 201 : 200, result.music);
        return;
      }
      const backgroundMusicMatch = url.pathname.match(/^\/v1\/background-music\/(bgm_[a-f0-9]{32})(?:\/(content))?$/);
      if (backgroundMusicMatch) {
        const record = await backgroundMusic.resolve(backgroundMusicMatch[1]);
        if (!record) throw new ServiceError('BACKGROUND_MUSIC_NOT_FOUND', 'Background music was not found', 404);
        if (backgroundMusicMatch[2] && (req.method === 'GET' || req.method === 'HEAD')) {
          await serveFile(req, res, {
            filePath: record.filePath,
            filename: record.name,
            mimeType: record.mimeType,
            sizeBytes: record.sizeBytes,
            sha256: record.sha256,
          });
          return;
        }
        if (!backgroundMusicMatch[2] && req.method === 'DELETE') {
          const removed = await backgroundMusic.remove(record.id, {
            isInUse: (id) => [...jobs.values()].some((job) => job.backgroundMusicId === id && !TERMINAL_STATES.has(job.status)),
          });
          logEvent(logger, 'info', 'background-music.deleted', { music: shortId(removed.id), bytes: removed.sizeBytes });
          json(res, 200, removed);
          return;
        }
      }
      if (url.pathname === '/v1/assets/prepare' && req.method === 'POST') {
        await prepareAsset(req, res, tenantKey);
        return;
      }
      // The main application stores assets in OSS and hands over a signed URL
      // rather than re-uploading them; without this route its OSS sync path fails
      // with a 404 before any render can start.
      if (url.pathname === '/v1/assets/import' && req.method === 'POST') {
        await importAsset(req, res, tenantKey);
        return;
      }
      const assetMatch = url.pathname.match(/^\/v1\/assets\/(a_[a-f0-9]{64})\/content$/);
      if (assetMatch && req.method === 'PUT') {
        await uploadAsset(req, res, tenantKey, assetMatch[1]);
        return;
      }
      if (url.pathname === '/v1/render-jobs' && req.method === 'POST') {
        await createJob(req, res, tenantKey);
        return;
      }
      const jobMatch = url.pathname.match(/^\/v1\/render-jobs\/(job_[a-f0-9]{32})(?:\/(content|subtitles))?$/);
      if (jobMatch) {
        const job = lookupJob(jobMatch[1], tenantKey);
        if (!jobMatch[2] && req.method === 'GET') {
          json(res, 200, publicJob(job));
          return;
        }
        if (!jobMatch[2] && req.method === 'DELETE') {
          await cancelJob(res, job);
          return;
        }
        if (job.status !== 'completed') throw new ServiceError('RESULT_NOT_READY', 'Render result is not ready', 409);
        const file = jobMatch[2] === 'subtitles' ? job.files.subtitle : job.files.video;
        if (!file) throw new ServiceError('RESULT_NOT_FOUND', 'Requested render result was not found', 404);
        if (req.method === 'GET' || req.method === 'HEAD') {
          await serveFile(req, res, file);
          return;
        }
      }
      throw new ServiceError('NOT_FOUND', 'Endpoint was not found', 404);
    } catch (error) {
      const output = publicError(error);
      logEvent(logger, output.status >= 500 ? 'error' : 'warn', 'http.error', {
        method: req.method,
        path: requestPath || req.url,
        status: output.status,
        code: output.code,
        error: error?.message || output.message,
        tenant: shortId(requestTenantKey, 8),
        elapsedMs: Date.now() - requestStartedAt,
      });
      if (!res.headersSent) json(res, output.status, { error: { code: output.code, message: output.message } });
      else res.destroy();
    }
  });

  const cleanup = setInterval(() => {
    const cutoff = Date.now() - config.service.completedJobTtlMs;
    for (const [id, job] of jobs) {
      if (!TERMINAL_STATES.has(job.status) || Date.parse(job.completedAt || '') >= cutoff) continue;
      jobs.delete(id);
      void removeJobFiles(job);
    }
    for (const [key, pending] of pendingUploads) {
      if (pending.expiresAt < Date.now()) pendingUploads.delete(key);
    }
  }, Math.min(config.service.completedJobTtlMs, 10 * 60_000));
  cleanup.unref();

  server.once('close', () => {
    closed = true;
    clearInterval(cleanup);
    for (const job of jobs.values()) job.controller?.abort();
  });
  return server;
}
