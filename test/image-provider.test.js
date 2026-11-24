import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateImage } from '../backend/providers/image.js';

function setImageEnv(t, values) {
  const names = ['IP_AGENT_IMAGE_PROVIDER', 'IP_AGENT_IMAGE_BASE_URL', 'IP_AGENT_IMAGE_API_KEY', 'IP_AGENT_IMAGE_MODEL', 'IP_AGENT_IMAGE_REPLY_TYPE', 'IP_AGENT_IMAGE_ASPECT_RATIO', 'IP_AGENT_IMAGE_POLL_INTERVAL_MS'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  Object.assign(process.env, values);
  t.after(() => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => resolve(raw ? JSON.parse(raw) : {}));
  });
}

test('GRSAI GPT Image 2 sync request maps result URL and aspect ratio', async (t) => {
  let requestBody;
  const server = http.createServer(async (req, res) => {
    requestBody = await readBody(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'sync-1', status: 'succeeded', results: [{ url: 'https://cdn.example/sync.png' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  setImageEnv(t, {
    IP_AGENT_IMAGE_PROVIDER: 'grsai-gpt-image',
    IP_AGENT_IMAGE_BASE_URL: `http://127.0.0.1:${port}/v1/api/generate`,
    IP_AGENT_IMAGE_API_KEY: 'test-key',
    IP_AGENT_IMAGE_MODEL: 'gpt-image-2'
  });

  const result = await generateImage({ prompt: 'test prompt', style: 'editorial', aspectRatio: '9:16', images: ['data:image/png;base64,dGVzdA=='] });
  assert.equal(result.provider, 'grsai-gpt-image');
  assert.equal(result.output.url, 'https://cdn.example/sync.png');
  assert.equal(result.output.aspectRatio, '9:16');
  assert.equal(requestBody.model, 'gpt-image-2');
  assert.equal(requestBody.aspectRatio, '9:16');
  assert.equal(requestBody.prompt, 'test prompt\n视觉风格：editorial');
  assert.deepEqual(requestBody.images, ['data:image/png;base64,dGVzdA==']);
  assert.equal(requestBody.replyType, 'json');
});

test('GRSAI GPT Image 2 VIP maps ratio controls to valid pixel dimensions', async (t) => {
  let requestBody;
  const server = http.createServer(async (req, res) => {
    requestBody = await readBody(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'vip-1', status: 'succeeded', results: [{ url: 'https://cdn.example/vip.png' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  setImageEnv(t, {
    IP_AGENT_IMAGE_PROVIDER: 'grsai-gpt-image',
    IP_AGENT_IMAGE_BASE_URL: `http://127.0.0.1:${server.address().port}/v1/api/generate`,
    IP_AGENT_IMAGE_API_KEY: 'test-key',
    IP_AGENT_IMAGE_MODEL: 'gpt-image-2-vip'
  });

  const result = await generateImage({ prompt: 'vip prompt', aspectRatio: '16:9' });
  assert.equal(requestBody.aspectRatio, '2048x1152');
  assert.equal(result.output.aspectRatio, '2048x1152');
});

test('GRSAI GPT Image 2 rejects unsupported aspect ratio before calling provider', async (t) => {
  setImageEnv(t, {
    IP_AGENT_IMAGE_PROVIDER: 'grsai-gpt-image',
    IP_AGENT_IMAGE_BASE_URL: 'http://127.0.0.1:1/v1/api/generate',
    IP_AGENT_IMAGE_API_KEY: 'test-key',
    IP_AGENT_IMAGE_MODEL: 'gpt-image-2'
  });
  await assert.rejects(
    generateImage({ prompt: 'test prompt', aspectRatio: '5:1' }),
    (error) => error.code === 'IMAGE_ASPECT_RATIO_INVALID' && error.status === 400
  );
});

test('GRSAI GPT Image 2 async request polls task and returns completed URL', async (t) => {
  let polls = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST') {
      await readBody(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'async-1', status: 'running' }));
      return;
    }
    polls += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'async-1', status: 'succeeded', results: [{ url: 'https://cdn.example/async.png' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  setImageEnv(t, {
    IP_AGENT_IMAGE_PROVIDER: 'grsai-gpt-image',
    IP_AGENT_IMAGE_BASE_URL: `http://127.0.0.1:${port}/v1/api/generate`,
    IP_AGENT_IMAGE_API_KEY: 'test-key',
    IP_AGENT_IMAGE_MODEL: 'gpt-image-2',
    IP_AGENT_IMAGE_REPLY_TYPE: 'async',
    IP_AGENT_IMAGE_POLL_INTERVAL_MS: '5'
  });

  const result = await generateImage({ prompt: 'test prompt' });
  assert.equal(result.output.url, 'https://cdn.example/async.png');
  assert.equal(result.externalTaskId, 'async-1');
  assert.equal(polls, 1);
});
