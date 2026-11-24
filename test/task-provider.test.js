import test from 'node:test';
import assert from 'node:assert/strict';
import { executeTaskProvider } from '../backend/providers/tasks.js';

test('publish manifest binds the requested real output and never claims automatic publishing', async () => {
  const project = {
    copy: { publishTitle: '真实标题', tags: ['真实标签'] },
    outputs: [
      { id: 'latest', title: '最新成片', status: 'ready', accessUrl: '/api/outputs/latest/content', ratio: '9:16' },
      { id: 'selected', title: '指定成片', status: 'ready', url: 'https://media.example/selected.mp4', ratio: '1:1' }
    ]
  };
  const execution = await executeTaskProvider(
    { kind: 'publish' },
    project,
    { sourceOutputId: 'selected', platforms: ['抖音', '小红书'] }
  );
  assert.equal(execution.output.sourceOutputId, 'selected');
  assert.equal(execution.output.sourceUrl, 'https://media.example/selected.mp4');
  assert.equal(execution.output.packageType, 'metadata_manifest');
  assert.equal(execution.output.automaticPublishing, false);
  assert.equal(execution.output.generatedMediaFiles, false);
  assert.match(execution.output.notice, /不会自动发布/);
  assert.equal(execution.output.formats[0].subtitleSafeZone, '顶部 10% / 底部 22% 留空');
});

test('publish manifest rejects a missing requested output', async () => {
  await assert.rejects(
    () => executeTaskProvider(
      { kind: 'publish' },
      { outputs: [{ id: 'real', status: 'ready', accessUrl: '/real.mp4' }] },
      { sourceOutputId: 'missing', platforms: ['抖音'] }
    ),
    (error) => error.code === 'PUBLISH_VIDEO_REQUIRED'
  );
});
