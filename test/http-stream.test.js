import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import { closeStartedResponse, isClosedStreamError, pipeWebResponseBody } from '../backend/lib/http-stream.js';

test('remote media piping ignores a destination already closed by the browser', async () => {
  const response = new PassThrough();
  response.destroy();
  const body = Readable.toWeb(Readable.from([Buffer.from('audio')]));
  assert.equal(await pipeWebResponseBody(body, response), false);
});

test('closed stream errors are handled without attempting a second response', () => {
  const response = { headersSent: true, writableEnded: false, destroyed: false, destroyCalled: false, destroy() { this.destroyed = true; this.destroyCalled = true; } };
  assert.equal(isClosedStreamError({ code: 'ERR_STREAM_UNABLE_TO_PIPE' }, response), true);
  assert.equal(closeStartedResponse(response), true);
  assert.equal(response.destroyCalled, true);
});

test('an untouched response remains available for a JSON error', () => {
  const response = { headersSent: false, writableEnded: false, destroyed: false };
  assert.equal(closeStartedResponse(response), false);
});
