// Verifies the two production fixes:
//   1. fromAsset() must NOT read asset bytes into the heap (no `data` field).
//   2. auto-edit must bound how many candidate assets are resolved at once.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { findSource } from '../src/providers/media.js';
import { CANDIDATE_READ_CONCURRENCY, CANDIDATE_PROBE_CONCURRENCY } from '../src/video-engine/tiktok-vlog.js';

const TENANT_DIR = 'patchcheck';
let root;

test.before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'render-patch-'));
  process.env.VIDEO_RENDER_STORAGE_ROOT = root;
});

test.after(async () => {
  delete process.env.VIDEO_RENDER_STORAGE_ROOT;
  await rm(root, { recursive: true, force: true });
});

test('findSource resolves an asset to a path without loading its bytes', async () => {
  // A file large enough that reading it would be obvious in RSS.
  const bytes = Buffer.alloc(12 * 1024 * 1024, 7);
  const storageKey = `${TENANT_DIR}/assets/big.mp4`;
  const filePath = path.join(root, storageKey);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, bytes);

  const before = process.memoryUsage().rss;
  const source = await findSource({
    assetId: 'a_big',
    assets: [{ id: 'a_big', name: 'big.mp4', mimeType: 'video/mp4', storageKey }],
    mimePrefix: 'video/',
    timeoutMs: 5_000,
  });
  const after = process.memoryUsage().rss;

  assert.equal(source.filePath, filePath, 'must resolve the real path');
  assert.equal(source.assetId, 'a_big');
  assert.equal(source.data, undefined, 'data must not be populated');
  assert.ok(await stat(source.filePath), 'resolved path must exist');

  const grewMb = (after - before) / 1024 / 1024;
  assert.ok(grewMb < 8, `RSS grew ${grewMb.toFixed(1)} MB; a read would add >=12 MB`);
});

test('findSource still rejects an asset whose file is gone', async () => {
  await assert.rejects(
    () => findSource({
      assetId: 'a_missing',
      assets: [{ id: 'a_missing', name: 'gone.mp4', mimeType: 'video/mp4', storageKey: `${TENANT_DIR}/assets/gone.mp4` }],
      mimePrefix: 'video/',
      timeoutMs: 5_000,
    }),
    'a missing asset file must still surface an error, not a phantom path',
  );
});

test('candidate fan-out is bounded well below the 208-asset case seen in production', () => {
  assert.ok(CANDIDATE_READ_CONCURRENCY >= 1 && CANDIDATE_READ_CONCURRENCY <= 16,
    `read concurrency ${CANDIDATE_READ_CONCURRENCY} should be a small fixed number`);
  assert.ok(CANDIDATE_PROBE_CONCURRENCY >= 1 && CANDIDATE_PROBE_CONCURRENCY <= 32,
    `probe concurrency ${CANDIDATE_PROBE_CONCURRENCY} should be a small fixed number`);
  // The regression was 207 simultaneous probes; assert we are far below that.
  assert.ok(CANDIDATE_PROBE_CONCURRENCY < 50,
    'probe concurrency must not scale with the asset library size');
});
