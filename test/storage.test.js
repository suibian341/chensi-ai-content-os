import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createDirectUpload, readAssetFile, resolveStorageKey, saveAssetFile, saveDirectUploadStream, signedReadUrl, statStoredObject } from '../backend/lib/storage.js';

test('asset storage writes bytes and rejects escaping keys', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'domestic-ip-storage-'));
  const previous = process.env.IP_AGENT_STORAGE_ROOT;
  process.env.IP_AGENT_STORAGE_ROOT = root;
  t.after(async () => {
    previous === undefined ? delete process.env.IP_AGENT_STORAGE_ROOT : process.env.IP_AGENT_STORAGE_ROOT = previous;
    await fs.rm(root, { recursive: true, force: true });
  });

  const stored = await saveAssetFile({ projectId: 'p_test', assetId: 'a_test', name: '../测试.txt', data: Buffer.from('hello').toString('base64') });
  assert.equal(stored.sizeBytes, 5);
  assert.equal(stored.sha256.length, 64);
  const loaded = await readAssetFile({ storageKey: stored.storageKey });
  assert.equal(loaded.data.toString('utf8'), 'hello');
  assert.throws(() => resolveStorageKey('../outside.txt'), /路径/);
});

test('local direct upload streams bytes without Base64 buffering', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'domestic-ip-direct-storage-'));
  const previous = process.env.IP_AGENT_STORAGE_ROOT;
  process.env.IP_AGENT_STORAGE_ROOT = root;
  t.after(async () => {
    previous === undefined ? delete process.env.IP_AGENT_STORAGE_ROOT : process.env.IP_AGENT_STORAGE_ROOT = previous;
    await fs.rm(root, { recursive: true, force: true });
  });

  const descriptor = await createDirectUpload({
    userId: 'user_test', projectId: 'p_test', assetId: 'a_direct',
    name: 'sample.mp4', mimeType: 'video/mp4', sizeBytes: 6,
  });
  assert.equal(descriptor.driver, 'local');
  assert.match(descriptor.storageKey, /^users\/user_test\/projects\/p_test\/assets\/a_direct\//);
  const saved = await saveDirectUploadStream({
    storageKey: descriptor.storageKey,
    stream: Readable.from([Buffer.from('stream')]),
    sizeBytes: 6,
    mimeType: 'video/mp4',
  });
  assert.equal(saved.sha256.length, 64);
  const meta = await statStoredObject({ storageKey: descriptor.storageKey, mimeType: 'video/mp4' });
  assert.equal(meta.sizeBytes, 6);
});

test('OSS mode issues browser upload and CDN read URLs without exposing credentials', async (t) => {
  const names = ['IP_AGENT_STORAGE_DRIVER', 'ALIYUN_OSS_REGION', 'ALIYUN_OSS_BUCKET', 'ALIYUN_OSS_ACCESS_KEY_ID', 'ALIYUN_OSS_ACCESS_KEY_SECRET', 'ALIYUN_CDN_DOMAIN', 'ALIYUN_CDN_AUTH_KEY'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    IP_AGENT_STORAGE_DRIVER: 'oss',
    ALIYUN_OSS_REGION: 'oss-cn-shenzhen',
    ALIYUN_OSS_BUCKET: 'commercial-private-bucket',
    ALIYUN_OSS_ACCESS_KEY_ID: 'test-access-key-id',
    ALIYUN_OSS_ACCESS_KEY_SECRET: 'test-access-key-secret',
    ALIYUN_CDN_DOMAIN: 'media.example.com',
    ALIYUN_CDN_AUTH_KEY: 'test-cdn-auth-key',
  });
  t.after(() => names.forEach((name) => {
    previous[name] === undefined ? delete process.env[name] : process.env[name] = previous[name];
  }));

  const descriptor = await createDirectUpload({
    userId: 'user_oss', projectId: 'project_oss', assetId: 'asset_oss',
    name: 'commercial.mp4', mimeType: 'video/mp4', sizeBytes: 1024,
  });
  assert.equal(descriptor.driver, 'oss');
  assert.match(descriptor.uploadUrl, /^https:\/\/commercial-private-bucket\.oss-cn-shenzhen\.aliyuncs\.com\//);
  assert.equal(descriptor.uploadUrl.includes('test-access-key-secret'), false);
  assert.equal(descriptor.headers['Content-Type'], 'video/mp4');
  assert.equal(descriptor.headers['Cache-Control'], 'public, max-age=31536000, immutable');
  const readUrl = signedReadUrl({ storageKey: descriptor.storageKey });
  assert.match(readUrl, /^https:\/\/media\.example\.com\/.+\?auth_key=/);
  assert.equal(readUrl.includes('test-cdn-auth-key'), false);
});
