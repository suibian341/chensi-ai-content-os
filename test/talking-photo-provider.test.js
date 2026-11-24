import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

test('single-photo narration reuses Media Lab voice and cached portrait resource', async (t) => {
  const requests = [];
  const reads = new Map();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push({ method: req.method, url, headers: req.headers, body });

    if (url.pathname === '/api/v3/tts/unidirectional') {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.end(`${JSON.stringify({ code: 20_000_000, data: Buffer.from('fake-mp3-audio-payload').toString('base64') })}\n`);
      return;
    }
    if (url.pathname === '/media.mp4') {
      res.writeHead(206, { 'Content-Type': 'video/mp4' });
      res.end('video');
      return;
    }

    const payload = body.length ? JSON.parse(body.toString('utf8')) : {};
    if (url.searchParams.get('Action') === 'CVSubmitTask') {
      const role = payload.req_key.includes('create_role');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 10000, message: 'Success', data: { task_id: role ? 'role-task' : `video-task-${requests.length}` } }));
      return;
    }
    if (url.searchParams.get('Action') === 'CVGetResult') {
      if (String(payload.task_id).startsWith('connection-check-')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 10000, message: 'Success', data: { status: 'not_found' } }));
        return;
      }
      const count = (reads.get(payload.task_id) || 0) + 1;
      reads.set(payload.task_id, count);
      const isRole = payload.task_id === 'role-task';
      const responseData = isRole
        ? { code: 0, progress: 100, resource_id: 'portrait-resource-1' }
        : { code: 0, progress: 100, video: { VideoMeta: { Duration: 8.25 } } };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(count === 1
        ? { code: 10000, message: 'Success', data: { status: 'generating', resp_data: JSON.stringify({ progress: 36 }) } }
        : {
            code: 10000,
            message: 'Success',
            data: {
              status: 'done',
              resp_data: JSON.stringify(responseData),
              ...(isRole ? {} : { video_url: 'https://media.example/talking-photo.mp4' })
            }
          }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 404, message: 'not found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const environment = {
    IP_AGENT_VOLCENGINE_VISUAL_ACCESS_KEY_ID: 'test-access-key',
    IP_AGENT_VOLCENGINE_VISUAL_SECRET_KEY: 'test-secret-key',
    IP_AGENT_VOLCENGINE_VISUAL_BASE_URL: baseUrl,
    IP_AGENT_VOLCENGINE_VOICE_API_KEY: 'test-voice-key',
    IP_AGENT_VOLCENGINE_TTS_ENDPOINT: `${baseUrl}/api/v3/tts/unidirectional`,
    IP_AGENT_VOLCENGINE_TTS_RESOURCE_ID: 'test-resource',
    IP_AGENT_TALKING_PHOTO_DRIVE_MODE: 'auto',
    IP_AGENT_TALKING_PHOTO_POLL_INTERVAL_MS: '1',
    IP_AGENT_TALKING_PHOTO_TIMEOUT_MS: '1000',
    IP_AGENT_PROVIDER_SETTINGS_FILE: `${baseUrl.replace(/[^a-z0-9]/gi, '-')}.json`
  };
  const previous = {};
  for (const [key, value] of Object.entries(environment)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const {
    checkTalkingPhotoConnection,
    fetchTalkingPhotoMedia,
    renderTalkingPhoto,
    talkingPhotoDownloadHeaders
  } = await import('../backend/providers/talking-photo.js');

  const project = {
    id: 'project-1',
    ownerId: 'user-1',
    name: '测试项目',
    assets: [{ id: 'portrait', storageKey: 'portrait.jpg', name: 'portrait.jpg', mimeType: 'image/jpeg' }],
    voices: [{ id: 'voice-local', engineVoiceId: 'voice-provider', name: '本人声音', voiceService: 'media_lab', status: 'ready' }],
    outputs: []
  };
  const progress = [];
  let narrationCleaned = false;
  const options = {
    onProgress: async (value) => progress.push(value),
    resolveImageUrl: async () => 'https://media.example/portrait.jpg',
    publishNarration: async ({ audio }) => {
      assert.equal(audio.data.toString(), 'fake-mp3-audio-payload');
      return { url: 'https://media.example/narration.mp3', cleanup: async () => { narrationCleaned = true; } };
    }
  };
  const input = {
    imageAssetId: 'portrait',
    voiceId: 'voice-local',
    script: '你好，这是数字人口播测试。',
    name: '口播测试',
    consent: true,
    aspectRatio: '9:16'
  };

  const result = await renderTalkingPhoto(input, project, options);
  assert.equal(result.provider, 'domestic-talking-photo');
  assert.equal(result.model, 'large');
  assert.equal(result.output.videoUrl, 'https://media.example/talking-photo.mp4');
  assert.equal(result.output.durationSeconds, 8.25);
  assert.equal(result.output.voiceId, 'voice-local');
  assert.equal(result.output.engineVoiceId, 'voice-provider');
  assert.equal(result.output.resourceId, 'portrait-resource-1');
  assert.equal(result.output.resourceReqKey, 'realman_avatar_picture_create_role_loopyb');
  assert.equal(result.output.videoReqKey, 'realman_avatar_picture_loopyb');
  assert.equal(result.output.providerPricePerSecondCny, 0.3);
  assert.equal(narrationCleaned, true);
  assert.ok(progress.includes(78));

  const tts = requests.find((request) => request.url.pathname === '/api/v3/tts/unidirectional');
  const ttsBody = JSON.parse(tts.body.toString('utf8'));
  assert.equal(ttsBody.req_params.speaker, 'voice-provider');
  const signedRequests = requests.filter((request) => request.url.searchParams.has('Action'));
  assert.ok(signedRequests.length >= 4);
  for (const request of signedRequests) {
    assert.match(request.headers.authorization || '', /^HMAC-SHA256 Credential=test-access-key\//);
    assert.match(request.headers['x-date'] || '', /^\d{8}T\d{6}Z$/);
    assert.match(request.headers['x-content-sha256'] || '', /^[a-f0-9]{64}$/);
  }
  const submissions = signedRequests
    .filter((request) => request.url.searchParams.get('Action') === 'CVSubmitTask')
    .map((request) => JSON.parse(request.body.toString('utf8')));
  assert.deepEqual(submissions[0], {
    req_key: 'realman_avatar_picture_create_role_loopyb',
    image_url: 'https://media.example/portrait.jpg'
  });
  assert.deepEqual(submissions[1], {
    req_key: 'realman_avatar_picture_loopyb',
    resource_id: 'portrait-resource-1',
    audio_url: 'https://media.example/narration.mp3'
  });

  project.outputs.push({
    template: 'talking-photo',
    sourceAssetId: 'portrait',
    resourceId: result.output.resourceId,
    resourceReqKey: result.output.resourceReqKey
  });
  await renderTalkingPhoto(input, project, options);
  const allSubmissions = requests
    .filter((request) => request.url.searchParams.get('Action') === 'CVSubmitTask')
    .map((request) => JSON.parse(request.body.toString('utf8')));
  assert.equal(allSubmissions.filter((item) => item.req_key.includes('create_role')).length, 1);
  assert.equal(allSubmissions.filter((item) => !item.req_key.includes('create_role')).length, 2);

  const status = await checkTalkingPhotoConnection();
  assert.equal(status.ready, true);
  assert.equal(status.reusesMediaVoices, true);
  assert.equal(status.requiresVoiceSelection, true);
  assert.equal(status.pricePerSecondCny, 0.3);
  assert.deepEqual(talkingPhotoDownloadHeaders(), {});

  const mediaResponse = await fetchTalkingPhotoMedia(`${baseUrl}/media.mp4`, { headers: { Range: 'bytes=0-' } });
  assert.equal(mediaResponse.status, 206);
  const mediaRequest = requests.find((request) => request.url.pathname === '/media.mp4');
  assert.equal(mediaRequest.headers.range, 'bytes=0-');
  assert.equal(mediaRequest.headers.authorization, undefined);
});
