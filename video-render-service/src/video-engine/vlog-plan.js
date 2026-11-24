/**
 * Plan-only vlog renderer.
 *
 * Runs the auto-edit decision set and returns it *without rendering*, so a
 * caller that can reach a renderer the service cannot (Aliyun IMS, another
 * region, another account) can execute the plan itself.
 *
 * This exists so the heavy compute can move to the cloud without moving the
 * algorithm: the plan is ~20 ms of pure computation, while the encode is what
 * needs concurrency.
 */

import { ProviderError } from '../lib/http.js';
import { buildVlogPlan, planToTimeline } from './vlog-planner.js';
import { createTikTokAdaptiveSubtitle } from './tiktok-subtitles.js';

/**
 * Wrapper identifying a placeholder that stands in for a real media URL.
 *
 * The plan-only path cannot always emit a fetchable URL: the production bucket is
 * private, so a plain or CDN-signed link is refused by IMS. That case still has to
 * run the compiler unchanged, so it is fed these tokens instead and the caller
 * swaps each one for an IMS `MediaId` it obtained itself.
 */
export const MEDIA_ID_TOKEN_PREFIX = 'chensi-media-id:';

/**
 * The same trick for the subtitle file.
 *
 * The subtitle track needs a URL IMS can fetch, and only the caller can store the file
 * and sign a link to it (this service holds no OSS credentials by design — see
 * `createAssetUrlResolver`). So the compiler is handed this token and the caller swaps it
 * for the real address, exactly as it already does for media urls.
 */
export const SUBTITLE_FILE_TOKEN = 'chensi-subtitle-file:';

const MEDIA_ID_TOKEN_PATTERN = /^chensi-media-id:([A-Za-z0-9_-]+)$/;

export function isMediaIdToken(value) {
  return MEDIA_ID_TOKEN_PATTERN.test(String(value || ''));
}

/**
 * Resolve an asset to a URL the caller's renderer can fetch.
 *
 * The render service holds no OSS credentials and must not need any: it only
 * describes storage. `VIDEO_RENDER_OSS_PUBLIC_BASE` supplies the bucket's public
 * base, and each asset's `storageKey` (which the main application already sends,
 * and which IS the OSS object key when it runs in oss storage mode) is appended.
 *
 * Pass `mediaIdToken: true` when the caller registers the media with IMS itself.
 * The compiler is untouched either way — it only ever sees the string this
 * function returns.
 */
export function createAssetUrlResolver({
  publicBase = String(process.env.VIDEO_RENDER_OSS_PUBLIC_BASE || '').trim(),
  assetUrlPrefix = String(process.env.VIDEO_RENDER_OSS_ASSET_PREFIX || '').trim(),
  mediaIdToken = false,
} = {}) {
  return function urlFor(asset) {
    const raw = String(asset?.ossUrl || asset?.publicUrl || '').trim();
    if (/^https?:\/\//i.test(raw)) return raw;

    const key = String(asset?.ossKey || asset?.storageKey || '').trim().replace(/^\/+/, '');
    if (!key) return null;
    if (/^https?:\/\//i.test(key)) return key;

    // A token carries the asset id, which is the same key the caller already uses
    // for its own assets, so no extra mapping has to travel with the plan.
    if (mediaIdToken) {
      const id = String(asset?.id || '').trim();
      return id ? `${MEDIA_ID_TOKEN_PREFIX}${id}` : null;
    }

    // The main application already stores the fully-qualified key, so a prefix
    // is only needed for deployments that namespace it separately.
    const prefix = assetUrlPrefix.replace(/^\/+|\/+$/g, '');
    const fullKey = key.startsWith(`${prefix}/`) || !prefix ? key : `${prefix}/${key}`;
    if (!publicBase) return null;
    return `${publicBase.replace(/\/+$/, '')}/${fullKey.split('/').map(encodeURIComponent).join('/')}`;
  };
}

export async function renderVlogPlan(task, input, project, { onProgress = async () => {} } = {}) {
  // Tokens by default, because the caller is the only party that can sign a URL
  // IMS will accept: the production bucket is private and IMS refuses CDN-authed
  // links. Setting `VIDEO_RENDER_OSS_PUBLIC_BASE` restores real URLs for
  // deployments whose bucket is public.
  const publicBase = String(process.env.VIDEO_RENDER_OSS_PUBLIC_BASE || '').trim();
  const urlFor = createAssetUrlResolver({ mediaIdToken: !publicBase });
  const built = await buildVlogPlan(task, input, project, { onProgress });
  const ratio = input.ratio || '9:16';

  // Subtitle, laid out by the same engine the local renderer uses, then attached to the
  // timeline as an external file.
  //
  // No media is read here, even though `createTikTokAdaptiveSubtitle` accepts an audio
  // path: when word timings are supplied it takes them and never touches the file, and
  // when they are not it falls back to spreading the script over the known duration.
  // That keeps the plan-only path's promise — decide the edit without downloading
  // anything — while still producing a real ASS.
  let subtitle = null;
  let subtitleError = null;
  const wantSubtitle = input.subtitleEmphasis !== false && input.autoSubtitles !== false;
  const subtitleText = String(input.subtitleText || built.transcriptText || '').trim();
  if (wantSubtitle && (subtitleText || (built.timedWords || []).length)) {
    try {
      const meta = await createTikTokAdaptiveSubtitle({
        // Deliberately no audioPath: the plan path must not need the media.
        text: subtitleText,
        durationSeconds: built.window.durationSeconds,
        language: input.language,
        ratio,
        timedWords: built.timedWords || null,
      });
      if (meta?.ass && String(meta.ass).trim()) {
        subtitle = {
          format: 'ass',
          filename: `${String(input.title || project?.name || 'video')}-subtitles.ass`.replace(/[\\/:*?"<>|]/g, '_'),
          content: String(meta.ass),
          transcribed: Boolean(meta.transcribed),
        };
      } else {
        subtitleError = 'subtitle engine returned no ASS';
      }
    } catch (error) {
      // A subtitle must never cost the caller its video — the render is the deliverable.
      subtitleError = error?.message || String(error);
    }
  }

  const compiled = planToTimeline(built, {
    urlFor,
    ratio,
    subtitleFileUrl: subtitle ? SUBTITLE_FILE_TOKEN : null,
    subtitleSubType: 'ass',
  });
  await onProgress(48, `方案已生成（${built.plan.length} 段 / ${compiled.meta.transitions} 转场）`);

  // No file is produced: the caller renders it. `storageKey` is left empty so
  // the job result carries the plan rather than pointing at a missing file.
  return {
    provider: 'vlog-plan',
    model: built.transcription?.language || null,
    externalTaskId: null,
    planOnly: true,
    output: {
      filename: null,
      storageKey: null,
      sizeBytes: null,
      durationSeconds: compiled.meta.durationSeconds,
      ratio,
      template: 'vlog',
      templateLabel: 'AI 自动剪辑（仅方案）',
      algorithm: '主视频时间线语义素材匹配',
      planOnly: true,
      segmentCount: built.plan.length,
      // Whether `imsTimeline` carries `chensi-media-id:<assetId>` placeholders
      // (the caller must swap in MediaIds) or fetchable URLs.
      mediaIdTokens: !publicBase,
      mediaIdTokenPrefix: MEDIA_ID_TOKEN_PREFIX,
      // The subtitle file itself, plus the placeholder the timeline carries for its URL.
      // The caller stores the content, then swaps the placeholder for an address IMS can
      // fetch — the same division of labour the media urls already use.
      subtitle: subtitle
        ? { ...subtitle, fileUrlToken: SUBTITLE_FILE_TOKEN, subType: 'ass' }
        : null,
      subtitleError,
      // everything the caller needs to render elsewhere
      imsTimeline: compiled.timeline,
      imsTimelineMeta: compiled.meta,
      autoMatchPlan: built.plan,
      transitions: compiled.transitions,
      imsTransitionRotation: compiled.imsTransitionRotation,
      transcriptText: compiled.transcriptText,
      subtitleText: String(input.subtitleText || compiled.transcriptText || '').trim(),
      timedWords: compiled.timedWords,
      mainAssetId: String(built.mainAsset.id),
      narrationAssetId: built.narrationAsset ? String(built.narrationAsset.id) : null,
      editWindow: built.window,
      sourceDurationSeconds: built.mainDuration,
      transcriptionMode: compiled.timedWords.length ? 'audio-word-timestamps' : 'script-fallback',
      // Populated when no word timings were produced: the caller can supply them
      // (its own speech recognition, or an earlier run) and ask again.
      transcriptionUnavailable: built.transcriptionUnavailable || null,
      // How many assets were planned from metadata. When this covers the whole
      // candidate set, planning read no media at all.
      plannedFromMetadata: built.plannedFromMetadata || null,
      pipelineStages: ['主视频语音识别', '字幕语义分段', '素材语义匹配', 'IMS 时间线生成'],
      editSummary: `仅方案 · ${built.plan.length} 段 · ${compiled.meta.transitions} 个转场 · ${compiled.meta.durationSeconds}s`,
    },
  };
}

/** Fail fast when the caller asked for a timeline but no base URL is configured. */
export function assertPlanResolverConfigured() {
  if (!String(process.env.VIDEO_RENDER_OSS_PUBLIC_BASE || '').trim()) {
    throw new ProviderError('VLOG_PLAN_STORAGE_BASE_MISSING',
      '生成 IMS 时间线需要配置 VIDEO_RENDER_OSS_PUBLIC_BASE（如 https://<bucket>.oss-cn-shenzhen.aliyuncs.com）',
      { status: 503 });
  }
}
