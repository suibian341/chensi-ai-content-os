import { ProviderError } from '../lib/http.js';
import { imsSubmitMediaProducingJob, imsGetMediaProducingJob, isMediaNotReady } from '../lib/ims.js';
import { prepareGeneratedFile, commitPreparedFile, registerExistingObject, signedReadUrl, storageMode } from '../lib/storage.js';
import { getProviderConfig } from './config.js';
import { fetchAssetMeta, mapAssets, syncAsset } from './remote-video.js';
import { burnSubtitlesOnVideo } from './video-subtitles.js';
import { narrationTimingFor } from './video-transcript.js';
import { serviceJson, sleep, tenantId } from './render-service-client.js';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Mirrors MEDIA_ID_TOKEN_PREFIX in the render service's vlog-plan.js. */
const MEDIA_ID_TOKEN_PREFIX = 'chensi-media-id:';

/**
 * How many assets to register at once.
 *
 * Small on purpose: this host has 2 vCPU, and each task is a HEAD plus a light import
 * call, so the win is in removing the serialisation rather than in maximum fan-out.
 */
const ASSET_SYNC_CONCURRENCY = 6;

/** Opt-in switch; see the note at the subtitle step. Off unless explicitly enabled. */
function boolSetting(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

/**
 * The storageKey the private service will resolve for an already-imported asset.
 *
 * `findSource` only considers an asset when `storageKey` is set, and then stats
 * that exact path, so the value has to match what the service's own `createJob`
 * computes. That is `${hashedTenant}/assets/<sha256>.bin`, where the tenant is
 * SHA-256'd and truncated to 32 hex characters (see `tenantIdentity`), and the file
 * name comes from the asset id the import returned.
 *
 * The digest is used rather than the asset id verbatim so a malformed id cannot
 * escape the tenant directory.
 */
export function cachedStorageKey(tenant, remoteAssetId) {
  const digest = String(remoteAssetId || '').match(/^a_([a-f0-9]{64})$/);
  if (!digest || !tenant) return null;
  const tenantKey = createHash('sha256').update(tenant, 'utf8').digest('hex').slice(0, 32);
  return `${tenantKey}/assets/${digest[1]}.bin`;
}

function planAssetReference(asset, synced, tenant) {
  return {
    id: asset.id,
    // The service keys its cached file by this id (`assetStorageKey`), so it has to
    // travel with the reference — without it the request is rejected as an invalid
    // asset id before any planning happens.
    remoteAssetId: synced.reference?.remoteAssetId || null,
    storageKey: cachedStorageKey(tenant, synced.reference?.remoteAssetId),
    name: asset.name,
    // Already known here, so the planner can build the shot timeline without
    // measuring every file: it only needs durations, not the media.
    durationSeconds: Number(asset.durationSeconds) > 0 ? Number(asset.durationSeconds) : undefined,
    mimeType: asset.mimeType,
    kind: asset.kind,
    tags: asset.tags,
    description: asset.description,
    autoEditCategory: asset.autoEditCategory,
    category: asset.category,
    highlightScore: asset.highlightScore,
    createdAt: asset.createdAt,
  };
}

function assertSupportedImsInput(input) {
  const template = String(input?.template || 'vlog').trim() || 'vlog';
  if (template !== 'vlog') {
    throw new ProviderError(
      'IMS_TEMPLATE_UNSUPPORTED',
      'IMS 当前只执行 Vlog 时间线；口播去气口和字幕继续走原智能剪辑服务',
      { status: 409, retryable: false },
    );
  }
}

/**
 * True when an asset is an output of this same auto-edit pipeline.
 *
 * Deliberately narrower than `isGeneratedAsset`: a digital-human render is also
 * "generated" and is a perfectly valid main video for a vlog, so excluding every
 * generated asset would remove the narration the whole plan is built on. What must
 * never be an input is an earlier *auto-edit* result — the algorithm refuses that
 * itself ("自动剪辑成片不能再次作为主视频"), and a multi-gigabyte render among the
 * candidates is also what made the import fail with `ASSET_SIZE_INVALID`.
 *
 * Mirrors `isAutoEditOutputAsset` in the render service.
 */
function isAutoEditOutput(asset, outputs) {
  if (!asset) return false;
  const linkedOutput = (Array.isArray(outputs) ? outputs : [])
    .find((output) => String(output?.id || '') === String(asset?.sourceOutputId || ''));
  return linkedOutput?.template === 'vlog'
    || /(?:^|[-_\s])auto[-_\s]?edit(?:\.|[-_\s]|$)/i.test(String(asset?.name || ''))
    || (Array.isArray(asset?.tags) && asset.tags.some((tag) => /自动剪辑|auto[-_\s]?edit/i.test(String(tag))));
}

/**
 * The project's videos that may take part in a plan.
 *
 * This is the same material the local renderer would consider for a vlog: every
 * real video, minus earlier auto-edit results.
 */
export function planEligibleAssets(project) {
  const outputs = Array.isArray(project?.outputs) ? project.outputs : [];
  return (Array.isArray(project?.assets) ? project.assets : [])
    .filter((asset) => asset?.storageKey
      && String(asset.mimeType || '').startsWith('video/')
      && !isAutoEditOutput(asset, outputs));
}

/**
 * The project's outputs, reduced to the fields the plan request needs.
 *
 * Not truncated: the narration timing is discovered by matching an output to the
 * main video, so dropping entries can lose the one that carries the subtitle. The
 * heavy field (`autoMatchPlan`) is removed instead, which is what kept the request
 * small before.
 */
function projectOutputsForPlan(project) {
  const outputs = Array.isArray(project?.outputs) ? project.outputs : [];
  return outputs.map((output) => {
    const { autoMatchPlan, ...rest } = output || {};
    void autoMatchPlan;
    return rest;
  });
}

/**
 * Ask the private render service to *decide* the edit and compile an IMS
 * Timeline, without rendering anything.
 *
 * This is the whole point of the IMS backend: the semantic auto-editor (word
 * timing, shot boundaries, transitions, b-roll matching) is the product's own
 * algorithm, so its owner executes it rather than this process reimplementing it.
 * The service renders nothing for this request; IMS supplies the compute.
 */
export async function fetchEditPlan(task, input, project, options = {}) {
  const config = getProviderConfig().videoRenderService;
  if (!config.url || !config.apiKey) {
    throw new ProviderError('VIDEO_RENDER_SERVICE_NOT_CONFIGURED', '私有剪辑服务尚未完整配置', { status: 503 });
  }
  const tenant = tenantId(task, project);
  if (!tenant) throw new ProviderError('VIDEO_RENDER_TENANT_REQUIRED', '无法确定剪辑任务所属账号', { status: 400 });
  const signal = options.signal;

  // Syncing registers the media and, in OSS mode, caches it on the service; it
  // does not re-upload the bytes. The plan needs real files because the decision
  // set depends on probing duration and on speech timing.
  const projectAssets = planEligibleAssets(project);
  if (!projectAssets.length) {
    throw new ProviderError('VIDEO_ASSET_REQUIRED', '请先选择已经上传的视频素材', { status: 400 });
  }

  // Registering the library used to be a serial loop with two network round trips per
  // asset (one HEAD for its object metadata, one import call) — for ~200 assets that
  // is ~400 sequential requests, which is why a plan sat at the "matching" stage for
  // minutes. It is fanned out with a small bound, and the metadata is fetched once and
  // handed to the sync so the HEAD is not repeated.
  await options.onProgress?.(7, `正在登记素材（${projectAssets.length} 个）`);
  const synced = await mapAssets(
    projectAssets,
    ASSET_SYNC_CONCURRENCY,
    async (asset) => {
      const meta = await fetchAssetMeta(asset).catch(() => null);
      return syncAsset(config, tenant, asset, signal, meta);
    },
  );
  const references = projectAssets.map((asset, index) => planAssetReference(asset, synced[index], tenant));
  if (!references.length) {
    throw new ProviderError('VIDEO_ASSET_REQUIRED', '请先选择已经上传的视频素材', { status: 400 });
  }

  // Narration timing, reused when it already exists.
  //
  // Recognition is deliberately NOT run here: this host has 2 vCPU and 1.87 GB and
  // must keep serving the API and the web UI, while the render service transcribes
  // the same video in 36 s on 8 vCPU. Instead the timing is looked up — a
  // digital-human render stores its subtitle alongside the video, already aligned to
  // the speech at generation time, so for the common case there is nothing to compute.
  //
  // What this buys, beyond the 36 s: the planner then needs no media at all, so the
  // main video is not even fetched to the render service.
  const planInput = { ...input, template: 'vlog' };
  const timing = await narrationTimingFor(
    projectAssets.find((asset) => String(asset.id) === String(input.videoAssetId || input.videoAssetIds?.[0] || '')),
    project,
    input,
  );
  if (timing) {
    if (Array.isArray(timing.words) && timing.words.length) {
      planInput.transcriptWords = timing.words;
      await options.onProgress?.(14, `口播时间轴已复用（${timing.words.length} 段，来源：${timing.source}）`);
    }
    if (timing.text) planInput.transcriptText = timing.text;
    planInput.transcriptSource = timing.source;
  }

  // `vlog-plan` selects the plan-only renderer; `input.template` stays `vlog`
  // because that is what the algorithm branches on.
  const requestBody = JSON.stringify({
    template: 'vlog-plan',
    input: planInput,
    // `outputs` travels with the request: the algorithm uses it to refuse an
    // earlier auto-edit result as a source, and the narration timing is looked up
    // through it, so the reference entries must not be truncated.
    project: {
      id: project.id,
      name: project.name,
      assets: references,
      outputs: projectOutputsForPlan(project),
    },
  });

  const submitPlan = async () => {
    const created = await serviceJson(config, tenant, '/v1/render-jobs', {
      method: 'POST',
      timeoutMs: config.timeoutMs,
      signal,
      body: requestBody,
    });
    const id = created?.id;
    if (!id) throw new ProviderError('VIDEO_RENDER_SERVICE_INVALID_RESPONSE', '剪辑服务没有返回方案任务号', { retryable: true });
    return { id, created };
  };

  const pollPlan = async (id, created) => {
    const abort = () => {
      void serviceJson(config, tenant, `/v1/render-jobs/${encodeURIComponent(id)}`, { method: 'DELETE', timeoutMs: 10_000 }).catch(() => {});
    };
    signal?.addEventListener('abort', abort, { once: true });
    const deadline = Date.now() + config.timeoutMs;
    let state = created;
    let lastStage = '';
    while (!['completed', 'failed', 'canceled'].includes(String(state.status))) {
      if (signal?.aborted) {
        abort();
        throw signal.reason || new Error('Task canceled');
      }
      if (Date.now() >= deadline) {
        abort();
        throw new ProviderError('VIDEO_RENDER_SERVICE_TIMEOUT', '剪辑服务生成剪辑方案超时', { retryable: true });
      }
      await sleep(config.pollIntervalMs, signal);
      state = await serviceJson(config, tenant, `/v1/render-jobs/${encodeURIComponent(id)}`, { signal });
      const stage = state.stage || '正在生成剪辑方案';
      if (stage !== lastStage) {
        lastStage = stage;
        await options.onProgress?.(Math.min(40, Math.max(8, Number(state.progress) || 8)), stage);
      }
    }
    return state;
  };

  // A plan job is only ever missing because the service process restarted: the job
  // table is in memory (`const jobs = new Map()` in server.js), so a deploy, a crash or
  // an OOM mid-plan turns a job that was running a second ago into a 404. The service
  // log shows exactly that shape — `service.stopping`, `service.ready`, then
  // JOB_NOT_FOUND for the job that was in flight. Failing the whole video for it is
  // wrong: the plan is a pure function of the same inputs and takes seconds, while the
  // user has already waited minutes. Retry once, and say why.
  const PLAN_ATTEMPTS = 2;
  let jobId = null;
  let remote = null;
  for (let attempt = 1; attempt <= PLAN_ATTEMPTS; attempt += 1) {
    try {
      const submitted = await submitPlan();
      jobId = submitted.id;
      remote = await pollPlan(jobId, submitted.created);
      break;
    } catch (error) {
      if (error?.code !== 'JOB_NOT_FOUND' || attempt >= PLAN_ATTEMPTS) throw error;
      await options.onProgress?.(9, '剪辑服务刚刚重启，正在重新生成剪辑方案');
    }
  }

  if (remote.status !== 'completed' || !remote.result?.output?.imsTimeline) {
    throw new ProviderError(
      remote.error?.code || 'VIDEO_RENDER_PLAN_FAILED',
      remote.error?.message || '剪辑服务未能生成自动匹配方案',
      { retryable: remote.status === 'canceled', details: remote.error || null },
    );
  }
  return { jobId, output: remote.result.output };
}

/**
 * Swap every `chensi-media-id:<assetId>` placeholder in a compiled Timeline for a
 * URL IMS can fetch (an OSS-native signed URL in production).
 *
 * A pure substitution: the Timeline the algorithm compiled is used as-is, so no
 * cut point, transition or canvas value is recomputed here. Values that are not
 * tokens pass through untouched.
 */
export function resolveTimelineTokens(timeline, urlByAssetId, tokenPrefix) {
  const seen = new Set();
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [key, item] of Object.entries(value)) out[key] = walk(item);
      return out;
    }
    if (typeof value !== 'string' || !tokenPrefix || !value.startsWith(tokenPrefix)) return value;
    const assetId = value.slice(tokenPrefix.length);
    const url = urlByAssetId.get(assetId);
    if (!url) {
      throw new ProviderError('IMS_TIMELINE_ASSET_UNRESOLVED',
        `时间线引用了没有可访问地址的素材：${assetId}`, { status: 502 });
    }
    seen.add(assetId);
    return url;
  };
  const resolved = walk(timeline);
  return { timeline: dropTrailingTransition(resolved), replacedAssetIds: [...seen] };
}

/**
 * Remove a transition from the final clip.
 *
 * The compiler stamps every plan entry with its own transition, and the private
 * ffmpeg renderer only ever consumes the transitions of `specs[1..]` — a leading
 * and a trailing one are both ignored (`boundaries = specs.slice(1)` in
 * concatSegmentsWithTransitions). IMS instead applies a transition to the clip
 * that carries it, and a last clip with nothing to transition into is rejected
 * with an invalid-timeline error (verified against the live service).
 *
 * Dropping it here reproduces what the local renderer already does, so the two
 * backends agree on the finished cut. Only the `Effects` array is touched; no
 * timing, ordering or canvas value is recomputed.
 */
function dropTrailingTransition(timeline) {
  const clips = timeline?.VideoTracks?.[0]?.VideoTrackClips;
  if (!Array.isArray(clips) || !clips.length) return timeline;
  const last = clips[clips.length - 1];
  if (!Array.isArray(last?.Effects) || !last.Effects.length) return timeline;
  const { Effects, ...rest } = last;
  return {
    ...timeline,
    VideoTracks: [
      { ...timeline.VideoTracks[0], VideoTrackClips: [...clips.slice(0, -1), rest] },
      ...timeline.VideoTracks.slice(1),
    ],
  };
}

/** Every asset id the compiled Timeline cites, across all tracks. */
export function collectTokenAssetIds(timeline, tokenPrefix) {
  const ids = new Set();
  const walk = (value) => {
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    if (value && typeof value === 'object') { for (const item of Object.values(value)) walk(item); return; }
    if (typeof value === 'string' && tokenPrefix && value.startsWith(tokenPrefix)) {
      ids.add(value.slice(tokenPrefix.length));
    }
  };
  walk(timeline);
  return ids;
}

/** Does the Timeline reference this asset id, by token or by bare media URL? */
export function timelineReferences(timeline, assetId) {
  const id = String(assetId);
  const walk = (value) => {
    if (Array.isArray(value)) return value.some(walk);
    if (value && typeof value === 'object') return Object.values(value).some(walk);
    return typeof value === 'string' && value.endsWith(`:${id}`);
  };
  return walk(timeline);
}

/** The same Timeline with its subtitle track removed, for the retry described above. */
export function stripSubtitleTracks(timeline) {
  if (!Array.isArray(timeline?.SubtitleTracks) || !timeline.SubtitleTracks.length) return timeline;
  const { SubtitleTracks, ...rest } = timeline;
  void SubtitleTracks;
  return rest;
}

/**
 * Is this failure the subtitle track's fault?
 *
 * Only asked when a subtitle track was actually attached, so a broad match is safe: the
 * caller reacts by re-rendering the same cut without subtitles, and if that also fails the
 * original error is what surfaces.
 */
export function isSubtitleRejection(error) {
  const text = `${error?.code || ''} ${error?.message || ''}`.toLowerCase();
  return text.includes('subtitle') || text.includes('not supported');
}

/**
 * Store the plan's subtitle file and point the Timeline's placeholder at it.
 *
 * This is the delivery package's mechanism, kept intact: the ASS is produced by the
 * subtitle engine, uploaded to OSS, and referenced from a `SubtitleTrackClip` through
 * `FileURL`. What differs is only who does the storing — the plan-only path carries a
 * `chensi-subtitle-file:` placeholder because the render service holds no OSS credentials,
 * so this process writes the object and swaps the placeholder for a link, exactly as it
 * already does for media urls.
 *
 * The link form is the caller's choice and both are supported, because the delivery
 * package's choice does not survive contact with a private bucket (measured, not assumed):
 *
 *   bare    the package's own behaviour — `putText` returns `${host}/${key}` with no
 *           signature. IMS cannot fetch that from a private bucket (anonymous GET is 403),
 *           and I confirmed it draws nothing even when the object IS made public-read.
 *   signed  the correct form for a private bucket. IMS accepts the submit and then fails
 *           the render with `…SubtitleConfig:ExtSubtitleList:ExtSubtitle:Input:Object is
 *           not supported`.
 *
 * `bare` is the default so that video generation cannot be taken down by a subtitle
 * problem; `signed` exists to reproduce the hard failure on demand for the Aliyun ticket.
 */
async function attachSubtitle({ root, task, project, planOutput, timeline }) {
  const plan = planOutput?.subtitle;
  const token = String(planOutput?.subtitleFileUrlToken || plan?.fileUrlToken || '').trim();
  if (!plan?.content || !token) {
    return { attached: false, error: planOutput?.subtitleError || null, storageKey: null, filename: null };
  }

  const prepared = await prepareGeneratedFile({
    userId: project.ownerId,
    projectId: project.id,
    taskId: `${task.id}-subtitles`,
    name: plan.filename || 'subtitles.ass',
  });
  try {
    // BOM kept: the local subtitle engine writes one so Windows players and NLEs do not
    // guess the system code page when opening a Chinese ASS file.
    await fs.writeFile(prepared.filePath, `\ufeff${plan.content}`, 'utf8');
    const stored = await commitPreparedFile(prepared, { mimeType: 'text/plain; charset=utf-8' });
    const mode = String(root.videoRenderService.ims.subtitleUrlMode || 'bare').toLowerCase();
    const url = mode === 'signed'
      ? signedReadUrl({ storageKey: stored.storageKey, name: stored.filename }, { preferOss: true })
      : `https://${storageHost(root)}/${String(stored.storageKey).split('/').map(encodeURIComponent).join('/')}`;
    const walk = (value) => {
      if (Array.isArray(value)) return value.map(walk);
      if (value && typeof value === 'object') {
        const out = {};
        for (const [key, item] of Object.entries(value)) out[key] = walk(item);
        return out;
      }
      return value === token ? url : value;
    };
    return {
      attached: true,
      error: null,
      storageKey: stored.storageKey,
      filename: stored.filename,
      urlMode: mode,
      timeline: walk(timeline),
    };
  } finally {
    if (prepared.temporaryDirectory) await fs.rm(prepared.temporaryDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

function storageHost(config) {
  const location = String(config.videoRenderService.ims.storageLocation || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (location) return location;
  return `${config.storage.oss.bucket}.oss-${String(config.storage.oss.region || '').replace(/^oss-/, '')}.aliyuncs.com`;
}

function outputUrlFor(prepared, root) {
  const host = storageHost(root);
  const key = prepared.storageKey.split('/').map(encodeURIComponent).join('/');
  return `https://${host}/${key}`;
}

/**
 * Render a Vlog on Aliyun IMS.
 *
 * The edit is decided by the private render service (see `fetchEditPlan`); this
 * function only carries that decision out: sign a URL per cited asset, substitute
 * those into the compiled Timeline, submit, poll, and file the result back into
 * project storage. It never chooses a cut or a transition.
 */
/**
 * The narration the subtitles should follow.
 *
 * A real UI submission usually leaves the subtitle box empty, so the text has to be
 * recovered in order of reliability: what the caller supplied, then what the plan
 * reported (which is what the algorithm segmented on), then the plan's own segment
 * texts. Falling back to the segments matters because the burn step needs *some*
 * text — without it there is nothing to draw and the render would fail at the very
 * end, after the cloud job had already been paid for.
 */
export function narrationTextFor(input, planOutput) {
  const supplied = String(input.subtitleText || '').trim();
  if (supplied) return supplied;
  const fromPlan = [planOutput.subtitleText, planOutput.transcriptText]
    .map((value) => String(value || '').trim())
    .find(Boolean);
  if (fromPlan) return fromPlan;
  const segments = Array.isArray(planOutput.autoMatchPlan) ? planOutput.autoMatchPlan : [];
  return segments
    .map((item) => String(item?.segmentText || item?.text || '').trim())
    .filter(Boolean)
    .join('');
}

export async function renderImsVideo(task, input = {}, project, options = {}) {
  const root = getProviderConfig();
  const config = root.videoRenderService;
  const ims = config.ims;
  if (storageMode() !== 'oss') throw new ProviderError('IMS_REQUIRES_OSS', 'IMS 后端需要 OSS 对象存储', { status: 409 });
  if (!ims.enabled) throw new ProviderError('IMS_NOT_CONFIGURED', 'IMS 凭据尚未配置', { status: 503 });
  assertSupportedImsInput(input);
  const signal = options.signal;

  // Step 1 — the product's own algorithm decides the edit and compiles a Timeline.
  await options.onProgress?.(6, '正在生成自动匹配方案');
  const plan = await fetchEditPlan(task, input, project, { signal, onProgress: options.onProgress });
  const planOutput = plan.output;
  const tokenPrefix = planOutput.mediaIdTokenPrefix || MEDIA_ID_TOKEN_PREFIX;
  const imsTimeline = planOutput.imsTimeline;
  const clips = imsTimeline?.VideoTracks?.[0]?.VideoTrackClips;
  if (!Array.isArray(clips) || !clips.length) {
    throw new ProviderError('IMS_TIMELINE_EMPTY', '剪辑方案没有生成任何片段', { status: 409 });
  }

  // Only the assets the compiled Timeline actually cites are signed.
  const eligibleAssets = planEligibleAssets(project);
  const neededIds = collectTokenAssetIds(imsTimeline, tokenPrefix);
  const assets = eligibleAssets.filter((asset) => (neededIds.size
    ? neededIds.has(String(asset.id))
    : timelineReferences(imsTimeline, asset.id)));
  if (!assets.length) {
    throw new ProviderError('IMS_TIMELINE_ASSET_UNRESOLVED', '剪辑方案引用的素材不在本项目里', { status: 502 });
  }

  // Step 2 — sign a URL per cited asset and put it straight into the Timeline.
  //
  // The Assets API is deliberately not used: `RegisterMediaInfo` accepts a signed
  // URL but the renderer then rejects the resulting MediaId with
  // `InvalidUrlPrefix`, because the signature parameters travel into the media
  // record and break the URL the service reconstructs. Signed URLs in the Timeline
  // render successfully (measured), and generating them here rather than in the
  // render service means they are always fresh at submit time.
  const urlByAssetId = new Map();
  for (const asset of assets) {
    const url = signedReadUrl(asset, { preferOss: true });
    if (!url) throw new ProviderError('IMS_INPUT_URL_UNAVAILABLE', `无法为素材签名：${asset.name || asset.id}`, { status: 409 });
    urlByAssetId.set(String(asset.id), url);
  }
  await options.onProgress?.(46, `素材地址已签名（${assets.length} 个）`);

  // Step 3 — substitute the signed URLs into the compiled Timeline. No editing
  // decision is taken after this point.
  const { timeline: mediaResolved } = resolveTimelineTokens(imsTimeline, urlByAssetId, tokenPrefix);

  // Step 3b — the plan's subtitle file: store it, then point the Timeline's placeholder at
  // it. Nothing about the cut changes here, and a subtitle that cannot be attached leaves
  // the render alone.
  const attached = await attachSubtitle({
    root, task, project, planOutput, timeline: mediaResolved,
  }).catch((error) => ({ attached: false, error: `字幕落盘失败：${error?.message || error}`, storageKey: null, filename: null }));
  const subtitleTrack = { ...attached, timeline: undefined };
  const timeline = attached.timeline || mediaResolved;
  if (attached.attached) await options.onProgress?.(47, `字幕已挂到时间线（${attached.urlMode}）`);
  else if (attached.error) await options.onProgress?.(47, `字幕未接入：${attached.error}`);

  const prepared = await prepareGeneratedFile({
    userId: project.ownerId,
    projectId: project.id,
    taskId: task.id,
    name: `${input.title || project.name || 'video'}-${input.template || 'vlog'}-ims.mp4`,
  });
  try {
    const outputUrl = outputUrlFor(prepared, root);

    /**
     * Submit one timeline and wait for it.
     *
     * Pulled into a closure because a subtitle track can make IMS reject the job during
     * the render (it accepts the submit, then fails with a `…SubtitleConfig… not
     * supported` message), and the right response there is to render the same cut without
     * subtitles rather than to fail the user's video.
     */
    const runJob = async (timelineToRender) => {
      const submit = await imsSubmitMediaProducingJob(ims, {
        RegionId: ims.region,
        Timeline: JSON.stringify(timelineToRender),
        OutputMediaTarget: 'OSS',
        OutputMediaConfig: JSON.stringify({ MediaURL: outputUrl }),
      }, { timeoutMs: 60_000, signal });
      const id = submit?.JobId;
      if (!id) throw new ProviderError('IMS_INVALID_JOB', 'IMS 没有返回任务号', { retryable: true, details: submit });
      await options.onExternalTaskId?.(id, 'aliyun-ims');

      const deadline = Date.now() + ims.timeoutMs;
      let state = submit.MediaProducingJob || submit;
      while (true) {
        const status = String(state.Status || state.JobStatus || '').toLowerCase();
        if (['success', 'succeeded', 'finished', 'finish', 'completed'].includes(status)) break;
        if (['failed', 'error', 'canceled', 'cancelled'].includes(status) && !isMediaNotReady(state)) {
          throw new ProviderError('IMS_RENDER_FAILED', state.Message || 'IMS 渲染失败', { details: state });
        }
        if (Date.now() >= deadline) {
          throw new ProviderError('IMS_TIMEOUT', 'IMS 渲染超时', { retryable: true, details: { jobId: id } });
        }
        const elapsed = ims.timeoutMs - (deadline - Date.now());
        await options.onProgress?.(
          Math.min(94, 48 + Math.floor((elapsed / ims.timeoutMs) * 46)),
          isMediaNotReady(state) ? 'IMS 正在等待素材就绪' : 'IMS 正在渲染',
        );
        await sleep(ims.pollIntervalMs, signal);
        try {
          state = (await imsGetMediaProducingJob(ims, id, { timeoutMs: 60_000, signal })).MediaProducingJob || {};
        } catch (error) {
          if (isMediaNotReady(error)) continue;
          throw error;
        }
      }
      return id;
    };

    let jobId;
    try {
      jobId = await runJob(timeline);
    } catch (error) {
      if (!subtitleTrack.attached || !isSubtitleRejection(error)) throw error;
      // The cut is the deliverable; the subtitle is an extra. Drop only the subtitle track
      // and render the identical edit again, recording why so the failure is visible in
      // the result instead of only in a log line.
      await options.onProgress?.(48, 'IMS 不接受字幕轨，正在改为不带字幕重渲');
      jobId = await runJob(stripSubtitleTracks(timeline));
      subtitleTrack.attached = false;
      subtitleTrack.error = `IMS 拒绝字幕轨：${error?.message || error}`;
    }

    // Step 4 — the cloud result IS the deliverable.
    //
    // IMS already writes a finished, correctly spliced MP4 straight to OSS, so it is
    // registered as the output as-is. Drawing subtitles on it used to happen here and
    // cost a full decode plus re-encode of the entire video (~87 s for a 67 s cut on
    // this host), which also compressed the cloud result a second time for no gain in
    // the cut itself. That burn is now opt-in via
    // `IP_AGENT_VIDEO_RENDER_IMS_BURN_SUBTITLES`, and off by default.
    const burnRequested = boolSetting(process.env.IP_AGENT_VIDEO_RENDER_IMS_BURN_SUBTITLES);
    let finalVideo = await registerExistingObject({
      storageKey: prepared.storageKey,
      mimeType: 'video/mp4',
      filename: prepared.filename,
    });
    // Subtitle outcome, from whichever path ran. The native track is listed first because
    // it is what production uses; a local burn, when explicitly switched on, replaces it.
    let subtitle = {
      storageKey: subtitleTrack.storageKey,
      filename: subtitleTrack.filename,
      format: subtitleTrack.attached ? 'ass' : null,
      burned: false,
      attachedToTimeline: Boolean(subtitleTrack.attached),
      urlMode: subtitleTrack.urlMode || null,
      error: subtitleTrack.error || null,
    };

    if (burnRequested) {
      const workDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ims-render-'));
      try {
        // IMS writes the object with its own authorization, but reading it back from
        // this process needs a signed URL: the bucket is private.
        const renderReadUrl = signedReadUrl({
          storageKey: prepared.storageKey,
          name: prepared.filename,
        }, { preferOss: true });
        const burned = await burnSubtitlesOnVideo({
          project,
          task,
          input: {
            ...input,
            subtitleText: narrationTextFor(input, planOutput),
            timedWords: planOutput.timedWords || input.timedWords || [],
          },
          sourceUrl: renderReadUrl,
          durationSeconds: Number(planOutput.durationSeconds) || 0,
          ratio: planOutput.ratio || input.ratio || '9:16',
          workDirectory,
          onProgress: options.onProgress,
        });
        finalVideo = burned.storedVideo;
        subtitle = burned.subtitle;
      } finally {
        await fs.rm(workDirectory, { recursive: true, force: true }).catch(() => {});
      }
    }

    const finalUrl = signedReadUrl({ storageKey: finalVideo.storageKey, name: finalVideo.filename });
    await options.onProgress?.(96, subtitle.burned ? 'IMS 成片与字幕已落盘 OSS' : 'IMS 成片已落盘 OSS');
    return {
      provider: 'aliyun-ims',
      model: planOutput.transcriptionMode || 'media-producing-timeline',
      externalTaskId: jobId,
      planTaskId: plan.jobId,
      output: {
        contentUrl: finalUrl,
        filename: finalVideo.filename,
        storageKey: finalVideo.storageKey,
        sizeBytes: finalVideo.sizeBytes,
        sha256: finalVideo.sha256,
        etag: finalVideo.etag,
        durationSeconds: Number(planOutput.durationSeconds) || 0,
        ratio: planOutput.ratio || input.ratio || null,
        segmentCount: clips.length,
        subtitleStorageKey: subtitle.storageKey,
        subtitleFilename: subtitle.filename,
        subtitleBurned: subtitle.burned,
        subtitleFormat: subtitle.format,
        subtitleAttachedToTimeline: subtitle.attachedToTimeline,
        subtitleUrlMode: subtitle.urlMode,
        // `attached` means the track went into the Timeline with a url IMS was given — it
        // does NOT mean pixels were drawn. Measured on this account: IMS accepts the
        // timeline and draws nothing. The value is reported honestly rather than claimed
        // as success, so the day it starts rendering is visible in the results.
        subtitleStatus: subtitle.burned
          ? (subtitle.error ? 'fallback' : 'burned')
          : (subtitle.attachedToTimeline
            ? 'attached'
            : (input.autoSubtitles === false
              ? 'disabled'
              : (subtitle.error ? 'unavailable' : 'not-requested'))),
        subtitleError: subtitle.error || null,
        pipelineStages: [
          '方案生成（本机算法）',
          'IMS 时间线渲染',
          ...(subtitle.burned ? ['字幕烧录'] : []),
          '成片落盘 OSS',
        ],
        algorithm: planOutput.algorithm || '主视频时间线语义素材匹配',
        editSummary: planOutput.editSummary || `IMS 渲染 ${clips.length} 段`,
        transitions: planOutput.transitions || null,
        sourceAssetIds: assets.map((asset) => asset.id),
        sourceAssetId: planOutput.mainAssetId || assets[0]?.id || null,
        mainAssetId: planOutput.mainAssetId || null,
        narrationAssetId: planOutput.narrationAssetId || null,
        template: input.template || 'vlog',
        autoMatchPlan: planOutput.autoMatchPlan || null,
        transcriptText: planOutput.transcriptText || '',
        subtitleText: planOutput.subtitleText || '',
        timedWords: planOutput.timedWords || null,
        transcriptionMode: planOutput.transcriptionMode || null,
        editWindow: planOutput.editWindow || null,
        sourceDurationSeconds: planOutput.sourceDurationSeconds ?? null,
      },
    };
  } finally {
    if (prepared.temporaryDirectory) await fs.rm(prepared.temporaryDirectory, { recursive: true, force: true }).catch(() => {});
  }
}
