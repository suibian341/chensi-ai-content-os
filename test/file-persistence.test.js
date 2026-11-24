import test from 'node:test';
import assert from 'node:assert/strict';
import { retryTransientFileOperation } from '../backend/lib/file-persistence.js';

test('transient file operations are retried with backoff', async () => {
  let attempts = 0;
  const result = await retryTransientFileOperation(async () => {
    attempts += 1;
    if (attempts < 4) throw Object.assign(new Error('temporarily locked'), { code: 'EPERM' });
    return 'saved';
  }, { attempts: 4, initialDelayMs: 0, maxDelayMs: 0 });

  assert.equal(result, 'saved');
  assert.equal(attempts, 4);
});

test('non-transient file errors are not retried', async () => {
  let attempts = 0;
  await assert.rejects(() => retryTransientFileOperation(async () => {
    attempts += 1;
    throw Object.assign(new Error('invalid path'), { code: 'EINVAL' });
  }, { attempts: 4, initialDelayMs: 0, maxDelayMs: 0 }), { code: 'EINVAL' });

  assert.equal(attempts, 1);
});
