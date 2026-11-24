import test from 'node:test';
import assert from 'node:assert/strict';
import { accountAnalysisSampleState, runWithConcurrency, selectAccountAnalysisPosts } from '../backend/lib/account-analysis.js';

test('account analysis converges when successful and failed samples are all terminal', () => {
  const state = accountAnalysisSampleState([
    { status: 'failed', errorCode: 'PLATFORM_VIDEO_TOO_LARGE' },
    { status: 'analyzed', analysisVersion: 'multimodal-v1' },
    { status: 'failed', errorCode: 'PROVIDER_TIMEOUT' }
  ]);
  assert.equal(state.terminal, true);
  assert.equal(state.analyzed.length, 1);
  assert.equal(state.failed.length, 2);
});

test('account analysis remains pending while any sample is queued or analyzing', () => {
  assert.equal(accountAnalysisSampleState([{ status: 'failed' }, { status: 'queued' }]).terminal, false);
  assert.equal(accountAnalysisSampleState([{ status: 'analyzing' }]).terminal, false);
  assert.equal(accountAnalysisSampleState([]).terminal, false);
});

test('account sample processing obeys the configured concurrency', async () => {
  let running = 0;
  let peak = 0;
  const completed = [];
  await runWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    completed.push(item);
    running -= 1;
  });
  assert.equal(peak, 2);
  assert.deepEqual(completed.sort((a, b) => a - b), [1, 2, 3, 4, 5]);
});

test('account analysis selects the shortest valid videos while preserving source order', () => {
  const posts = [
    { id: 'latest-long', url: 'https://example.com/1', duration: 900_000 },
    { id: 'short', url: 'https://example.com/2', duration: 120_000 },
    { id: 'invalid', url: '', duration: 10_000 },
    { id: 'medium', url: 'https://example.com/3', duration: 300_000 },
    { id: 'shorter', url: 'https://example.com/4', duration: 60_000 }
  ];
  assert.deepEqual(selectAccountAnalysisPosts(posts, 3).map((item) => item.id), ['short', 'medium', 'shorter']);
});
