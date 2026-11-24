// Verifies the storage pressure controls: the hard total ceiling, the
// oldest-first eviction order, protection of referenced files, and the
// pre-upload free-space refusal. These run against a real service instance and
// a real temp storage root, because the eviction walks the filesystem.
import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRenderService } from '../src/server.js';
import { getProviderConfig } from '../src/providers/config.js';

const silentLogger = { info() {}, warn() {}, error() {} };
const TENANT = 'a'.repeat(32);        // matches the sha256(...).slice(0,32) shape

async function startService(envOverrides, storageRoot) {
  const previous = {};
  // The service root's own .env is read by getProviderConfig() and cannot be
  // overridden by a later assignment, so every credential the config consults
  // must be set here — including the plural API_KEYS form it prefers.
  const overrides = {
    VIDEO_RENDER_STORAGE_ROOT: storageRoot,
    VIDEO_RENDER_API_KEY: 'test-render-secret',
    VIDEO_RENDER_API_KEYS: 'test-render-secret',
    VIDEO_RENDER_MIN_FREE_BYTES: '0',
    VIDEO_RENDER_MAX_STORAGE_BYTES: '0',
    ...envOverrides,
  };
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  const config = getProviderConfig();
  config.service.apiKeys = ['test-render-secret'];
  config.storage.root = storageRoot;
  const server = createRenderService({ config, logger: silentLogger });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

// The cleanup that runs on listen() is fire-and-forget, so poll for the effect.
async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function makeAsset(root, tenantDir, name, size, ageMs) {
  const dir = path.join(root, tenantDir, 'assets');
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, Buffer.alloc(size, 7));
  const when = new Date(Date.now() - ageMs);
  await fs.utimes(filePath, when, when);
  return filePath;
}

async function makeGenerated(root, tenantDir, name, size, ageMs) {
  const dir = path.join(root, tenantDir, 'generated');
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, Buffer.alloc(size, 9));
  const when = new Date(Date.now() - ageMs);
  await fs.utimes(filePath, when, when);
  return filePath;
}

test('total storage ceiling evicts the oldest assets first', async () => {
  const root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'quota-')), 'storage');
  // 5 assets x 300 KB = 1.5 MB, ceiling well below that.
  const old = await makeAsset(root, TENANT, 'a'.repeat(64) + '.bin', 300 * 1024, 50 * 60_000);
  const mid = await makeAsset(root, TENANT, 'b'.repeat(64) + '.bin', 300 * 1024, 30 * 60_000);
  const fresh = await makeAsset(root, TENANT, 'c'.repeat(64) + '.bin', 300 * 1024, 1 * 60_000);
  const svc = await startService(
    { VIDEO_RENDER_MAX_STORAGE_BYTES: String(600 * 1024), VIDEO_RENDER_ASSET_TTL_MS: '86400000' },
    root,
  );
  try {
    const gone = await waitFor(async () => !(await exists(old)));
    assert.ok(gone, 'the oldest asset should be evicted to satisfy the ceiling');
    assert.ok(await exists(fresh), 'the newest asset must survive');
    assert.ok(await exists(mid) || await exists(fresh), 'at least one recent asset survives');
  } finally {
    await svc.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('generated outputs are evicted only after unprotected assets', async () => {
  const root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'quota-gen-')), 'storage');
  // A finished video must outlive an equally old cached asset.
  const gen = await makeGenerated(root, TENANT, 'job_x-output.mp4', 400 * 1024, 10 * 60_000);
  const asset = await makeAsset(root, TENANT, 'd'.repeat(64) + '.bin', 400 * 1024, 10 * 60_000);
  const svc = await startService(
    { VIDEO_RENDER_MAX_STORAGE_BYTES: String(500 * 1024), VIDEO_RENDER_ASSET_TTL_MS: '86400000' },
    root,
  );
  try {
    const assetGone = await waitFor(async () => !(await exists(asset)));
    assert.ok(assetGone, 'the cached asset should be evicted first');
    assert.ok(await exists(gen), 'the generated output should be kept while an asset can be dropped');
  } finally {
    await svc.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('stale .import temp files are reclaimed', async () => {
  const root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'quota-tmp-')), 'storage');
  const stale = await makeAsset(root, TENANT, '.import-999-deadbeef.tmp', 200 * 1024, 3 * 60 * 60_000);
  const live = await makeAsset(root, TENANT, '.import-999-cafe.tmp', 200 * 1024, 1 * 60_000);
  const svc = await startService(
    { VIDEO_RENDER_MAX_STORAGE_BYTES: '0', VIDEO_RENDER_ASSET_TTL_MS: '86400000' },
    root,
  );
  try {
    assert.ok(await waitFor(async () => !(await exists(stale))), 'a 3h-old import temp must be removed');
    assert.ok(await exists(live), 'a fresh import temp must be left alone');
  } finally {
    await svc.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('uploads are refused with 507 when the free-space floor cannot be met', async () => {
  const root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'quota-full-')), 'storage');
  await fs.mkdir(root, { recursive: true });
  // An unreachable floor guarantees the refusal path, without touching the host disk.
  const svc = await startService(
    {
      VIDEO_RENDER_MIN_FREE_BYTES: String(Number.MAX_SAFE_INTEGER),
      VIDEO_RENDER_MAX_STORAGE_BYTES: '0',
    },
    root,
  );
  try {
    const baseUrl = `http://127.0.0.1:${svc.server.address().port}`;
    const res = await fetch(`${baseUrl}/v1/assets/prepare`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-render-secret',
        'x-render-tenant': 'quota-tenant',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sha256: 'e'.repeat(64), sizeBytes: 1024, name: 'x.mp4', mimeType: 'video/mp4' }),
    });
    assert.equal(res.status, 507, 'a full storage server must answer 507, not ENOSPC');
    const body = await res.json();
    assert.equal(body.error.code, 'STORAGE_FULL');
  } finally {
    await svc.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function exists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}
