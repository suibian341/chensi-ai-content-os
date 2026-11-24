import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonObject } from '../backend/lib/http.js';

test('parses the first complete JSON object without greedily consuming trailing text', () => {
  assert.deepEqual(parseJsonObject('说明 {"ok":true,"value":{"text":"右括号 } 在字符串内"}} trailing {bad}'), {
    ok: true,
    value: { text: '右括号 } 在字符串内' }
  });
});

test('reports truncated JSON separately from invalid JSON syntax', () => {
  assert.throws(() => parseJsonObject('{"timeline":[{"start":0}'), (error) => error.code === 'PROVIDER_INVALID_JSON' && error.details?.truncated === true);
});
