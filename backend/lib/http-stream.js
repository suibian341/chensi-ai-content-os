import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const closedStreamCodes = new Set([
  'ABORT_ERR',
  'ECONNRESET',
  'EPIPE',
  'ERR_STREAM_PREMATURE_CLOSE',
  'ERR_STREAM_UNABLE_TO_PIPE',
]);

export function responseCannotAcceptBody(response) {
  return Boolean(response.destroyed || response.writableEnded);
}

export function isClosedStreamError(error, response) {
  return responseCannotAcceptBody(response) || closedStreamCodes.has(String(error?.code || ''));
}

export async function pipeWebResponseBody(body, response) {
  if (!body || responseCannotAcceptBody(response)) return false;
  try {
    await pipeline(Readable.fromWeb(body), response);
    return true;
  } catch (error) {
    if (isClosedStreamError(error, response)) return false;
    throw error;
  }
}

export function closeStartedResponse(response) {
  if (!response.headersSent && !response.writableEnded && !response.destroyed) return false;
  if (!response.destroyed && !response.writableEnded) response.destroy();
  return true;
}
