import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError } from '../backend/lib/http.js';
import { voiceProviderError } from '../backend/providers/voice.js';

test('voice clone resource denial becomes an actionable permission error', () => {
  const source = new ProviderError(
    'PROVIDER_HTTP_ERROR',
    '[resource_id=volc.megatts.timbre] requested resource not granted',
    {
      status: 403,
      details: {
        code: 45000030,
        message: '[resource_id=volc.megatts.timbre] requested resource not granted'
      }
    }
  );

  const error = voiceProviderError(source.details, source);

  assert.equal(error.code, 'VOICE_CLONE_NOT_ENABLED');
  assert.equal(error.status, 403);
  assert.match(error.message, /声音克隆训练权限/);
  assert.doesNotMatch(error.message, /volc\.megatts\.timbre/i);
  assert.equal(error.retryable, false);
});

test('voice clone resource mismatch is not reported as provider busy', () => {
  const error = voiceProviderError({
    code: 55000000,
    message: 'resource ID is mismatched with speaker related resource'
  });

  assert.equal(error.code, 'VOICE_RESOURCE_MISMATCH');
  assert.match(error.message, /音色槽位/);
  assert.equal(error.retryable, false);
});
