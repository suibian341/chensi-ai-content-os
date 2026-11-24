import { createHash, createHmac, randomUUID } from 'node:crypto';
import { ProviderError } from '../lib/http.js';

/**
 * Aliyun ICE (IMS, 智能媒体服务) RPC client.
 *
 * IMS is invoked over the shared RPC style: one endpoint per region, the
 * operation in `Action`, and ACS3-HMAC-SHA256 request signing. Reads travel in
 * the query string, writes in a form-encoded body.
 */

const DEFAULT_VERSION = '2020-11-09';
const DEFAULT_REGION = 'cn-shenzhen';

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmacSha256(key, value) {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

/** RFC 3986 encoding, as the signing algorithm requires (spaces as %20, not +). */
function percentEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

function endpointOf(config) {
  return String(config.endpoint || `ice.${config.region || DEFAULT_REGION}.aliyuncs.com`)
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
}

/**
 * Sign and issue one IMS RPC call.
 *
 * Every value is stringified because the RPC protocol has no typed body; nested
 * structures (Timeline, for example) are passed as JSON strings by the caller.
 */
async function callIms(config, action, params = {}, { method = 'GET', timeoutMs = 60_000, signal } = {}) {
  if (!config?.accessKeyId || !config?.accessKeySecret) {
    throw new ProviderError('IMS_NOT_CONFIGURED', 'IMS 凭据未配置', { status: 503 });
  }

  const version = config.apiVersion || DEFAULT_VERSION;
  const host = endpointOf(config);
  const entries = { ...params, Action: action, Version: version, Format: 'JSON' };
  const body = method === 'POST'
    ? Object.keys(entries).sort().map((key) => `${percentEncode(key)}=${percentEncode(entries[key])}`).join('&')
    : '';

  const canonicalQuery = method === 'GET'
    ? Object.keys(entries).sort().map((key) => `${percentEncode(key)}=${percentEncode(entries[key])}`).join('&')
    : '';

  const hashedPayload = sha256Hex(body);
  const date = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const headers = {
    host,
    'x-acs-action': action,
    'x-acs-version': version,
    'x-acs-date': date,
    'x-acs-signature-nonce': randomUUID(),
    'x-acs-content-sha256': hashedPayload,
  };
  if (method === 'POST') headers['content-type'] = 'application/x-www-form-urlencoded';

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${String(headers[name]).trim()}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalRequest = [
    method,
    '/',
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    hashedPayload,
  ].join('\n');

  const stringToSign = `ACS3-HMAC-SHA256\n${sha256Hex(canonicalRequest)}`;
  const signature = createHmac('sha256', config.accessKeySecret).update(stringToSign, 'utf8').digest('hex');
  const authorization = `ACS3-HMAC-SHA256 Credential=${config.accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`;

  const url = `https://${host}/${canonicalQuery ? `?${canonicalQuery}` : ''}`;
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: method === 'POST'
        ? { ...headers, authorization, 'content-length': String(Buffer.byteLength(body)) }
        : { ...headers, authorization },
      ...(method === 'POST' ? { body } : {}),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw new ProviderError(
      timedOut ? 'IMS_TIMEOUT' : 'IMS_UNREACHABLE',
      timedOut ? 'IMS 接口请求超时' : '暂时无法连接阿里云 IMS',
      { retryable: true, details: error instanceof Error ? error.message : String(error) },
    );
  }

  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }

  // GetMediaProducingJob may include an inner MediaProducingJob.Code even on
  // successful responses; only an HTTP error or top-level RPC error is fatal.
  if (!response.ok || (payload && payload.Code && !payload.JobId && !payload.MediaId && !payload.MediaProducingJob)) {
    const code = payload?.Code || `IMS_HTTP_${response.status}`;
    throw new ProviderError(
      code,
      payload?.Message || `IMS 返回 HTTP ${response.status}`,
      {
        status: response.status,
        retryable: response.status === 429 || response.status >= 500 || code === 'Throttling.User',
        details: payload || text.slice(0, 500),
      },
    );
  }
  return payload ?? { raw: text };
}

export const imsCall = callIms;

/** Read helpers — these are cheap and safe to call for diagnostics. */
export const imsGetStorageList = (config, options) => callIms(config, 'GetStorageList', {}, options);
export const imsListMediaBasicInfos = (config, params = {}, options) =>
  callIms(config, 'ListMediaBasicInfos', params, options);
export const imsListSmartJobs = (config, params = {}, options) =>
  callIms(config, 'ListSmartJobs', params, options);

/** Register an OSS object (or external URL) as a media asset so Timeline can reference it. */
export function imsRegisterMediaInfo(config, { inputUrl, mediaType = 'video', title, overwrite = true, coverUrl }, options) {
  return callIms(config, 'RegisterMediaInfo', {
    InputURL: inputUrl,
    MediaType: mediaType,
    ...(title ? { Title: title } : {}),
    ...(coverUrl ? { CoverURL: coverUrl } : {}),
    Overwrite: String(Boolean(overwrite)),
  }, { method: 'POST', ...options });
}

/** Submit a Timeline or template based edit; returns { JobId }. */
export function imsSubmitMediaProducingJob(config, params, options) {
  return callIms(config, 'SubmitMediaProducingJob', params, { method: 'POST', ...options });
}

/** Poll an edit job; returns { JobStatus, MediaId, OutputMediaUrl, ... }. */
export function imsGetMediaProducingJob(config, jobId, options) {
  return callIms(config, 'GetMediaProducingJob', { JobId: jobId }, options);
}

/**
 * RegisterMediaInfo is asynchronous.  IMS can therefore report a temporary
 * InvalidMaterial.MediaNotReady error while the source object is still being
 * indexed.  Callers should keep polling instead of marking the render as
 * failed in this case.
 */
export function isMediaNotReady(error) {
  const details = error?.details || {};
  const code = [
    error?.code,
    error?.Code,
    details?.Code,
    details?.code,
    details?.MediaProducingJob?.Code,
  ].filter(Boolean).join(' ');
  const message = [
    error?.message,
    error?.Message,
    details?.Message,
    details?.message,
    details?.MediaProducingJob?.Message,
  ].filter(Boolean).join(' ');
  return /MediaNotReady|media\s+is\s+not\s+ready|InvalidMaterial\.MediaNotReady/i.test(`${code} ${message}`);
}

/** Submit an ASR (speech-to-text) job; returns { JobId }. */
export function imsSubmitAsrJob(config, params, options) {
  return callIms(config, 'SubmitASRJob', params, { method: 'POST', ...options });
}

/** Poll any smart-handling job (ASR included); returns { Status, Result, ... }. */
export function imsGetSmartHandleJob(config, jobId, options) {
  return callIms(config, 'GetSmartHandleJob', { JobId: jobId }, options);
}
