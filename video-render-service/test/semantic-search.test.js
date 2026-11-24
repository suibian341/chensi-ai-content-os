import test from 'node:test';
import assert from 'node:assert/strict';
import { searchAssets } from '../src/lib/semantic-search.js';
import { buildAutoEditPlan } from '../src/video-engine/tiktok-vlog.js';

test('filename matches outrank category-only matches and ignore the extension', () => {
  const queryPlan = { semantic_query: '设备安装步骤', recall_terms: ['设备', '安装', '步骤'], limit: 2 };
  const assets = [
    { id: 'filename', name: '设备安装步骤.MP4', kind: '场景', autoEditCategory: '人物', durationSeconds: 8 },
    { id: 'category', name: 'clip-002.mp4', kind: '场景', autoEditCategory: '设备安装步骤', durationSeconds: 8 },
  ];
  const result = searchAssets(assets, '设备安装步骤', { plan: queryPlan });

  assert.equal(result.results[0].id, 'filename');
  assert.deepEqual(result.results[0].matchedFilenameTerms, ['设备', '安装', '步骤']);

  const editPlan = buildAutoEditPlan({
    durationSeconds: 3,
    timeline: [{ id: 'one', text: '设备安装步骤', start: 0, end: 2 }],
    seed: 'filename-priority',
    assets,
  });
  assert.equal(editPlan[0].assetId, 'filename');
});
