import test from 'node:test';
import assert from 'node:assert/strict';
import { providerSettingDefinitions } from '../backend/lib/provider-settings.js';
import { renderVideo } from '../backend/providers/video.js';

// Everything the admin panel may expose for the video render service. The point of
// this list is that rendering is remote-only: no local video engine or ffmpeg knob
// belongs here. The backend switch and the IMS timings are part of that remote
// configuration — which engine runs the render — not a local-processing setting.
const remoteKeys = [
  'IP_AGENT_VIDEO_RENDER_SERVICE_URL',
  'IP_AGENT_VIDEO_RENDER_SERVICE_API_KEY',
  'IP_AGENT_VIDEO_RENDER_SERVICE_TIMEOUT_MS',
  'IP_AGENT_VIDEO_RENDER_SERVICE_POLL_INTERVAL_MS',
  'IP_AGENT_VIDEO_RENDER_BACKEND',
  'IP_AGENT_VIDEO_RENDER_FALLBACK_LOCAL',
  'IP_AGENT_VIDEO_RENDER_IMS_TIMEOUT_MS',
  'IP_AGENT_VIDEO_RENDER_IMS_POLL_INTERVAL_MS',
  'IP_AGENT_VIDEO_RENDER_IMS_BURN_SUBTITLES',
  // How the subtitle file is addressed to IMS — a property of the cloud render, so it
  // belongs with the rest of the remote configuration.
  'IP_AGENT_VIDEO_RENDER_IMS_SUBTITLE_URL',
];

test('admin exposes only remote settings for the video render service', () => {
  const remoteDefinitions = providerSettingDefinitions.filter((item) => item.group === '远端剪辑服务');
  assert.deepEqual(remoteDefinitions.map((item) => item.key), remoteKeys);
  assert.ok(providerSettingDefinitions.every((item) => !['本地视频处理', '视频引擎与字幕'].includes(item.group)));
});

test('video rendering fails clearly when the remote service is not configured', async () => {
  await assert.rejects(
    renderVideo({ id: 'task_remote_only' }, {}, { id: 'project_remote_only', assets: [] }),
    (error) => error?.code === 'VIDEO_RENDER_SERVICE_NOT_CONFIGURED',
  );
});
