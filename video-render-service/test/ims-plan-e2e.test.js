// End-to-end check of the plan-only path the Aliyun IMS backend depends on.
//
// It runs the real service against real (synthetic) media, then asserts the
// contract the main application consumes:
//
//   POST /v1/render-jobs { template: 'vlog-plan' }
//     -> result.output.imsTimeline   compiled Timeline, ready to execute
//     -> result.output.autoMatchPlan the decisions behind it
//     -> result.output.mediaIdTokens true, with `chensi-media-id:` placeholders
//
// A plain `node --test` import sees `vm.SourceTextModule` as unavailable, so the
// file re-execs itself with the flag only when it is actually imported.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

if (typeof vm.SourceTextModule !== 'function' && !process.env.DSH_PLAN_E2E_REEXEC) {
  const result = spawnSync(
    process.execPath,
    ['--experimental-vm-modules', '--no-warnings', new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')],
    { stdio: 'inherit', env: { ...process.env, DSH_PLAN_E2E_REEXEC: '1' } },
  );
  process.exit(result.status ?? 1);
}

const { createRenderService } = await import('../src/server.js');
const { getProviderConfig } = await import('../src/providers/config.js');
const { runCommand } = await import('../src/providers/media.js');

const API_KEY = 'plan-e2e-secret';
const TENANT = 'tenant-plan-e2e';

async function request(baseUrl, pathname, options = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { authorization: `Bearer ${API_KEY}`, 'x-render-tenant': TENANT, ...options.headers },
  });
}

/**
 * Generate a clip of `seconds` length.
 *
 * `label` is burned in because the auto-editor identifies source material by
 * content (sha256 / visual fingerprint), not by asset id: two clips rendered from
 * the same lavfi pattern are byte-identical and would be treated as one asset,
 * which makes the planner report insufficient material.
 */
async function makeClip(file, seconds, { tone = false, pattern = 'testsrc2', label = '' } = {}) {
  const args = ['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', `${pattern}=size=320x568:rate=30:duration=${seconds}`];
  if (tone) args.push('-f', 'lavfi', '-i', `sine=frequency=320:duration=${seconds}`);
  if (label) args.push('-vf', `drawtext=text='${label}':fontcolor=white:fontsize=48:x=20:y=20`);
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-t', String(seconds), '-pix_fmt', 'yuv420p');
  if (tone) args.push('-c:a', 'aac', '-b:a', '96k', '-shortest');
  args.push(file);
  await runCommand('ffmpeg', args, { timeoutMs: 120_000 });
}

/** Attach the synthetic audio track a normal uploaded video would have. */
async function withAudio(file) {
  const output = `${file}.audio.mp4`;
  await runCommand('ffmpeg', [
    '-hide_banner', '-nostdin', '-y', '-i', file,
    '-f', 'lavfi', '-i', 'sine=frequency=320:duration=1',
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '96k', '-shortest', output,
  ], { timeoutMs: 120_000 });
  return output;
}

/** Upload one clip and return the reference the render job expects. */
async function uploadAsset(baseUrl, { id, file, autoEditCategory }) {
  const buffer = await readFile(file);
  const { createHash } = await import('node:crypto');
  const sha256 = createHash('sha256').update(buffer).digest('hex');

  const prepare = await request(baseUrl, '/v1/assets/prepare', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sha256, sizeBytes: buffer.length, name: path.basename(file), mimeType: 'video/mp4' }),
  });
  assert.equal(prepare.status, 200);
  const prepared = await prepare.json();

  if (!prepared.exists) {
    const upload = await request(baseUrl, prepared.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'video/mp4', 'content-length': String(buffer.length) },
      body: buffer,
    });
    assert.equal(upload.status, 201);
  }

  // `assetId` is `a_<sha256>`, so the service's cached path is derivable.
  return {
    id,
    remoteAssetId: prepared.assetId,
    storageKey: `${TENANT}/assets/${sha256}.bin`,
    name: path.basename(file),
    mimeType: 'video/mp4',
    autoEditCategory,
    sizeBytes: buffer.length,
    sha256,
  };
}

test('vlog-plan returns a compiled IMS timeline that carries media-id tokens', async (t) => {
  const temp = await mkdtemp(path.join(tmpdir(), 'plan-e2e-'));
  const previous = {
    VIDEO_RENDER_STORAGE_ROOT: process.env.VIDEO_RENDER_STORAGE_ROOT,
    VIDEO_RENDER_OSS_PUBLIC_BASE: process.env.VIDEO_RENDER_OSS_PUBLIC_BASE,
    VIDEO_RENDER_API_KEY: process.env.VIDEO_RENDER_API_KEY,
    VIDEO_RENDER_API_KEYS: process.env.VIDEO_RENDER_API_KEYS,
  };
  process.env.VIDEO_RENDER_STORAGE_ROOT = path.join(temp, 'storage');
  process.env.VIDEO_RENDER_API_KEY = API_KEY;
  process.env.VIDEO_RENDER_API_KEYS = API_KEY;
  // Unset so the resolver takes the token branch, which is what production uses
  // (the real bucket is private and IMS refuses CDN-authed links).
  delete process.env.VIDEO_RENDER_OSS_PUBLIC_BASE;

  const config = getProviderConfig();
  const server = createRenderService({
    config,
    logger: { info() {}, warn() {}, error() {} },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(temp, { recursive: true, force: true });
  });

  // The auto-editor refuses to repeat a shot, so the b-roll pool has to be long
  // enough to cover the main video's narration. Eight clips over ~40 s is a
  // realistic small project and keeps the whole test under a few seconds.
  const mainFile = path.join(temp, 'main.mp4');
  await makeClip(mainFile, 40, { tone: true, label: 'MAIN' });
  const brolls = [];
  for (let index = 0; index < 8; index += 1) {
    const file = path.join(temp, `broll-${index}.mp4`);
    // One ffmpeg pass with a full-length tone: re-muxing a short silent track over
    // the clip would truncate it via -shortest and starve the shot planner.
    await makeClip(file, 14, { pattern: index % 2 === 0 ? 'smptebars' : 'testsrc', label: `B${index}`, tone: true });
    brolls.push(file);
  }

  const main = await uploadAsset(baseUrl, { id: 'a_main', file: mainFile, autoEditCategory: '' });
  const brollRefs = [];
  for (const [index, file] of brolls.entries()) {
    brollRefs.push(await uploadAsset(baseUrl, { id: `a_broll_${index}`, file, autoEditCategory: 'scenery' }));
  }

  const create = await request(baseUrl, '/v1/render-jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      template: 'vlog-plan',
      input: {
        template: 'vlog',
        videoAssetIds: ['a_main'],
        ratio: '9:16',
        subtitleText: [
          '今天的赛里木湖天气很好，湖边风很大。建议早点出发避开人流。',
          '第一站先去东岸的观景台，那里的视野最开阔，能看到整片湖面。',
          '中午在湖边吃一顿简餐，下午再去果子沟大桥看日落。',
          '回程路上会经过一片薰衣草田，七八月份开得最好。',
        ].join(''),
        transcriptWords: [],
        hdFilter: false,
      },
      project: { id: 'project-plan-e2e', name: 'plan-e2e', assets: [main, ...brollRefs], outputs: [] },
    }),
  });
  // Read the body exactly once: an assertion message that also reads it would
  // consume the stream and make the next `.json()` fail.
  const createBody = await create.text();
  assert.equal(create.status, 202, createBody);
  let job = JSON.parse(createBody);

  const deadline = Date.now() + 180_000;
  while (!['completed', 'failed', 'canceled'].includes(job.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    job = await (await request(baseUrl, `/v1/render-jobs/${job.id}`)).json();
  }
  assert.equal(job.status, 'completed', JSON.stringify(job.error));

  const output = job.result?.output;
  assert.ok(output, 'plan-only result must carry an output object');

  // --- the contract the IMS executor relies on ---------------------------------
  assert.equal(output.planOnly, true, 'this path must not claim to have rendered a file');
  // `cleanOutput` drops empty fields, so the key is absent rather than null — what
  // matters is that no file is claimed.
  assert.ok(!output.storageKey, `no file is produced, so there must be no storage key (got ${output.storageKey})`);
  assert.equal(output.mediaIdTokens, true, 'tokens are what production consumes');
  assert.equal(output.mediaIdTokenPrefix, 'chensi-media-id:');
  assert.ok(Array.isArray(output.imsTimeline?.VideoTracks?.[0]?.VideoTrackClips), 'compiled Timeline must be present');
  assert.ok(Array.isArray(output.autoMatchPlan) && output.autoMatchPlan.length, 'decisions must be present');
  assert.equal(output.segmentCount, output.autoMatchPlan.length);

  // Every media reference is a token and every token belongs to a known asset.
  const knownIds = new Set([main.id, ...brollRefs.map((item) => item.id)]);
  const tokenIds = new Set();
  for (const clip of output.imsTimeline.VideoTracks[0].VideoTrackClips) {
    assert.match(clip.MediaURL, /^chensi-media-id:/, `unexpected MediaURL ${clip.MediaURL}`);
    const assetId = clip.MediaURL.slice('chensi-media-id:'.length);
    assert.ok(knownIds.has(assetId), `Timeline cites unknown asset ${assetId}`);
    tokenIds.add(assetId);
    // Bounds must be paired; an unpaired In/Out makes IMS bill the whole asset.
    assert.equal(typeof clip.In, 'number');
    assert.equal(typeof clip.Out, 'number');
    assert.equal(typeof clip.TimelineIn, 'number');
    assert.equal(typeof clip.TimelineOut, 'number');
    assert.ok(clip.Out > clip.In, 'clip must have positive duration');
  }
  assert.ok(tokenIds.has(main.id), 'the main video must appear in the Timeline');

  // The algorithm decided on cuts, not on one long clip.
  assert.ok(output.autoMatchPlan.length >= 1);
  for (const item of output.autoMatchPlan) {
    assert.ok(knownIds.has(String(item.assetId)), `plan cites unknown asset ${item.assetId}`);
    assert.ok(Number(item.timelineEndSeconds) > Number(item.timelineStartSeconds), 'plan segments must advance');
  }

  // A transition may not sit on the last clip: there is nothing to transition into.
  const last = output.imsTimeline.VideoTracks[0].VideoTrackClips.at(-1);
  assert.equal(last.Effects, undefined, 'the final clip must not carry a transition');
});
