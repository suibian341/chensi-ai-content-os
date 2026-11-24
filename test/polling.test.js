import test from 'node:test';
import assert from 'node:assert/strict';
import { createPollingManager } from '../web/public/polling.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('serial polling never overlaps slow requests', async () => {
  const manager = createPollingManager();
  let attempts = 0;
  let active = 0;
  let maxActive = 0;
  manager.start('slow', {
    intervalMs: 1,
    timeoutMs: 500,
    poll: async () => {
      attempts += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await wait(20);
      active -= 1;
      return attempts === 3;
    }
  });
  await wait(140);
  assert.equal(attempts, 3);
  assert.equal(maxActive, 1);
  assert.equal(manager.size, 0);
});

test('serial polling retries transient failures and stops at its deadline', async () => {
  const retrying = createPollingManager();
  let attempts = 0;
  let failed = false;
  retrying.start('retry', {
    intervalMs: 1,
    timeoutMs: 500,
    maxFailures: 3,
    poll: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('temporary');
      return true;
    },
    onError: () => { failed = true; }
  });
  await wait(40);
  assert.equal(attempts, 3);
  assert.equal(failed, false);
  assert.equal(retrying.size, 0);

  const expiring = createPollingManager();
  let timedOut = false;
  expiring.start('deadline', {
    intervalMs: 5,
    timeoutMs: 15,
    poll: async () => false,
    onTimeout: () => { timedOut = true; }
  });
  await wait(45);
  assert.equal(timedOut, true);
  assert.equal(expiring.size, 0);
});

test('stopWhere cancels polling owned by an old project', async () => {
  const manager = createPollingManager();
  let oldProjectPolls = 0;
  let currentProjectPolls = 0;
  manager.start('old', { intervalMs: 10, timeoutMs: 500, meta: { projectId: 'old' }, poll: async () => { oldProjectPolls += 1; return false; } });
  manager.start('current', { intervalMs: 10, timeoutMs: 500, meta: { projectId: 'current' }, poll: async () => { currentProjectPolls += 1; return currentProjectPolls >= 1; } });
  manager.stopWhere((entry) => entry.meta?.projectId !== 'current');
  await wait(30);
  assert.equal(oldProjectPolls, 0);
  assert.equal(currentProjectPolls, 1);
  assert.equal(manager.size, 0);
});
