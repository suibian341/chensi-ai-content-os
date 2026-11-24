import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueryPlan, searchAssets } from '../backend/lib/semantic-search.js';

test('query plan extracts requested count and duration', () => {
  const plan = createQueryPlan('找1个最佳的3.6秒轴承视频', { limit: 10 });
  assert.equal(plan.limit, 1);
  assert.equal(plan.target_duration_seconds, 3.6);
  assert.equal(plan.prefer_best, true);
  assert.ok(plan.recall_terms.includes('轴承'));
});

test('semantic rank prefers matching duration and removes duplicate files', () => {
  const assets = [
    { id: 'exact', name: '轴承产品展示', kind: '场景', description: '高端轴承特写，时长 3.6 秒', durationSeconds: 3.6, highlightScore: 92, sha256: 'same-file' },
    { id: 'duplicate', name: '轴承产品展示副本', kind: '场景', description: '轴承特写', durationSeconds: 3.6, highlightScore: 80, sha256: 'same-file' },
    { id: 'long', name: '轴承产品展示长片', kind: '场景', description: '轴承产品展示', durationSeconds: 12, highlightScore: 95, sha256: 'other-file' }
  ];
  const plan = { semantic_query: '轴承展示', recall_terms: ['轴承', '展示'], target_duration_seconds: 3.6, prefer_best: true, limit: 2 };
  const result = searchAssets(assets, '找2个3.6秒轴承展示', { plan });
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].id, 'exact');
  assert.equal(result.results.filter((item) => item.sha256 === 'same-file').length, 1);
  assert.equal(result.results[0].durationDifference, 0);
});

test('synonyms participate in local recall', () => {
  const result = searchAssets(
    [{ id: 'one', name: '女性海边行走', kind: '场景', description: '竖版生活方式视频' }],
    '美女走路竖屏',
    { plan: createQueryPlan('美女走路竖屏', { limit: 5 }) }
  );
  assert.equal(result.results[0].id, 'one');
  assert.ok(result.results[0].matchedTerms.includes('美女'));
});

test('unrelated local assets do not block online fallback', () => {
  const result = searchAssets(
    [{ id: 'one', name: '工厂车间', kind: '场景', description: '设备生产线' }],
    '海边日落',
    { plan: createQueryPlan('海边日落', { limit: 5 }) }
  );
  assert.equal(result.results.length, 0);
});

test('auto edit category participates in semantic ranking', () => {
  const result = searchAssets(
    [
      { id: 'product', name: 'clip-001.mp4', kind: '场景', autoEditCategory: '产品', durationSeconds: 6 },
      { id: 'person', name: 'clip-002.mp4', kind: '场景', autoEditCategory: '人物', durationSeconds: 6 },
    ],
    '展示产品细节',
    { plan: createQueryPlan('展示产品细节', { limit: 2 }) }
  );
  assert.equal(result.results[0].id, 'product');
  assert.ok(result.results[0].matchedTerms.includes('产品'));
});

test('filename matches outrank category-only matches and ignore the extension', () => {
  const plan = { semantic_query: '设备安装步骤', recall_terms: ['设备', '安装', '步骤'], limit: 2 };
  const result = searchAssets([
    { id: 'filename', name: '设备安装步骤.MP4', kind: '场景', autoEditCategory: '人物' },
    { id: 'category', name: 'clip-002.mp4', kind: '场景', autoEditCategory: '设备安装步骤' },
  ], '设备安装步骤', { plan });

  assert.equal(result.results[0].id, 'filename');
  assert.deepEqual(result.results[0].matchedFilenameTerms, ['设备', '安装', '步骤']);
  assert.deepEqual(result.results[1].matchedFilenameTerms, []);
});
