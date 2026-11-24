import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { executeTaskProvider } from '../backend/providers/tasks.js';

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => resolve(raw ? JSON.parse(raw) : {}));
  });
}

test('image task reads selected project reference image and sends it as a data URL', async (t) => {
  const environmentNames = [
    'IP_AGENT_STORAGE_ROOT',
    'IP_AGENT_IMAGE_PROVIDER',
    'IP_AGENT_IMAGE_BASE_URL',
    'IP_AGENT_IMAGE_API_KEY',
    'IP_AGENT_IMAGE_MODEL'
  ];
  const previous = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'chensi-image-reference-'));
  t.after(async () => {
    for (const name of environmentNames) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    await fs.rm(storageRoot, { recursive: true, force: true });
  });

  const referenceBytes = Buffer.from('reference-image-bytes');
  await fs.mkdir(path.join(storageRoot, 'project-1'), { recursive: true });
  await fs.writeFile(path.join(storageRoot, 'project-1', 'reference.png'), referenceBytes);
  let requestBody;
  const server = http.createServer(async (req, res) => {
    requestBody = await readBody(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'reference-1', status: 'succeeded', results: [{ url: 'https://cdn.example/reference.png' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  Object.assign(process.env, {
    IP_AGENT_STORAGE_ROOT: storageRoot,
    IP_AGENT_IMAGE_PROVIDER: 'grsai-gpt-image',
    IP_AGENT_IMAGE_BASE_URL: `http://127.0.0.1:${server.address().port}/v1/api/generate`,
    IP_AGENT_IMAGE_API_KEY: 'test-key',
    IP_AGENT_IMAGE_MODEL: 'gpt-image-2'
  });

  const project = {
    assets: [{ id: 'asset-1', mimeType: 'image/png', storageKey: 'project-1/reference.png' }]
  };
  const result = await executeTaskProvider(
    { kind: 'image' },
    project,
    { prompt: 'use this reference', referenceAssetIds: ['asset-1'] }
  );

  assert.equal(result.output.url, 'https://cdn.example/reference.png');
  assert.deepEqual(requestBody.images, [`data:image/png;base64,${referenceBytes.toString('base64')}`]);
});
