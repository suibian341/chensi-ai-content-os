import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { saveGeneratedImageAsset } from '../backend/lib/generated-image.js';
import { readAssetFile } from '../backend/lib/storage.js';

test('generated image is saved locally and added to the asset library once', async (t) => {
  const previousRoot = process.env.IP_AGENT_STORAGE_ROOT;
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'chensi-generated-image-'));
  process.env.IP_AGENT_STORAGE_ROOT = storageRoot;
  t.after(async () => {
    if (previousRoot === undefined) delete process.env.IP_AGENT_STORAGE_ROOT;
    else process.env.IP_AGENT_STORAGE_ROOT = previousRoot;
    await fs.rm(storageRoot, { recursive: true, force: true });
  });

  const imageBytes = Buffer.from('generated-image-bytes');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': imageBytes.length });
    res.end(imageBytes);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const sourceUrl = `http://127.0.0.1:${server.address().port}/result.png`;
  const project = { id: 'project-image', name: '图片项目', assets: [] };
  const image = { id: 'image-result', prompt: '产品主图', style: '真实商业感', url: sourceUrl, createdAt: new Date().toISOString() };
  const asset = await saveGeneratedImageAsset({ project, image, assetId: 'asset-image' });
  const stored = await readAssetFile(asset);

  assert.equal(stored.data.toString(), imageBytes.toString());
  assert.equal(project.assets.length, 1);
  assert.equal(project.assets[0].kind, 'AI生成');
  assert.equal(image.assetId, asset.id);
  assert.equal(image.sourceUrl, sourceUrl);
  assert.equal(image.url, `/api/assets/${asset.id}/content`);

  await saveGeneratedImageAsset({ project, image, assetId: 'unused-id' });
  assert.equal(project.assets.length, 1);
});
