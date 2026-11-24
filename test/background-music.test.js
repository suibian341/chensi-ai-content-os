import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

test('background music provider keeps service credentials server-side and proxies the global library', async (t) => {
  const calls = [];
  const musicId = 'bgm_0123456789abcdef0123456789abcdef';
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      tenant: req.headers['x-render-tenant'],
      filename: req.headers['x-background-music-name'],
      body: Buffer.concat(chunks),
    });
    if (req.url === '/v1/background-music' && req.method === 'GET') {
      const body = JSON.stringify({ items: [{ id: musicId, name: 'Admin Track.wav', mimeType: 'audio/wav', sizeBytes: 12, durationSeconds: 2, createdAt: '2026-09-04T00:00:00.000Z', contentUrl: `/v1/background-music/${musicId}/content` }] });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    if (req.url === '/v1/background-music' && req.method === 'POST') {
      const body = JSON.stringify({ id: musicId, name: decodeURIComponent(req.headers['x-background-music-name']), mimeType: req.headers['content-type'], sizeBytes: Buffer.concat(chunks).length, durationSeconds: 2, createdAt: '2026-09-04T00:00:00.000Z' });
      res.writeHead(201, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    if (req.url === `/v1/background-music/${musicId}` && req.method === 'DELETE') {
      const body = JSON.stringify({ id: musicId, name: 'Admin Track.wav', mimeType: 'audio/wav', sizeBytes: 12, durationSeconds: 2, createdAt: '2026-09-04T00:00:00.000Z' });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    if (req.url === `/v1/background-music/${musicId}/content`) {
      res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': 4, etag: '"music"', 'accept-ranges': 'bytes' });
      if (req.method === 'HEAD') res.end();
      else res.end('RIFF');
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const previous = {
    IP_AGENT_VIDEO_RENDER_SERVICE_URL: process.env.IP_AGENT_VIDEO_RENDER_SERVICE_URL,
    IP_AGENT_VIDEO_RENDER_SERVICE_API_KEY: process.env.IP_AGENT_VIDEO_RENDER_SERVICE_API_KEY,
  };
  process.env.IP_AGENT_VIDEO_RENDER_SERVICE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.IP_AGENT_VIDEO_RENDER_SERVICE_API_KEY = 'background-music-secret';
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const provider = await import('../backend/providers/background-music.js');
  const list = await provider.listBackgroundMusic({ userId: 'user-a' });
  assert.equal(list.length, 1);
  assert.equal(list[0].previewUrl, `/api/background-music/${musicId}/content`);
  assert.equal(Object.hasOwn(list[0], 'contentUrl'), false);

  const uploaded = await provider.uploadBackgroundMusic({ userId: 'admin-user', name: '完整文件名.wav', mimeType: 'audio/wav', data: Buffer.from('audio-bytes') });
  assert.equal(uploaded.name, '完整文件名.wav');
  await provider.deleteBackgroundMusic(musicId, { userId: 'admin-user' });
  const preview = await provider.fetchBackgroundMusicContent(musicId, { userId: 'user-b', method: 'HEAD' });
  assert.equal(preview.status, 200);

  assert.ok(calls.every((call) => call.authorization === 'Bearer background-music-secret'));
  assert.equal(calls.find((call) => call.method === 'GET').tenant, 'user-a');
  const uploadCall = calls.find((call) => call.method === 'POST');
  assert.equal(uploadCall.tenant, 'admin-user');
  assert.equal(uploadCall.body.toString(), 'audio-bytes');
  assert.equal(decodeURIComponent(uploadCall.filename), '完整文件名.wav');
  assert.equal(calls.some((call) => call.url.includes('/assets/')), false);
});
