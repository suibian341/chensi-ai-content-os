import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRenderService } from '../src/server.js';
import { getProviderConfig } from '../src/providers/config.js';
import { runCommand } from '../src/providers/media.js';
import { serviceAccessUrls } from '../src/lib/network.js';

function digest(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

test('wildcard binding reports local and LAN access URLs', () => {
  const urls = serviceAccessUrls({
    host: '0.0.0.0',
    port: 4399,
    interfaces: {
      Loopback: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
      Ethernet: [{ family: 'IPv4', address: '192.168.10.25', internal: false }],
      Virtual: [{ family: 4, address: '10.0.0.8', internal: false }],
    },
  });
  assert.deepEqual(urls, [
    { scope: 'local', url: 'http://127.0.0.1:4399' },
    { scope: 'lan', url: 'http://192.168.10.25:4399' },
    { scope: 'lan', url: 'http://10.0.0.8:4399' },
  ]);
});

test('authenticated asset import streams HTTPS sources, verifies integrity, caches per tenant, and isolates tenants', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'chensi-render-import-'));
  const previousStorageRoot = process.env.VIDEO_RENDER_STORAGE_ROOT;
  process.env.VIDEO_RENDER_STORAGE_ROOT = path.join(temp, 'storage');
  const config = getProviderConfig();
  config.service.apiKeys = ['test-render-secret'];
  config.service.assetImportTimeoutMs = 5_000;
  config.storage.root = path.join(temp, 'storage');
  const content = Buffer.from(`remote-object-storage-video-content:${temp}`);
  const sha256 = digest(content);
  const fetchCalls = [];
  const fetchImpl = async (url) => {
    fetchCalls.push(String(url));
    return new Response(content, {
      status: 200,
      headers: { 'content-type': 'video/mp4', 'content-length': String(content.length) },
    });
  };
  const server = createRenderService({ config, fetchImpl, logger: { info() {}, warn() {}, error() {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(temp, { recursive: true, force: true });
    if (previousStorageRoot === undefined) delete process.env.VIDEO_RENDER_STORAGE_ROOT;
    else process.env.VIDEO_RENDER_STORAGE_ROOT = previousStorageRoot;
  });

  const importBody = JSON.stringify({
    sourceUrl: 'https://oss.example.com/signed/video.mp4?signature=test',
    sha256,
    sizeBytes: content.length,
    name: 'video.mp4',
    mimeType: 'video/mp4',
  });
  const first = await request(baseUrl, 'test-render-secret', 'tenant-a', '/v1/assets/import', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: importBody,
  });
  assert.equal(first.status, 201);
  const imported = await first.json();
  assert.equal(imported.assetId, `a_${sha256}`);
  assert.equal(imported.sha256, sha256);
  assert.equal(imported.exists, false);

  const cached = await request(baseUrl, 'test-render-secret', 'tenant-a', '/v1/assets/import', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: importBody,
  });
  assert.equal(cached.status, 200);
  assert.equal((await cached.json()).exists, true);
  assert.equal(fetchCalls.length, 1);

  const isolated = await request(baseUrl, 'test-render-secret', 'tenant-b', '/v1/assets/import', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: importBody,
  });
  assert.equal(isolated.status, 201);
  assert.equal(fetchCalls.length, 2);

  const badHash = await request(baseUrl, 'test-render-secret', 'tenant-a', '/v1/assets/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sourceUrl: 'https://oss.example.com/signed/bad.mp4',
      sha256: '0'.repeat(64),
      sizeBytes: content.length,
    }),
  });
  assert.equal(badHash.status, 400);
  assert.equal((await badHash.json()).error.code, 'ASSET_INTEGRITY_FAILED');

  const insecure = await request(baseUrl, 'test-render-secret', 'tenant-a', '/v1/assets/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceUrl: 'http://127.0.0.1/video.mp4', sizeBytes: content.length }),
  });
  assert.equal(insecure.status, 400);
  assert.equal((await insecure.json()).error.code, 'ASSET_IMPORT_URL_INVALID');
});

async function request(baseUrl, apiKey, tenant, pathname, options = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      authorization: `Bearer ${apiKey}`,
      'x-render-tenant': tenant,
      ...options.headers,
    },
  });
}

test('authenticated service caches assets and renders a range-capable real video', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'chensi-render-service-'));
  const previous = {
    VIDEO_RENDER_STORAGE_ROOT: process.env.VIDEO_RENDER_STORAGE_ROOT,
    VIDEO_RENDER_API_KEY: process.env.VIDEO_RENDER_API_KEY,
    VIDEO_RENDER_API_KEYS: process.env.VIDEO_RENDER_API_KEYS,
    VIDEO_RENDER_JOB_TIMEOUT_MS: process.env.VIDEO_RENDER_JOB_TIMEOUT_MS,
  };
  process.env.VIDEO_RENDER_STORAGE_ROOT = path.join(temp, 'storage');
  process.env.VIDEO_RENDER_API_KEY = 'test-render-secret';
  process.env.VIDEO_RENDER_API_KEYS = 'test-render-secret';
  process.env.VIDEO_RENDER_JOB_TIMEOUT_MS = '120000';

  const config = getProviderConfig();
  const logLines = [];
  const captureLog = (message) => logLines.push(String(message));
  const server = createRenderService({
    config,
    logger: { info: captureLog, warn: captureLog, error: captureLog },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(temp, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const unauthorized = await fetch(`${baseUrl}/v1/render-jobs/not-a-job`);
  assert.equal(unauthorized.status, 401);

  const mainPath = path.join(temp, 'main.mp4');
  const brollPath = path.join(temp, 'product.mp4');
  const musicPath = path.join(temp, 'ambient-test.wav');
  await runCommand('ffmpeg', [
    '-hide_banner', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=30:d=1.2',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-shortest',
    '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', '-y', mainPath,
  ], { timeoutMs: 30_000 });
  await runCommand('ffmpeg', [
    '-hide_banner', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=30:d=1.2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', brollPath,
  ], { timeoutMs: 30_000 });
  await runCommand('ffmpeg', [
    '-hide_banner', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', '-y', musicPath,
  ], { timeoutMs: 30_000 });

  const musicBuffer = await fs.readFile(musicPath);
  const musicUpload = await request(baseUrl, 'test-render-secret', 'music-admin', '/v1/background-music', {
    method: 'POST',
    headers: {
      'content-type': 'audio/wav',
      'content-length': String(musicBuffer.length),
      'x-background-music-name': encodeURIComponent('Ambient Test Track.wav'),
    },
    body: musicBuffer,
  });
  assert.equal(musicUpload.status, 201);
  const music = await musicUpload.json();
  assert.match(music.id, /^bgm_[a-f0-9]{32}$/);
  assert.equal(music.name, 'Ambient Test Track.wav');
  assert.ok(music.durationSeconds >= 1.9);
  const musicList = await request(baseUrl, 'test-render-secret', 'another-user', '/v1/background-music');
  assert.deepEqual((await musicList.json()).items.map((item) => item.id), [music.id]);
  const musicHead = await request(baseUrl, 'test-render-secret', 'another-user', music.contentUrl, { method: 'HEAD' });
  assert.equal(musicHead.status, 200);
  assert.equal(Number(musicHead.headers.get('content-length')), musicBuffer.length);

  const tenant = 'tenant-service-test';
  const uploaded = [];
  for (const [id, filePath, name] of [['main', mainPath, 'main.mp4'], ['broll', brollPath, 'product.mp4']]) {
    const buffer = await fs.readFile(filePath);
    const sha256 = digest(buffer);
    const prepare = await request(baseUrl, 'test-render-secret', tenant, '/v1/assets/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sha256, sizeBytes: buffer.length, name, mimeType: 'video/mp4' }),
    });
    assert.equal(prepare.status, 200);
    const prepared = await prepare.json();
    assert.equal(prepared.exists, false);
    const upload = await request(baseUrl, 'test-render-secret', tenant, prepared.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'video/mp4', 'content-length': String(buffer.length) },
      body: buffer,
    });
    assert.equal(upload.status, 201);
    uploaded.push({
      id,
      remoteAssetId: prepared.assetId,
      name,
      mimeType: 'video/mp4',
      autoEditCategory: id === 'broll' ? 'product' : '',
      sha256,
    });

    const cached = await request(baseUrl, 'test-render-secret', tenant, '/v1/assets/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sha256, sizeBytes: buffer.length, name, mimeType: 'video/mp4' }),
    });
    assert.equal((await cached.json()).exists, true);
  }

  const create = await request(baseUrl, 'test-render-secret', tenant, '/v1/render-jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      template: 'vlog',
      input: {
        template: 'vlog',
        videoAssetIds: ['main'],
        transcriptWords: [{ word: 'product', start: 0.2, end: 1 }],
        subtitleText: 'product',
        subtitleEmphasis: false,
        materialStartSeconds: 0.2,
        sourceTailSeconds: 0.2,
        ratio: '1:1',
        backgroundMusicId: music.id,
        backgroundMusicVolume: 0.4,
      },
      project: { id: 'project-test', name: 'service-test', assets: uploaded, outputs: [] },
    }),
  });
  assert.equal(create.status, 202);
  let job = await create.json();
  const observedProgress = [job.progress];
  const deadline = Date.now() + 120_000;
  while (!['completed', 'failed', 'canceled'].includes(job.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const status = await request(baseUrl, 'test-render-secret', tenant, `/v1/render-jobs/${job.id}`);
    assert.equal(status.status, 200);
    job = await status.json();
    observedProgress.push(job.progress);
  }
  assert.equal(job.status, 'completed', JSON.stringify(job.error));
  assert.equal(job.progress, 100);
  assert.ok(observedProgress.some((value) => value >= 40 && value < 100));
  assert.equal(job.result.output.storageKey, undefined);
  assert.equal(job.result.output.filePath, undefined);
  assert.equal(job.result.output.algorithm, undefined);
  assert.equal(job.result.output.segmentCount, 1);
  assert.equal(job.result.output.backgroundMusicId, music.id);
  assert.equal(job.result.output.backgroundMusicName, music.name);
  assert.equal(job.result.output.backgroundMusicVolume, 0.4);
  assert.equal(job.result.output.autoMatchPlan[0].semanticScore, undefined);
  assert.equal(job.result.output.autoMatchPlan[0].selectionOrigin, undefined);
  assert.ok(logLines.some((line) => line.includes('asset.prepared') && line.includes('cache="miss"')));
  assert.ok(logLines.some((line) => line.includes('asset.upload.completed')));
  assert.ok(logLines.some((line) => line.includes('job.queued')));
  assert.ok(logLines.some((line) => line.includes('job.started')));
  assert.ok(logLines.some((line) => line.includes('job.progress') && line.includes('progress=100')));
  assert.ok(logLines.some((line) => line.includes('job.completed') && line.includes('outputBytes=')));
  assert.equal(logLines.some((line) => line.includes('test-render-secret')), false);

  const isolated = await request(baseUrl, 'test-render-secret', 'another-tenant', `/v1/render-jobs/${job.id}`);
  assert.equal(isolated.status, 404);

  const range = await request(baseUrl, 'test-render-secret', tenant, job.result.output.contentUrl, {
    headers: { range: 'bytes=0-99' },
  });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 100);
  assert.match(range.headers.get('content-range') || '', /^bytes 0-99\//);

  // A direct client keeps relative result URLs; a proxied client gets absolute ones.
  assert.match(job.result.output.contentUrl, /^\/v1\/render-jobs\//);
  const proxiedStatus = await request(baseUrl, 'test-render-secret', tenant, `/v1/render-jobs/${job.id}`, {
    headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'render.example.com' },
  });
  assert.equal(proxiedStatus.status, 200);
  const proxiedJob = await proxiedStatus.json();
  assert.equal(proxiedJob.result.output.contentUrl, job.result.output.contentUrl);
  if (job.result.output.subtitleUrl) {
    assert.equal(proxiedJob.result.output.subtitleUrl, job.result.output.subtitleUrl);
  }

  const renderedPath = path.join(temp, 'rendered-with-music.mp4');
  const renderedResponse = await request(baseUrl, 'test-render-secret', tenant, job.result.output.contentUrl);
  await fs.writeFile(renderedPath, Buffer.from(await renderedResponse.arrayBuffer()));
  const volumeProbe = await runCommand('ffmpeg', [
    '-hide_banner', '-i', renderedPath, '-af', 'volumedetect', '-f', 'null', '-',
  ], { timeoutMs: 30_000 });
  const maxVolume = Number(volumeProbe.stderr.match(/max_volume:\s*(-?[\d.]+) dB/i)?.[1]);
  assert.ok(Number.isFinite(maxVolume) && maxVolume > -60, `expected audible background music, received ${maxVolume} dB`);

  const released = await request(baseUrl, 'test-render-secret', tenant, `/v1/render-jobs/${job.id}`, { method: 'DELETE' });
  assert.equal(released.status, 200);
  assert.equal((await released.json()).released, true);
  assert.equal((await request(baseUrl, 'test-render-secret', tenant, `/v1/render-jobs/${job.id}`)).status, 404);
  assert.equal((await request(baseUrl, 'test-render-secret', tenant, job.result.output.contentUrl)).status, 404);
  assert.ok(logLines.some((line) => line.includes('job.released')));

  const removedMusic = await request(baseUrl, 'test-render-secret', 'music-admin', `/v1/background-music/${music.id}`, { method: 'DELETE' });
  assert.equal(removedMusic.status, 200);
  const deletedMusicContent = await request(baseUrl, 'test-render-secret', 'music-admin', music.contentUrl);
  assert.equal(deletedMusicContent.status, 404);

  const missingMusicCreate = await request(baseUrl, 'test-render-secret', tenant, '/v1/render-jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      template: 'vlog',
      input: { template: 'vlog', videoAssetIds: ['main'], backgroundMusicId: music.id, backgroundMusicVolume: 0.2 },
      project: { id: 'missing-music', name: 'missing-music', assets: [uploaded[0]], outputs: [] },
    }),
  });
  assert.equal(missingMusicCreate.status, 409);

  const cancelCreate = await request(baseUrl, 'test-render-secret', tenant, '/v1/render-jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      template: 'talking-head',
      input: { template: 'talking-head', videoAssetIds: ['main'], ratio: '1:1' },
      project: { id: 'cancel-project', name: 'cancel-test', assets: [uploaded[0]], outputs: [] },
    }),
  });
  const cancelJob = await cancelCreate.json();
  const canceled = await request(baseUrl, 'test-render-secret', tenant, `/v1/render-jobs/${cancelJob.id}`, { method: 'DELETE' });
  assert.equal(canceled.status, 202);
  let canceledState = await canceled.json();
  const cancelDeadline = Date.now() + 5_000;
  while (canceledState.status !== 'canceled' && Date.now() < cancelDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    canceledState = await (await request(baseUrl, 'test-render-secret', tenant, `/v1/render-jobs/${cancelJob.id}`)).json();
  }
  assert.equal(canceledState.status, 'canceled');
  assert.ok(logLines.some((line) => line.includes('job.cancel')));
});
