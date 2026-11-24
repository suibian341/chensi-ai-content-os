// The plan-only path hands a compiled IMS Timeline to the main application,
// which swaps each asset reference for an IMS MediaId. That swap is only safe if
// the plan compiler itself is untouched — so these tests pin the Timeline's
// numbers (cut points, transitions, canvas) against the mode switch.
//
// Context: the production OSS bucket is private and IMS refuses CDN-authed URLs,
// so `mediaIdToken` mode is the path production actually uses.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MEDIA_ID_TOKEN_PREFIX,
  createAssetUrlResolver,
  isMediaIdToken,
} from '../src/video-engine/vlog-plan.js';
import { planToTimeline } from '../src/video-engine/vlog-planner.js';
import { compileVlogTimeline } from '../src/video-engine/aliyun-timeline.js';

const MAIN_ID = 'a_main';
const B1 = 'a_broll_one';
const B2 = 'a_broll_two';

/** A decision set shaped exactly like `buildVlogPlan` returns, with no media IO. */
function fabricatedPlan() {
  const assets = [
    { id: MAIN_ID, name: '主视频.mp4', mimeType: 'video/mp4', storageKey: 'users/u/projects/p/assets/a_main/主视频.mp4', durationSeconds: 30 },
    { id: B1, name: '空镜一.mp4', mimeType: 'video/mp4', storageKey: 'users/u/projects/p/assets/a_broll_one/空镜一.mp4', durationSeconds: 12 },
    { id: B2, name: '空镜二.mp4', mimeType: 'video/mp4', storageKey: 'users/u/projects/p/assets/a_broll_two/空镜二.mp4', durationSeconds: 9 },
  ];
  const plan = [
    { segmentId: 's1', assetId: B1, assetName: '空镜一.mp4', assetStartSeconds: 2, timelineStartSeconds: 0, timelineEndSeconds: 3, durationSeconds: 3, transition: 'SLIDE_LEFT', transitionDurationSeconds: 0.24 },
    { segmentId: 's2', assetId: B2, assetName: '空镜二.mp4', assetStartSeconds: 1.5, timelineStartSeconds: 3, timelineEndSeconds: 5.5, durationSeconds: 2.5, transition: 'WIPE_UP', transitionDurationSeconds: 0.24 },
    { segmentId: 's3', assetId: B1, assetName: '空镜一.mp4', assetStartSeconds: 6, timelineStartSeconds: 5.5, timelineEndSeconds: 8, durationSeconds: 2.5, transition: 'CUT', transitionDurationSeconds: 0 },
  ];
  return {
    plan,
    window: {
      materialStartSeconds: 1.25,
      materialEndSeconds: 21.25,
      sourceTailSeconds: 0.5,
      durationSeconds: 10,
    },
    mainAsset: assets[0],
    mainSource: assets[0],
    narrationAsset: null,
    assetById: new Map(assets.map((asset) => [String(asset.id), asset])),
    transcription: { words: [], text: '测试口播文案用于分段' },
    timedWords: [],
    transcriptText: '测试口播文案用于分段',
    semanticText: '测试口播文案用于分段',
    mainDuration: 30,
  };
}

function compileWith(urlFor) {
  return planToTimeline(fabricatedPlan(), { urlFor, ratio: '9:16' });
}

test('token mode emits one placeholder per distinct asset, carrying its id', () => {
  const { timeline, urlById } = compileWith(createAssetUrlResolver({ mediaIdToken: true }));

  const seen = new Set();
  for (const clip of timeline.VideoTracks[0].VideoTrackClips) {
    assert.ok(isMediaIdToken(clip.MediaURL), `expected a token, got ${clip.MediaURL}`);
    seen.add(clip.MediaURL);
  }
  // The main video appears as intro and tail, so ids collapse to three assets.
  assert.deepEqual(
    [...seen].sort(),
    [`${MEDIA_ID_TOKEN_PREFIX}${MAIN_ID}`, `${MEDIA_ID_TOKEN_PREFIX}${B1}`, `${MEDIA_ID_TOKEN_PREFIX}${B2}`].sort(),
  );
  assert.equal(urlById.size, 3, 'urlById must cover every referenced asset');
});

test('token mode leaves every timing and transition identical to URL mode', () => {
  const tokenised = compileWith(createAssetUrlResolver({ mediaIdToken: true }));
  const linked = compileWith(createAssetUrlResolver({ publicBase: 'https://bucket.oss-cn-shenzhen.aliyuncs.com' }));

  const strip = (timeline) => timeline.VideoTracks[0].VideoTrackClips.map((clip) => ({
    In: clip.In, Out: clip.Out, TimelineIn: clip.TimelineIn, TimelineOut: clip.TimelineOut,
    ScaleMode: clip.ScaleMode, Mute: clip.Mute, Effects: clip.Effects ?? null,
  }));

  assert.deepEqual(strip(tokenised.timeline), strip(linked.timeline),
    'swapping the resolver must not move a single cut or transition');
  assert.deepEqual(tokenised.meta, linked.meta);

  // And the URL mode really did produce URLs, so the comparison is meaningful.
  for (const clip of linked.timeline.VideoTracks[0].VideoTrackClips) {
    assert.match(clip.MediaURL, /^https:\/\/bucket\./);
  }
});

test('the compiled timeline matches the compiler called directly', () => {
  // planToTimeline must remain a thin wrapper: same inputs, same Timeline as
  // compileVlogTimeline. This is the guard against the two drifting apart.
  const built = fabricatedPlan();
  const urlFor = createAssetUrlResolver({ mediaIdToken: true });
  const viaPlanner = planToTimeline(built, { urlFor, ratio: '9:16' });

  const urlById = new Map();
  const durationById = new Map();
  for (const [id, asset] of built.assetById) {
    urlById.set(id, urlFor(asset));
    if (Number(asset?.durationSeconds) > 0) durationById.set(String(id), Number(asset.durationSeconds));
  }
  const direct = compileVlogTimeline({
    window: built.window,
    plan: built.plan,
    urlById,
    mainAssetId: String(built.mainAsset.id),
    narrationAssetId: null,
    ratio: '9:16',
    durationSeconds: built.window.durationSeconds,
    // A clip has to be able to pay for its own transition out of its source, so the
    // compiler cannot decide the same timeline without the durations.
    durationById,
  });

  assert.deepEqual(viaPlanner.timeline, direct.timeline);
  assert.deepEqual(viaPlanner.meta, direct.meta);
});

test('an asset with no storage key cannot silently become a token', () => {
  const built = fabricatedPlan();
  built.assetById.set('a_no_key', { id: 'a_no_key', name: '未落盘.mp4', mimeType: 'video/mp4' });
  built.plan = [{ ...built.plan[0], assetId: 'a_no_key' }];

  assert.throws(
    () => planToTimeline(built, { urlFor: createAssetUrlResolver({ mediaIdToken: true }), ratio: '9:16' }),
    // The error code lives on the property, not in the (Chinese) message.
    (error) => error?.code === 'ALIYUN_ASSET_NOT_IN_OSS',
    'a keyless asset must fail loudly rather than reach IMS as a broken clip',
  );
});

test('the resolver still returns null when neither tokens nor a base URL are available', () => {
  const urlFor = createAssetUrlResolver({ publicBase: '', mediaIdToken: false });
  assert.equal(urlFor({ id: 'a_x', storageKey: 'some/key.mp4' }), null);
  assert.equal(isMediaIdToken('https://example.com/a.mp4'), false);
  assert.equal(isMediaIdToken('chensi-media-id:'), false);
});
