/**
 * Auto-edit plan computation, without any rendering.
 *
 * Extracted from tiktok-vlog.js so the plan can be produced on its own and sent
 * to a different renderer. Measured cost is ~20 ms and ~63 MB for a 208-asset
 * project, so this runs comfortably on a small host — the expensive parts of a
 * job are transcription and the encode, not this.
 *
 * Everything here is a pure decision: which asset, where to cut, which
 * transition. Nothing reads media bytes, so the caller decides how to execute it
 * (local ffmpeg, IMS Timeline, or anything else).
 */

import { ProviderError } from '../lib/http.js';
import { findSource, probeDuration } from '../providers/media.js';
import { transcribeWords } from './whisper.js';
import { compileVlogTimeline, TRANSITION_SUBTYPE, IMS_TRANSITION_ROTATION } from './aliyun-timeline.js';
import {
  AUTO_EDIT_MAX_SHOT_SECONDS,
  AUTO_EDIT_MIN_SHOT_SECONDS,
  autoEditWindow,
  autoEditShotTimeline,
  buildAutoEditPlan,
  isAutoEditOutputAsset,
  scriptTimeline,
} from './tiktok-vlog.js';

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Build the full auto-edit decision set for a vlog job.
 *
 * @returns plan, the shot timeline, the edit window, and the resolved asset map
 *          so a caller can render through any backend without recomputing.
 */
export async function buildVlogPlan(task, input, project, {
  onProgress = async () => {},
  mediaConfig,
  translate = async () => {},
  transcription: suppliedTranscription = null,
} = {}) {
  // Phase stopwatch. Gated behind an env flag so production stays quiet; used to
  // attribute the time between two progress stages when a plan is unexpectedly slow.
  const traceEnabled = Boolean(process.env.VIDEO_RENDER_PLAN_TRACE);
  const t0 = Date.now();
  const mark = (label) => {
    if (traceEnabled) console.error(`[plan-trace] ${label} +${Date.now() - t0}ms`);
  };
  mark('start');
  const config = mediaConfig || {
    ffmpegPath: process.env.VIDEO_RENDER_FFMPEG_PATH || 'ffmpeg',
    ffprobePath: process.env.VIDEO_RENDER_FFPROBE_PATH || 'ffprobe',
    timeoutMs: finite(process.env.VIDEO_RENDER_MEDIA_TIMEOUT_MS, 30 * 60_000),
  };

  // ---- main asset ---------------------------------------------------------
  const ids = [...new Set([
    ...(Array.isArray(input.videoAssetIds) ? input.videoAssetIds : []),
    input.videoAssetId,
  ].filter(Boolean).map(String))];
  if (ids.length > 1) {
    throw new ProviderError('VIDEO_MAIN_ASSET_COUNT_INVALID',
      'AI 自动剪辑只需选择一条主视频，其他视频会从素材库自动匹配', { status: 400 });
  }

  // Metadata the caller already holds. Planning needs only durations and speech
  // timings, so when they arrive here the media never has to be read at all — the
  // caller runs on object storage and can supply both without a download.
  const suppliedDurations = input.assetDurations && typeof input.assetDurations === 'object'
    ? input.assetDurations
    : null;
  const durationOf = (asset) => {
    const supplied = finite(suppliedDurations?.[String(asset?.id)], NaN);
    if (Number.isFinite(supplied) && supplied > 0) return supplied;
    const stored = finite(asset?.durationSeconds, NaN);
    return Number.isFinite(stored) && stored > 0 ? stored : null;
  };
  if (traceEnabled) {
    console.error(`[plan-trace] durations supplied for ${Object.keys(suppliedDurations || {}).length} ids;`
      + ` candidates with asset.durationSeconds: ${(project.assets || []).filter((item) => Number(item?.durationSeconds) > 0).length}`
      + ` of ${(project.assets || []).length}`);
  }

  mark('before main resolve');
  const requestedMainId = ids.length ? ids[0] : null;
  let mainAsset = (project.assets || []).find((item) => (
    requestedMainId
      ? String(item.id) === requestedMainId
      : Boolean(input.videoSample) && Boolean(item.storageKey)
  ));
  if (!mainAsset) {
    throw new ProviderError('VIDEO_ASSET_REQUIRED', '请先选择一条数字人主视频', { status: 400 });
  }
  if (isAutoEditOutputAsset(mainAsset, project.outputs)) {
    throw new ProviderError('VIDEO_AUTO_EDIT_RECURSIVE_SOURCE',
      '自动剪辑成片不能再次作为主视频，请选择原始视频或数字人口播成片', { status: 400 });
  }

  // The file is only needed when a duration has to be measured or the speech has to
  // be transcribed here. Both are optional, so resolve it lazily and tolerate its
  // absence: on the plan-only path for a caller that stores media elsewhere, the
  // whole point is to decide the edit without fetching anything.
  const mediaRequired = !durationOf(mainAsset) || !Array.isArray(input.transcriptWords);
  let mainSource = null;
  if (mediaRequired) {
    try {
      mainSource = await findSource({
        assetId: mainAsset.id,
        assets: project.assets,
        mimePrefix: 'video/',
        timeoutMs: config.timeoutMs,
      });
    } catch (error) {
      mainSource = null;
      if (!durationOf(mainAsset)) {
        throw new ProviderError('VIDEO_MAIN_DURATION_UNAVAILABLE',
          `无法获取主视频时长，且素材文件不在本机：${error?.message || error}`, { status: 409 });
      }
    }
  }

  const mainDurationFromMeta = durationOf(mainAsset) || (mainSource?.filePath
    ? await probeDuration(mainSource.filePath, config)
    : null);
  if (!mainDurationFromMeta) {
    throw new ProviderError('VIDEO_MAIN_DURATION_UNAVAILABLE', '无法获取主视频时长', { status: 409 });
  }
  await onProgress(12, '主视频已读取');

  // ---- candidate b-roll ---------------------------------------------------
  const candidateAssets = (project.assets || []).filter((asset) => (
    asset.id !== mainAsset.id
    && asset.storageKey
    && String(asset.mimeType || '').startsWith('video/')
    && !isAutoEditOutputAsset(asset, project.outputs)
  ));
  if (!candidateAssets.length) {
    throw new ProviderError('VIDEO_BROLL_REQUIRED',
      '素材库还没有可自动匹配的辅助视频，请至少再上传一条视频素材', { status: 400 });
  }

  // Durations come from metadata when available; only the assets that lack one have
  // to be probed, and probing needs a local file.
  mark('before candidate durations');
  const candidateDurations = [];
  const needProbe = [];
  for (const asset of candidateAssets) {
    const known = durationOf(asset);
    candidateDurations.push(known);
    if (!known) needProbe.push(asset);
  }
  if (traceEnabled) console.error(`[plan-trace] candidates=${candidateAssets.length} needProbe=${needProbe.length}`);
  if (needProbe.length) {
    // Measured: probing even ~200 candidates serially cost 22.6 s, because each
    // ffprobe spawn is ~100 ms of process startup. The probes are independent, so
    // they run with a small bound instead — the machine has 8 cores and this is
    // process startup, not CPU-starvation-bound work.
    const probeConcurrency = Math.max(1, Math.min(
      finite(process.env.VIDEO_RENDER_PLAN_PROBE_CONCURRENCY, 8),
      needProbe.length,
    ));
    let next = 0;
    const workers = Array.from({ length: probeConcurrency }, async () => {
      for (;;) {
        const cursor = next;
        next += 1;
        if (cursor >= needProbe.length) return;
        const asset = needProbe[cursor];
        const index = candidateAssets.indexOf(asset);
        let source = null;
        try {
          source = await findSource({ assetId: asset.id, assets: project.assets, mimePrefix: 'video/', timeoutMs: config.timeoutMs });
        } catch {
          source = null;
        }
        if (!source?.filePath) {
          throw new ProviderError('VIDEO_CANDIDATE_DURATION_UNAVAILABLE',
            `无法获取候选素材时长，且素材文件不在本机：${asset.name || asset.id}`, { status: 409 });
        }
        candidateDurations[index] = await probeDuration(source.filePath, config);
      }
    });
    await Promise.all(workers);
  }
  mark('after candidate durations');
  const mainDuration = mainDurationFromMeta;
  await onProgress(24, '候选素材已读取');

  // ---- transcription -------------------------------------------------------
  // Supplied by the caller when it has it; otherwise read from the main video, which
  // requires the file to be present. Absence is not fatal — the script text still
  // gives deterministic semantic timing — but it is no longer silent: the caller is
  // told, because the difference is visible in the finished edit.
  const window = autoEditWindow(mainDuration, {
    materialStartSeconds: input.materialStartSeconds,
    sourceTailSeconds: input.sourceTailSeconds,
  });
  mark('before transcription');
  let transcription = suppliedTranscription
    || (Array.isArray(input.transcriptWords)
      ? { words: input.transcriptWords, text: input.transcriptText || '' }
      : null);
  let transcriptionUnavailable = null;
  if (!transcription) {
    if (!mainSource?.filePath) {
      transcriptionUnavailable = 'MEDIA_UNAVAILABLE';
    } else {
      try {
        transcription = await transcribeWords(mainSource.filePath, {
          language: String(input.language || '').split(/[-_]/)[0] || undefined,
        });
      } catch (error) {
        if (error?.code === 'RENDER_CANCELED') throw error;
        transcriptionUnavailable = error?.code || error?.message || 'TRANSCRIBE_FAILED';
      }
    }
  }
  const timedWords = Array.isArray(transcription?.words) ? transcription.words : [];
  const transcriptText = String(transcription?.text
    || timedWords.map((item) => item.word || item.text || '').join('')).trim();
  const semanticText = transcriptText || String(input.subtitleText || '').trim();
  const timeline = scriptTimeline({ ...window, text: semanticText, words: timedWords });
  await onProgress(36, '口播时间线已识别');

  // Recorded so the caller can see whether planning needed the media at all.
  const plannedFromMetadata = {
    mainDuration: durationOf(mainAsset) ? 'metadata' : 'probed',
    candidatesTotal: candidateDurations.length,
    candidatesProbed: needProbe.length,
    transcription: transcriptionUnavailable ? 'unavailable' : 'available',
  };

  // ---- plan ---------------------------------------------------------------
  mark('before plan build');
  const candidatesWithDuration = candidateAssets.map((asset, index) => ({
    ...asset,
    durationSeconds: candidateDurations[index],
  }));
  const shotTimeline = autoEditShotTimeline(timeline, candidatesWithDuration, {
    minimumShotSeconds: AUTO_EDIT_MIN_SHOT_SECONDS,
    maximumShotSeconds: AUTO_EDIT_MAX_SHOT_SECONDS,
  });
  const plan = buildAutoEditPlan({
    ...window,
    timeline: shotTimeline,
    assets: candidatesWithDuration,
    seed: input.matchSeed || task.id,
    historyPlans: (project.outputs || [])
      .filter((output) => output.template === 'vlog' && Array.isArray(output.autoMatchPlan))
      .slice(0, 8)
      .map((output) => output.autoMatchPlan),
  });
  if (!plan.length) {
    throw new ProviderError('VIDEO_AUTO_MATCH_EMPTY',
      '没有生成可用的自动素材匹配时间线', { status: 400 });
  }

  // Every asset the plan references, so the caller can resolve storage.
  const byId = new Map();
  for (const asset of [mainAsset, ...candidatesWithDuration]) {
    if (asset?.id) byId.set(String(asset.id), asset);
  }
  await translate(42, `素材匹配方案已生成（${plan.length} 段）`);

  return {
    plan,
    window,
    shotTimeline,
    mainAsset,
    mainSource,
    narrationAsset: input.audioAssetId
      ? (project.assets || []).find((asset) => String(asset.id) === String(input.audioAssetId)) || null
      : null,
    assetById: byId,
    transcription,
    timedWords,
    transcriptText,
    semanticText,
    mainDuration,
    // Why no word timings were produced, when that is the case: the caller decides
    // whether to supply them and retry, rather than discovering it in the output.
    transcriptionUnavailable,
    // Whether the media had to be read to plan this edit, and for what.
    plannedFromMetadata,
  };
}

/**
 * Every asset duration the planner actually knows, keyed by asset id.
 *
 * Candidate records already carry the value they were matched against (declared
 * metadata, or the probe result), but the main video's record may still lack one while
 * `mainDuration` holds it — and the main video is what the intro and tail clips read
 * from, so it has to be present for those boundaries to keep their transitions.
 */
function timelineDurations(built) {
  const durations = new Map();
  for (const [id, asset] of built.assetById) {
    const seconds = Number(asset?.durationSeconds);
    if (Number.isFinite(seconds) && seconds > 0) durations.set(String(id), seconds);
  }
  const mainSeconds = Number(built.mainDuration);
  if (built.mainAsset?.id && Number.isFinite(mainSeconds) && mainSeconds > 0) {
    durations.set(String(built.mainAsset.id), mainSeconds);
  }
  return durations;
}

/**
 * Turn a computed plan into an IMS Timeline.
 *
 * `urlFor(asset)` resolves an asset to something IMS can fetch — an OSS URL in
 * production. Kept as a callback so the render service never needs OSS
 * credentials merely to describe the work.
 */
export function planToTimeline(built, { urlFor, ratio = '9:16', maxSeconds = 600, subtitleFileUrl = null, subtitleSubType = 'ass' } = {}) {
  const urlById = new Map();
  const unresolved = [];
  for (const [id, asset] of built.assetById) {
    const url = urlFor(asset);
    if (url) urlById.set(id, url);
    else unresolved.push({ id, name: asset?.name || null, storageKey: asset?.storageKey || null });
  }
  const missing = built.plan.filter((item) => !urlById.has(String(item.assetId)));
  if (missing.length) {
    throw new ProviderError('ALIYUN_ASSET_NOT_IN_OSS',
      `${missing.length} 个被选中的素材无法解析为可访问地址`,
      {
        status: 400,
        details: {
          unresolved: unresolved.slice(0, 10),
          missingAssetNames: [...new Set(missing.map((i) => i.assetName))].slice(0, 5),
        },
      });
  }

  const { timeline, meta } = compileVlogTimeline({
    window: built.window,
    plan: built.plan,
    urlById,
    mainAssetId: String(built.mainAsset.id),
    narrationAssetId: built.narrationAsset ? String(built.narrationAsset.id) : null,
    ratio,
    durationSeconds: built.window.durationSeconds,
    maxSeconds: Math.max(60, Math.ceil(built.window.durationSeconds) + 5),
    // A clip has to be able to pay for its own transition out of its source (see the
    // long note in compileVlogTimeline), so the compiler needs the same durations the
    // planner matched against. `assetById` already carries them: the planner attaches
    // the probed value to every candidate it considered, and `mainDuration` covers the
    // main video, whose asset record may have had no declared duration.
    durationById: timelineDurations(built),
    // Native IMS subtitle track — the shape the official `SubtitleTrackClip` documents.
    // The URL is a placeholder on the plan-only path, exactly like the media urls: the
    // caller is the party that can store and sign the file.
    subtitle: subtitleFileUrl ? { fileUrl: subtitleFileUrl, subType: subtitleSubType } : null,
  });

  return {
    timeline,
    meta,
    urlById,
    transcriptText: built.transcriptText,
    semanticText: built.semanticText,
    timedWords: built.timedWords,
    transitions: built.plan.map((item) => ({
      type: item.transition,
      subtype: TRANSITION_SUBTYPE[item.transition] ?? null,
      duration: item.transitionDurationSeconds,
    })),
    imsTransitionRotation: IMS_TRANSITION_ROTATION,
  };
}
