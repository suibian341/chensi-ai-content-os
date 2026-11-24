import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

test('saved avatar and voice render a digital-human video from script', async (t) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    requests.push({ method: req.method, url: req.url, headers: req.headers, raw });
    if (req.url === '/tts') {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.end(`${JSON.stringify({ code: 0, data: Buffer.from('ID3audio'.repeat(4)).toString('base64') })}\n${JSON.stringify({ code: 20_000_000, message: 'OK', data: null })}\n`);
      return;
    }
    if (req.url === '/api/v2/fly/upload/create_upload_url') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0, data: { upload_url: `${base}/upload`, content_type: 'audio/mpeg', file_id: 'audio-file' } }));
      return;
    }
    if (req.url === '/upload') {
      res.writeHead(200);
      res.end();
      return;
    }
    if (req.url === '/api/v2/fly/video/create_by_audio') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0, data: { task_id: 'video-task' } }));
      return;
    }
    if (req.url === '/api/v2/fly/video/task?task_id=video-task') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0, data: { status: 3, video_url: 'https://media.example/result.mp4', duration: 3 } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const previous = {};
  const settings = {
    IP_AGENT_VOLCENGINE_VOICE_API_KEY: 'test-voice-key',
    IP_AGENT_VOLCENGINE_TTS_ENDPOINT: `${base}/tts`,
    IP_AGENT_VOLCENGINE_TTS_RESOURCE_ID: 'seed-icl-2.0',
    IP_AGENT_VOLCENGINE_TTS_APP_ID: 'test-app',
    IP_AGENT_SKYHUMAN_API_TOKEN: 'test-sky-key',
    IP_AGENT_SKYHUMAN_BASE_URL: base,
    IP_AGENT_SKYHUMAN_POLL_INTERVAL_MS: '1'
  };
  for (const [key, value] of Object.entries(settings)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const { renderAvatarVideo } = await import('../backend/providers/digital-human.js');
  const result = await renderAvatarVideo({
    avatarId: 'avatar-local',
    voiceId: 'voice-local',
    script: '真实文案',
    language: 'zh-CN',
    languageLabel: '中文',
    consent: true
  }, {
    name: '项目',
    assets: [{ id: 'audio-that-must-not-be-used', mimeType: 'audio/wav', storageKey: 'unused' }],
    avatars: [{ id: 'avatar-local', avatarId: 'avatar-provider', pose: '站立', style: '专业讲解', language: 'zh-CN', languageLabel: '中文' }],
    voices: [{ id: 'voice-local', engineVoiceId: 'voice-provider' }]
  });

  assert.equal(result.output.videoUrl, 'https://media.example/result.mp4');
  assert.equal(result.output.avatarId, 'avatar-local');
  assert.equal(result.output.providerAvatarId, 'avatar-provider');
  assert.equal(result.output.voiceId, 'voice-provider');
  assert.equal(result.output.pose, '站立');
  assert.equal(result.output.style, '专业讲解');
  assert.equal(result.output.languageLabel, '中文');
  assert.equal(result.output.sourceScript, '真实文案');
  assert.equal(result.output.speechScript, '真实文案');
  assert.equal(result.output.scriptTransformed, false);
  assert.equal(result.output.audioSourceAssetId, null);
  const tts = JSON.parse(requests.find((item) => item.url === '/tts').raw);
  assert.equal(tts.audio.voice_type, 'voice-provider');
  const render = JSON.parse(requests.find((item) => item.url === '/api/v2/fly/video/create_by_audio').raw);
  assert.equal(render.avatar, 'avatar-provider');
});
