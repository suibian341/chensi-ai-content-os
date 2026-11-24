// Guards the contract between the main application and the private render
// service on the Aliyun IMS path.
//
// The rule this file exists to protect: the IMS path must not make any editing
// decision of its own. It asks the render service for the compiled Timeline, then
// substitutes media references and nothing else. If a future change starts
// recomputing cuts or transitions here, these tests fail.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createHash } from 'node:crypto';
import {
  cachedStorageKey,
  collectTokenAssetIds,
  narrationTextFor,
  planEligibleAssets,
  resolveTimelineTokens,
  timelineReferences,
} from '../backend/providers/remote-video-ims.js';

const PREFIX = 'chensi-media-id:';

test('only auto-edit outputs are kept out of a plan, not every generated asset', () => {
  // A digital-human render is "generated" too, and it is exactly the main video a
  // vlog is built from — excluding all generated assets would remove the narration.
  // What must never be an input is an earlier auto-edit result: the algorithm
  // refuses it, and a multi-gigabyte render among the candidates is also what made
  // the asset import fail with ASSET_SIZE_INVALID.
  const project = {
    assets: [
      { id: 'a_main', mimeType: 'video/mp4', storageKey: 'u/generated/t/dh.mp4', name: '口播-subtitled.mp4', sourceType: 'generated-video', sourceOutputId: 'out_dh' },
      { id: 'a_scenery', mimeType: 'video/mp4', storageKey: 'u/assets/a_scenery/s.mp4', name: '自然风光.mp4' },
      { id: 'a_edited', mimeType: 'video/mp4', storageKey: 'u/generated/t/e.mp4', name: '新疆旅游-auto-edit.mp4', sourceOutputId: 'out_vlog' },
      { id: 'a_ims', mimeType: 'video/mp4', storageKey: 'u/generated/t/i.mp4', name: '新疆旅游-vlog-ims.mp4', sourceOutputId: 'out_vlog' },
      { id: 'a_audio', mimeType: 'audio/mpeg', storageKey: 'u/assets/a_audio/v.mp3', name: '旁白.mp3' },
      { id: 'a_nokey', mimeType: 'video/mp4', name: '未落盘.mp4' },
    ],
    outputs: [
      { id: 'out_vlog', template: 'vlog' },
      { id: 'out_dh', template: 'digital-human' },
    ],
  };

  const kept = planEligibleAssets(project).map((asset) => asset.id);
  assert.deepEqual(kept.sort(), ['a_main', 'a_scenery'],
    'the narration render and real footage stay; auto-edit results, audio and keyless assets go');
  // An auto-edit output is caught by name even without a linkable output record.
  assert.deepEqual(
    planEligibleAssets({ assets: [{ id: 'x', mimeType: 'video/mp4', storageKey: 'k', name: '某项目-auto-edit.mp4' }], outputs: [] })
      .map((asset) => asset.id),
    [],
  );
  // ...and by tag as well.
  assert.deepEqual(
    planEligibleAssets({ assets: [{ id: 'y', mimeType: 'video/mp4', storageKey: 'k', name: '片.mp4', tags: ['自动剪辑'] }], outputs: [] })
      .map((asset) => asset.id),
    [],
  );
});

test('narration text falls back so the subtitle step always has something to draw', () => {
  // A real UI submission usually leaves the subtitle box empty. Without a fallback
  // the burn step would throw at the very end, after IMS had already rendered —
  // the most expensive possible place to fail.
  assert.equal(narrationTextFor({ subtitleText: '用户填写' }, {}), '用户填写');
  assert.equal(narrationTextFor({}, { subtitleText: '方案文本' }), '方案文本');
  assert.equal(narrationTextFor({ subtitleText: '   ' }, { transcriptText: '转写文本' }), '转写文本');
  // Last resort: reassemble the segment texts the algorithm planned on.
  assert.equal(
    narrationTextFor({}, { autoMatchPlan: [{ segmentText: '第一句。' }, { segmentText: '第二句。' }] }),
    '第一句。第二句。',
  );
  // Segment entries may carry `text` instead of `segmentText`.
  assert.equal(narrationTextFor({}, { autoMatchPlan: [{ text: '甲' }, { text: '乙' }] }), '甲乙');
  assert.equal(narrationTextFor({}, {}), '');
  assert.equal(narrationTextFor({}, { autoMatchPlan: [] }), '');
});

test('the plan asset storageKey matches what the render service resolves', () => {
  // The render service stats `${sha256(tenant).slice(0,32)}/assets/<digest>.bin`
  // under its storage root (see `tenantIdentity` and `assetStorageKey` in its
  // server). Pointing at anything else makes the service reject the plan with
  // "Asset id is invalid", so the formula is pinned here.
  const tenant = 'user_mto3gwkpjbb33';
  const digest = 'a'.repeat(64);
  const expectedTenant = createHash('sha256').update(tenant, 'utf8').digest('hex').slice(0, 32);

  assert.equal(cachedStorageKey(tenant, `a_${digest}`), `${expectedTenant}/assets/${digest}.bin`);
  // The tenant prefix must not be repeated: the service resolves the key against
  // its own root, which already contains the hashed tenant directory.
  assert.equal(cachedStorageKey(tenant, `a_${digest}`).startsWith(tenant), false);
});

test('a malformed remote asset id yields no storageKey rather than a bad path', () => {
  const tenant = 'user_x';
  assert.equal(cachedStorageKey(tenant, 'not-an-asset-id'), null);
  assert.equal(cachedStorageKey(tenant, `a_${'z'.repeat(64)}`), null);
  assert.equal(cachedStorageKey(tenant, 'a_' + 'a'.repeat(63)), null);
  assert.equal(cachedStorageKey('', `a_${'a'.repeat(64)}`), null);
  // A digest is used verbatim, so no path traversal can be smuggled through.
  assert.equal(cachedStorageKey(tenant, `a_${'../'.repeat(10)}`), null);
});

/** A Timeline shaped like the compiler in the render service emits. */
function compiledTimeline() {
  return {
    VideoTracks: [{
      VideoTrackClips: [
        { MediaURL: `${PREFIX}a_main`, In: 0, Out: 1.25, TimelineIn: 0, TimelineOut: 1.25, ScaleMode: 'fit', Mute: true },
        { MediaURL: `${PREFIX}a_broll`, In: 2, Out: 5, TimelineIn: 1.25, TimelineOut: 4.25, ScaleMode: 'crop', Mute: true,
          Effects: [{ Type: 'Transition', SubType: 'wipeleft', Duration: 0.24 }] },
        // A trailing clip with no transition, which is what the compiler emits for
        // the tail shot; the substitution must leave it exactly as it is.
        { MediaURL: `${PREFIX}a_main`, In: 21, Out: 22.5, TimelineIn: 4.25, TimelineOut: 5.75, ScaleMode: 'fit', Mute: true },
      ],
    }],
    AudioTracks: [{ AudioTrackClips: [{ MediaURL: `${PREFIX}a_main`, TimelineIn: 0, TimelineOut: 5.75 }] }],
  };
}

test('collectTokenAssetIds finds tokens in every track, not just the video track', () => {
  const ids = collectTokenAssetIds(compiledTimeline(), PREFIX);
  assert.deepEqual([...ids].sort(), ['a_broll', 'a_main']);
});

test('resolveTimelineTokens substitutes media ids and changes nothing else', () => {
  const original = compiledTimeline();
  const mediaIds = new Map([['a_main', 'ims-media-main'], ['a_broll', 'ims-media-broll']]);
  const { timeline, replacedAssetIds } = resolveTimelineTokens(original, mediaIds, PREFIX);

  const clips = timeline.VideoTracks[0].VideoTrackClips;
  assert.equal(clips[0].MediaURL, 'ims-media-main');
  assert.equal(clips[1].MediaURL, 'ims-media-broll');
  assert.equal(timeline.AudioTracks[0].AudioTrackClips[0].MediaURL, 'ims-media-main');
  assert.deepEqual(replacedAssetIds.sort(), ['a_broll', 'a_main']);

  // Everything except MediaURL must survive untouched — this is the assertion
  // that catches an accidental recomputation of the edit.
  const strip = (t) => JSON.parse(JSON.stringify(t).replace(/"MediaURL":"[^"]*"/g, '"MediaURL":"X"'));
  assert.deepEqual(strip(timeline), strip(original));
  assert.notEqual(timeline, original, 'must not mutate the caller\'s object');
  assert.equal(original.VideoTracks[0].VideoTrackClips[0].MediaURL, `${PREFIX}a_main`);
});

test('a transition on the final clip is dropped, matching the local renderer', () => {
  // The ffmpeg renderer consumes only `specs[1..]` transitions, so a trailing one
  // is inert locally; IMS rejects a timeline that carries it.
  const withTrailing = compiledTimeline();
  withTrailing.VideoTracks[0].VideoTrackClips.at(-1).Effects = [{ Type: 'Transition', SubType: 'wipeup', Duration: 0.24 }];
  const mediaIds = new Map([['a_main', 'm1'], ['a_broll', 'm2']]);

  const { timeline } = resolveTimelineTokens(withTrailing, mediaIds, PREFIX);
  const clips = timeline.VideoTracks[0].VideoTrackClips;
  assert.equal(clips.at(-1).Effects, undefined, 'the last clip must carry no transition');
  assert.equal(clips.length, 3, 'no clip may be added or removed');
  // The clip before it keeps its own transition, and no timing moves.
  assert.deepEqual(clips[1].Effects, [{ Type: 'Transition', SubType: 'wipeleft', Duration: 0.24 }]);
  assert.equal(clips[2].MediaURL, 'm1');
  assert.equal(clips[2].Out, withTrailing.VideoTracks[0].VideoTrackClips[2].Out);
  assert.equal(clips[2].TimelineOut, withTrailing.VideoTracks[0].VideoTrackClips[2].TimelineOut);
});

test('an unregistered asset fails loudly instead of reaching IMS broken', () => {
  assert.throws(
    () => resolveTimelineTokens(compiledTimeline(), new Map([['a_main', 'only-main']]), PREFIX),
    (error) => error?.code === 'IMS_TIMELINE_ASSET_UNRESOLVED',
  );
});

test('non-token values pass through, so URL mode stays usable', () => {
  const withUrls = { VideoTracks: [{ VideoTrackClips: [{ MediaURL: 'https://bucket.oss-cn-shenzhen.aliyuncs.com/a.mp4', In: 0, Out: 1 }] }] };
  const { timeline, replacedAssetIds } = resolveTimelineTokens(withUrls, new Map(), PREFIX);
  assert.equal(timeline.VideoTracks[0].VideoTrackClips[0].MediaURL, withUrls.VideoTracks[0].VideoTrackClips[0].MediaURL);
  assert.deepEqual(replacedAssetIds, []);
});

test('timelineReferences matches by asset id suffix', () => {
  const timeline = compiledTimeline();
  assert.equal(timelineReferences(timeline, 'a_main'), true);
  assert.equal(timelineReferences(timeline, 'a_absent'), false);
  // Must not match a prefix or a substring of an id.
  assert.equal(timelineReferences(timeline, 'main'), false);
});
