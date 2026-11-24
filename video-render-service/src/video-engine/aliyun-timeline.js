/**
 * Aliyun IMS / VOD Timeline compiler.
 *
 * The private render service decides EVERYTHING in pure JS (asset matching,
 * shot boundaries, transitions, subtitle cues). This module does not make any
 * creative decision — it only translates those already-decided plans into the
 * Aliyun Timeline JSON so the cloud renders what the local service would have
 * rendered.
 *
 * Why it lives next to the existing engine instead of replacing it:
 *   algorithm layer  (tiktok-vlog / autoclip / breathcut)  -> untouched
 *   execution layer  (common.js ffmpeg calls)              -> this module
 * Both executors consume the same plan, so the cloud path can be switched on
 * per request and reverted without touching the algorithms.
 */

import { ProviderError } from '../lib/http.js';

// ---------------------------------------------------------------------------
// Transition mapping
//
// The private service names transitions after the ffmpeg xfade filter
// (TRANSITION_FILTERS in common.js). IMS accepts those names at submit time but
// rejects the whole `slide*` family later, during the render, with
// InvalidTimelineFormat — so the vocabulary has to be mapped, not passed through.
//
// Measured on the live service (render to completion, not just submit):
//   ACCEPTED : wiperight wipedown wipeup wipeleft fade random perlin
//              circleopen windowslice heart  (+ case variants wipeRight, ...)
//   REJECTED : slideleft slideright slideup slidedown
//              fadein fadeout dissolve left right up down
//              circleclose horzopen vertopen boxopen zoomin crossopen
//              star smoothleft smoothright
//
// The slide* names are mapped to the same-direction wipe so the local intent
// (direction of motion) is preserved. This is the one place where the cloud
// output is knowingly NOT identical to the local renderer.
// ---------------------------------------------------------------------------
export const TRANSITION_SUBTYPE = {
  SLIDE_LEFT: 'wipeleft',      // local 'slideleft' is unsupported by IMS
  SLIDE_RIGHT: 'wiperight',
  SLIDE_UP: 'wipeup',
  SLIDE_DOWN: 'wipedown',
  WIPE_DOWN: 'wipedown',       // local name is accepted as-is
  WIPE_UP: 'wipeup',
  WIPE_RIGHT: 'wiperight',
  CUT: null,
};

/** Local transition name -> the name the local ffmpeg renderer actually uses. */
export const LOCAL_TRANSITION_NAMES = {
  SLIDE_LEFT: 'slideleft',
  SLIDE_RIGHT: 'slideright',
  SLIDE_UP: 'slideup',
  SLIDE_DOWN: 'slidedown',
  WIPE_DOWN: 'wipedown',
  WIPE_UP: 'wipeup',
  WIPE_RIGHT: 'wiperight',
};

/** Transitions verified to RENDER on IMS (submit-time acceptance is not enough). */
export const IMS_SUPPORTED_TRANSITIONS = [
  // wipe family — same names the local renderer already emits
  'wiperight', 'wipedown', 'wipeup', 'wipeleft',
  // replacements for the unsupported slide family, verified render-complete
  'fade', 'circleopen', 'windowslice', 'perlin',
  // extras available if more variety is wanted later
  'random', 'heart',
];

/**
 * The rotation used when running on IMS.
 *
 * The local service rotates 7 types (AUTO_EDIT_TRANSITION_TYPES). Four of them
 * are the slide family, which IMS rejects during render, so they are replaced
 * here by verified-working names. Same count, same 0.24s duration, same
 * deterministic rotation — only the visual character of four slots changes.
 */
export const IMS_TRANSITION_ROTATION = [
  'wipeleft',     // stands in for SLIDE_LEFT
  'wiperight',    // stands in for SLIDE_RIGHT
  'fade',         // stands in for SLIDE_UP
  'circleopen',   // stands in for SLIDE_DOWN
  'wipedown',     // WIPE_DOWN, native
  'wipeup',       // WIPE_UP, native
  'wiperight',    // WIPE_RIGHT, native
];

// Cosmetic chain the local service applies when enhance is on.
// Kept here so the divergence is explicit and reviewable rather than implicit.
export const LOCAL_ENHANCEMENT_CHAIN = 'eq=contrast=1.04,unsharp=5:5:0.35:5:5:0,cas=strength=0.18';
export const ENHANCEMENT_MAPPING_NOTE =
  'Aliyun Timeline has no per-clip unsharp/cas equivalent. contrast maps to '
  + 'Filter(custom) brightness/contrast/saturation; sharpness has no verified '
  + 'counterpart. Verify before claiming pixel parity.';

const CANVAS = {
  '9:16': { width: 1080, height: 1920 },
  '16:9': { width: 1920, height: 1080 },
  '1:1': { width: 1080, height: 1080 },
  '3:4': { width: 1080, height: 1440 },
};

/**
 * Refuse to emit a clip whose In/Out and TimelineIn/TimelineOut are not written
 * as a pair.
 *
 * Aliyun documents that setting only one of the two makes the service use the
 * full original asset duration. That has produced six-figure-second single-job
 * bills. Because our plans carry source times and timeline times in separate
 * fields, a compiler bug here is a billing incident, not a visual glitch.
 */
export function assertClipBounds(clip, label) {
  const hasIn = clip.In !== undefined && clip.In !== null;
  const hasOut = clip.Out !== undefined && clip.Out !== null;
  const hasTin = clip.TimelineIn !== undefined && clip.TimelineIn !== null;
  const hasTout = clip.TimelineOut !== undefined && clip.TimelineOut !== null;

  if (hasIn !== hasOut) {
    throw new ProviderError('VOD_TIMELINE_BOUNDS_UNPAIRED',
      `${label}: In/Out must be set together (got In=${clip.In} Out=${clip.Out})`, { status: 500 });
  }
  if (hasTin !== hasTout) {
    throw new ProviderError('VOD_TIMELINE_BOUNDS_UNPAIRED',
      `${label}: TimelineIn/TimelineOut must be set together`, { status: 500 });
  }
  if (!hasIn && !hasTin) return;                     // whole asset, first position — fine
  if (!hasIn || !hasTin) {
    throw new ProviderError('VOD_TIMELINE_BOUNDS_INCOMPLETE',
      `${label}: source bounds and timeline bounds must both be present`, { status: 500 });
  }

  const sourceSpan = Number(clip.Out) - Number(clip.In);
  const timelineSpan = Number(clip.TimelineOut) - Number(clip.TimelineIn);
  if (!(sourceSpan > 0) || !(timelineSpan > 0)) {
    throw new ProviderError('VOD_TIMELINE_SPAN_INVALID',
      `${label}: non-positive span (source=${sourceSpan} timeline=${timelineSpan})`, { status: 500 });
  }
  // The local renderer muxes source[i] onto timeline[i] at 1x. Any mismatch
  // means the compiler mis-mapped a field, so refuse rather than bill for it.
  if (Math.abs(sourceSpan - timelineSpan) > 0.05) {
    throw new ProviderError('VOD_TIMELINE_SPAN_MISMATCH',
      `${label}: source span ${sourceSpan.toFixed(3)}s != timeline span ${timelineSpan.toFixed(3)}s`,
      { status: 500 });
  }
}

/**
 * Refuse to submit a timeline whose expected output duration exceeds a ceiling.
 * Second line of defence for the same billing risk as assertClipBounds.
 */
export function assertTotalDuration(durationSeconds, { maxSeconds = 600 } = {}) {
  const total = Number(durationSeconds);
  if (!Number.isFinite(total) || total <= 0) {
    throw new ProviderError('VOD_TIMELINE_EMPTY', `compiled timeline has no duration (${durationSeconds})`, { status: 500 });
  }
  if (total > maxSeconds) {
    throw new ProviderError('VOD_TIMELINE_TOO_LONG',
      `compiled timeline is ${total.toFixed(1)}s, ceiling is ${maxSeconds}s`, { status: 400 });
  }
  return total;
}

function round3(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function resolveUrl(assetId, urlById, label) {
  const url = urlById.get(String(assetId));
  if (!url) {
    throw new ProviderError('VOD_TIMELINE_ASSET_UNRESOLVED',
      `${label}: asset ${assetId} has no OSS URL / MediaId mapping`, { status: 400 });
  }
  return url;
}

function transitionEffect(name, durationSeconds) {
  const subtype = TRANSITION_SUBTYPE[name] ?? null;
  if (!subtype) return null;
  const duration = Number(durationSeconds) || 0;
  // A transition shorter than two frames cannot be expressed; the local
  // renderer drops those too (see effectiveTransitionDuration in tiktok-vlog).
  if (duration < 1 / 15) return null;
  return { Type: 'Transition', SubType: subtype, Duration: round3(duration) };
}

/**
 * How long a transition IMS is willing to render, given what is left in the source.
 *
 * A clip's source range has to be made longer by exactly the transition's duration
 * (see the note in compileVlogTimeline), so a shot cut from the very end of its
 * source cannot pay for a full-length one. `1e-3` absorbs the millisecond rounding
 * applied to every bound in this module; a sub-millisecond overrun is harmless.
 */
function affordableTransition(effect, assetDurationSeconds, sourceOut) {
  if (!effect) return null;
  const available = Number(assetDurationSeconds) - Number(sourceOut);
  if (!Number.isFinite(available)) return null;
  if (available + 1e-3 >= Number(effect.Duration)) return effect;
  // Shorter is better than nothing: the boundary keeps its direction of motion and
  // the timing stays exact either way, because the clip pays for whatever it declares.
  if (available >= 1 / 15) return { ...effect, Duration: round3(available) };
  return null;
}

/**
 * vlog: main narration + semantically matched b-roll shots + transitions.
 *
 * Local pipeline this mirrors (tiktok-vlog.js):
 *   optional intro (main video 0..materialStart, crop:false, muted)
 *   -> one normalizeSegment per plan entry (crop:true, muted, start=assetStartSeconds)
 *   -> optional tail (main video materialEnd..end, crop:false, muted)
 *   -> concatSegmentsWithTransitions(plan transitions)
 *   -> replaceAudioTrack(narration or main)
 *   -> burnSubtitles
 *
 * Two things about IMS are not obvious and both are load-bearing here. Both were
 * measured against the live service rather than read out of a document, because
 * submit-time acceptance says nothing about how a timeline actually renders.
 *
 * 1. WHICH BOUNDARY A TRANSITION LANDS ON.
 *    The plan stamps every entry with the transition leading INTO it — plan[i] is
 *    the boundary between shot i-1 and shot i, and plan[0] is the boundary between
 *    the intro and the first shot. That is how the local renderer reads it too:
 *    `concatSegmentsWithTransitions` consumes `specs[1..]`, so the transition is
 *    looked up on the *incoming* segment. IMS instead applies an Effect to the clip
 *    that carries it and transitions that clip into the NEXT one. The two are
 *    therefore one clip apart, so each clip here is given the transition of the
 *    segment that follows it. (Stamping a clip with its own transition — which is
 *    what this module used to do — both shifts every boundary by one shot and leaves
 *    the intro with no transition at all while the last clip carries one that has
 *    nowhere to go.)
 *
 * 2. A TRANSITION COSTS PICTURE UNLESS THE CLIP PAYS FOR IT.
 *    A clip carrying a t-second transition renders only (span - t) seconds of
 *    content, taken from the START of its source range. Measured:
 *      - 3 clips x 4 s declared end to end, no transitions      -> 12.000 s
 *      - the same with two 0.24 s transitions                   -> 11.520 s
 *      - declared at 0/4.24/8.48 instead of 0/4/8               -> identical output,
 *        so TimelineIn does not position a clip; the track is laid out sequentially
 *      - adding an audio track declaring the full 12 s           -> 12.000 s again,
 *        but with the last 0.48 s black, because nothing is left to draw there
 *    A production vlog declared 30 such transitions, so its picture ended 7.2 s
 *    before its narration did: seconds of black at the end and a video running that
 *    far ahead of its own audio. The fix is to make the source range (and with it the
 *    declared span) t seconds longer than the shot, so that after IMS subtracts t the
 *    clip renders exactly the planned shot, at the planned place, for the planned
 *    time. Verified: the extended declaration renders 12.000 s with no black and every
 *    sampled instant exactly where the plan put it, matching the no-transition control.
 *
 *    Each clip therefore pays for its own transition, which also means one clip
 *    dropping its transition cannot move any other cut.
 *
 * @param {object} args
 * @param {object} args.window            from autoEditWindow()
 * @param {Array}  args.plan              from buildAutoEditPlan()
 * @param {Map}    args.urlById           assetId -> OSS URL / MediaId
 * @param {string} args.mainAssetId       main video asset id
 * @param {?string} args.narrationAssetId audio asset id, or null to reuse main
 * @param {string} args.ratio             '9:16' | '16:9' | '1:1' | '3:4'
 * @param {number} args.durationSeconds   expected finished length
 * @param {object} [args.subtitle]        { fileUrl } or { cues } — see notes
 * @param {Map}    [args.durationById]    assetId -> real source duration. Required to
 *                                        prove a clip has room to pay for its
 *                                        transition; without it no transition is
 *                                        declared, which is the safe direction (timing
 *                                        stays exact, the boundary becomes a hard cut).
 */
export function compileVlogTimeline({
  window,
  plan,
  urlById,
  mainAssetId,
  narrationAssetId = null,
  ratio = '9:16',
  durationSeconds,
  subtitle = null,
  maxSeconds = 600,
  durationById = null,
}) {
  if (!Array.isArray(plan) || !plan.length) {
    throw new ProviderError('VOD_TIMELINE_EMPTY', 'auto-edit plan is empty', { status: 400 });
  }
  const mainUrl = resolveUrl(mainAssetId, urlById, 'main video');
  const assetDuration = (assetId) => {
    const value = Number(durationById?.get?.(String(assetId)));
    return Number.isFinite(value) && value > 0 ? value : null;
  };

  // Segments in the order the local renderer builds them. Each records the transition
  // that runs INTO it, and the clip before it inherits that (see note 1).
  const segments = [];
  const materialStart = Number(window?.materialStartSeconds) || 0;
  if (materialStart > 0) {
    segments.push({
      url: mainUrl,
      sourceIn: 0,
      duration: round3(materialStart),
      // crop:false in the local renderer == fit inside frame with padding
      scaleMode: 'fit',
      assetDurationSeconds: assetDuration(mainAssetId),
      label: 'intro',
    });
  }
  for (let index = 0; index < plan.length; index += 1) {
    const item = plan[index];
    const duration = Number(item.timelineEndSeconds) - Number(item.timelineStartSeconds);
    const assetStart = Number(item.assetStartSeconds);
    segments.push({
      url: resolveUrl(item.assetId, urlById, `plan[${index}]`),
      sourceIn: round3(assetStart),
      duration: round3(duration),
      scaleMode: 'crop',                 // crop:true in the local renderer
      assetDurationSeconds: assetDuration(item.assetId),
      incoming: {
        name: item.transition,
        durationSeconds: Number(item.transitionDurationSeconds) || 0,
      },
      label: `plan[${index}] (${item.segmentId || index})`,
    });
  }
  const tail = Number(window?.sourceTailSeconds) || 0;
  if (tail > 0) {
    const materialEnd = Number(window.materialEndSeconds);
    segments.push({
      url: mainUrl,
      sourceIn: round3(materialEnd),
      duration: round3(tail),
      scaleMode: 'fit',
      assetDurationSeconds: assetDuration(mainAssetId),
      // The local renderer gives this segment a transition of its own, but its NAME
      // comes from a rotation only tiktok-vlog can evaluate (transitionType(seed,
      // plan.length)). Guessing it would trade a cosmetic gap for an untestable
      // divergence, so this one boundary stays a hard cut — the timing is unaffected,
      // because a clip that declares no transition subtracts nothing.
      label: 'tail',
    });
  }
  if (!segments.length) {
    throw new ProviderError('VOD_TIMELINE_EMPTY', 'compiled timeline has no clips', { status: 400 });
  }

  const clips = [];
  let cursor = 0;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const incoming = segments[index + 1]?.incoming || null;
    const sourceOut = round3(segment.sourceIn + segment.duration);
    const effect = incoming
      ? affordableTransition(
        transitionEffect(incoming.name, incoming.durationSeconds),
        segment.assetDurationSeconds,
        sourceOut,
      )
      : null;
    const extension = effect ? Number(effect.Duration) : 0;
    const clip = {
      MediaURL: segment.url,
      In: segment.sourceIn,
      Out: round3(sourceOut + extension),
      // cursor is the *planned* position: the extension is what IMS will subtract, so
      // the declared span is longer than the shot while the shot keeps its place.
      TimelineIn: round3(cursor),
      TimelineOut: round3(cursor + segment.duration + extension),
      ScaleMode: segment.scaleMode,
      Mute: true,                        // plan sets muteAudio:true for b-roll
    };
    if (effect) clip.Effects = [effect];
    assertClipBounds(clip, segment.label || `segment[${index}]`);
    clips.push(clip);
    cursor += segment.duration;
  }

  // Nothing follows the last clip, and IMS rejects a timeline whose final clip carries
  // a transition. The loop above never gives it one; this is the guard for a caller
  // that hands in a pre-stamped list.
  delete clips[clips.length - 1].Effects;

  assertTotalDuration(cursor, { maxSeconds });

  const timeline = { VideoTracks: [{ VideoTrackClips: clips }] };

  // 4) narration audio: the local renderer replaces the whole track with the
  //    narration file (or the main video's own audio) across the full duration.
  //    This is also what fixes the composition length, so it has to be the planned
  //    total — the same number the video track now renders to.
  const audioUrl = resolveUrl(narrationAssetId || mainAssetId, urlById, 'narration audio');
  timeline.AudioTracks = [{
    AudioTrackClips: [{
      MediaURL: audioUrl,
      TimelineIn: 0,
      TimelineOut: round3(cursor),
    }],
  }];

  if (subtitle) timeline.SubtitleTracks = [buildSubtitleTrack(subtitle)];

  return {
    timeline,
    // Reported by the service so callers keep the same contract shape.
    meta: {
      durationSeconds: round3(cursor),
      // 'crop' vs 'fit' is the local crop:true/false semantics.
      canvas: CANVAS[ratio] || CANVAS['9:16'],
      shotCount: plan.length,
      transitions: clips.filter((clip) => Array.isArray(clip.Effects) && clip.Effects.length).length,
      enhancement: LOCAL_ENHANCEMENT_CHAIN,
    },
  };
}

/**
 * talking-head (pause removal) and industry-viral (highlight picks) share one
 * shape: N keep-intervals cut from a SINGLE source video, concatenated with
 * hard cuts, then subtitles burned.
 *
 * @param {object} args
 * @param {Array<{start:number,end:number}>} args.keeps  ordered keep intervals
 * @param {string} args.sourceAssetId
 * @param {Map}    args.urlById
 * @param {string} args.ratio
 * @param {object} [args.subtitle]
 */
export function compileSingleSourceTimeline({
  keeps,
  sourceAssetId,
  urlById,
  ratio = '9:16',
  subtitle = null,
  maxSeconds = 600,
}) {
  if (!Array.isArray(keeps) || !keeps.length) {
    throw new ProviderError('VOD_TIMELINE_EMPTY', 'no keep intervals to render', { status: 400 });
  }
  const url = resolveUrl(sourceAssetId, urlById, 'source video');

  const clips = [];
  let cursor = 0;
  keeps.forEach((interval, index) => {
    const start = Number(interval.start);
    const end = Number(interval.end);
    const span = end - start;
    if (!(span > 0)) return;
    const clip = {
      MediaURL: url,
      In: round3(start),
      Out: round3(end),
      TimelineIn: round3(cursor),
      TimelineOut: round3(cursor + span),
      ScaleMode: 'crop',                 // all three call sites pass crop:true
    };
    assertClipBounds(clip, `keep[${index}]`);
    clips.push(clip);
    cursor += span;
  });

  if (!clips.length) {
    throw new ProviderError('VOD_TIMELINE_EMPTY', 'every keep interval was zero-length', { status: 400 });
  }
  assertTotalDuration(cursor, { maxSeconds });

  const timeline = { VideoTracks: [{ VideoTrackClips: clips }] };
  timeline.AudioTracks = [{
    AudioTrackClips: clips.map((clip) => ({
      MediaURL: clip.MediaURL,
      In: clip.In,
      Out: clip.Out,
      TimelineIn: clip.TimelineIn,
      TimelineOut: clip.TimelineOut,
    })),
  }];
  if (subtitle) timeline.SubtitleTracks = [buildSubtitleTrack(subtitle)];

  return {
    timeline,
    meta: {
      durationSeconds: round3(cursor),
      canvas: CANVAS[ratio] || CANVAS['9:16'],
      segmentCount: clips.length,
      transitions: 0,                    // local renderer uses concat (hard cuts)
      enhancement: LOCAL_ENHANCEMENT_CHAIN,
    },
  };
}

/**
 * Subtitle track.
 *
 * The shape is the one the delivery package uses and the one the官方 field list
 * documents for `SubtitleTrackClip`:
 *
 *   SubtitleTracks[0].SubtitleTrackClips[0] = { Type:'Subtitle', SubType:'ass', FileURL }
 *
 * `FileURL` is not interchangeable with `MediaURL`: an external subtitle file goes in
 * `FileURL`, and the same field name is used for on-screen text clips. Measured on our
 * own account, so the divergence is written down rather than discovered again later:
 *
 *   FileURL + signed url   -> submit is accepted but the RENDER fails with
 *                             `…SubtitleConfig:ExtSubtitleList:ExtSubtitle:Input:Object
 *                             is not supported`
 *   FileURL + bare url     -> render succeeds and no subtitle is drawn (0 near-white
 *                             pixels in the lower third, versus ~16 900 for the same ASS
 *                             burned locally as a control) — even when the object is made
 *                             public-read, so it is not a reachability problem
 *   MediaURL               -> same as bare: accepted, nothing drawn
 *
 * In other words the field name this module used before (`MediaURL`) was wrong, and the
 * field name it uses now is right, but the feature itself is not doing anything for this
 * account yet. It is left wired up on purpose: the day it starts working, subtitles
 * appear with no code change, and `subtitleRendered` in the result says whether they did.
 */
function buildSubtitleTrack(subtitle) {
  if (subtitle.fileUrl) {
    return {
      SubtitleTrackClips: [{
        Type: 'Subtitle',
        SubType: String(subtitle.subType || 'ass').toLowerCase(),
        FileURL: subtitle.fileUrl,
      }],
    };
  }
  if (Array.isArray(subtitle.cues) && subtitle.cues.length) {
    return {
      SubtitleTrackClips: subtitle.cues.map((cue) => ({
        Type: 'Text',
        Content: String(cue.text ?? ''),
        TimelineIn: round3(cue.start),
        TimelineOut: round3(cue.end),
        ...(cue.fontSize ? { FontSize: Number(cue.fontSize) } : {}),
      })),
    };
  }
  throw new ProviderError('VOD_TIMELINE_SUBTITLE_INVALID',
    'subtitle needs either fileUrl or a non-empty cues array', { status: 400 });
}

/**
 * How the local service renders each template, in the order the ffmpeg calls
 * happen. Kept as data so the cloud executor and its tests can assert that the
 * compiled timeline preserves the same shape.
 */
export const LOCAL_PIPELINE_SHAPE = {
  vlog: ['intro?', 'shots[]', 'tail?', 'concatWithTransitions', 'replaceAudioTrack', 'burnSubtitles'],
  'talking-head': ['keeps[]', 'concat', 'burnSubtitles'],
  'industry-viral': ['highlights[]', 'concat', 'burnSubtitles'],
};

export const CANVAS_DIMENSIONS = CANVAS;
