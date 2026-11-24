/**
 * Aliyun IMS / VOD executor: submit a compiled Timeline, poll, return the result.
 *
 * Pairs with aliyun-timeline.js. That module decides *what* to render (pure
 * translation of an already-decided plan); this one only talks to the service.
 *
 * Contract note: both IMS (ice.<region>, 2020-11-09) and VOD (vod.cn-shanghai,
 * 2017-03-21) expose a Timeline-based producing job. IMS was verified reachable
 * on this account and SubmitMediaProducingJob exists there; VOD needs its
 * service opened first. The endpoint is therefore configuration, not code.
 */

import { createHmac, randomUUID } from 'node:crypto';
import { ProviderError } from '../lib/http.js';

/**
 * RPC-style signature (HMAC-SHA1) used by the ICE/VOD OpenAPI.
 * Verified against the live service: a wrong secret yields
 * SignatureDoesNotMatch, a missing parameter yields a parameter-level error.
 */
export function signRpc({ accessKeyId, accessKeySecret, params, method = 'GET' }) {
  const encode = (value) => encodeURIComponent(String(value))
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');

  const canonical = Object.keys(params)
    .sort()
    .map((key) => `${encode(key)}=${encode(params[key])}`)
    .join('&');

  const stringToSign = `${method}&${encode('/')}&${encode(canonical)}`;
  const signature = createHmac('sha1', `${accessKeySecret}&`)
    .update(stringToSign)
    .digest('base64');

  return { canonical, signature };
}

export function buildRpcUrl({ endpoint, version, action, accessKeyId, accessKeySecret, extra = {} }) {
  const params = {
    Action: action,
    Version: version,
    Format: 'JSON',
    AccessKeyId: accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    ...extra,
  };
  const { canonical, signature } = signRpc({ accessKeyId, accessKeySecret, params });
  return `https://${endpoint}/?${canonical}&Signature=${encodeURIComponent(signature)}`;
}

export function createAliyunExecutor({
  // One region drives BOTH the endpoint host and the RegionId parameter.
  // Submitting a cn-shenzhen job to ice.cn-shanghai was observed to leave the
  // job in Status=Init indefinitely, so the two must not be configured apart.
  region = 'cn-shenzhen',
  endpoint = null,
  version = '2020-11-09',
  regionId = null,
  accessKeyId,
  accessKeySecret,
  fetchImpl = fetch,
  pollIntervalMs = 3000,
  timeoutMs = 30 * 60_000,
  logger = console,
} = {}) {
  if (!accessKeyId || !accessKeySecret) {
    throw new ProviderError('ALIYUN_NOT_CONFIGURED', 'Aliyun credentials are missing', { status: 503 });
  }
  const resolvedEndpoint = endpoint || `ice.${region}.aliyuncs.com`;
  const resolvedRegionId = regionId || region;

  const rpc = async (action, extra = {}) => {
    const url = buildRpcUrl({ endpoint: resolvedEndpoint, version, action, accessKeyId, accessKeySecret, extra });
    const res = await fetchImpl(url, { method: 'GET' });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch {
      throw new ProviderError('ALIYUN_INVALID_RESPONSE', `${action} returned non-JSON`, {
        status: 502, details: text.slice(0, 300),
      });
    }
    if (body.Code) {
      throw new ProviderError(`ALIYUN_${body.Code}`.replace(/[^A-Z0-9_]/gi, '_'),
        `${action}: ${body.Code} ${body.Message || ''}`.trim(),
        { status: 502, details: body.RequestId });
    }
    return body;
  };

  return {
    rpc,

    /**
     * Submit a producing job.
     *
     * @param {object} args
     * @param {object} args.timeline         from aliyun-timeline.js
     * @param {string} args.outputMediaURL   OSS URL the finished video is written to
     * @param {string} args.outputMediaTarget  'OSS' (default) or 'VOD'
     * @param {?string} args.templateId      optional cloud-editing template id
     */
    async submit({ timeline, outputMediaURL, outputMediaTarget = 'OSS', templateId = null, extra = {} }) {
      if (!timeline || typeof timeline !== 'object') {
        throw new ProviderError('ALIYUN_TIMELINE_REQUIRED', 'a compiled timeline is required', { status: 400 });
      }
      if (!outputMediaURL) {
        throw new ProviderError('ALIYUN_OUTPUT_REQUIRED', 'outputMediaURL is required', { status: 400 });
      }

      const body = await rpc('SubmitMediaProducingJob', {
        RegionId: resolvedRegionId,
        Timeline: JSON.stringify(timeline),
        OutputMediaTarget: outputMediaTarget,
        OutputMediaConfig: JSON.stringify({ MediaURL: outputMediaURL }),
        ...(templateId ? { TemplateId: templateId } : {}),
        ...extra,
      });

      logger.info?.('[aliyun] job submitted', {
        jobId: body.JobId,
        projectId: body.ProjectId,
        requestId: body.RequestId,
      });

      return { jobId: body.JobId, projectId: body.ProjectId, raw: body };
    },

    /** Poll GetMediaProducingJob until it leaves the running state. */
    async waitFor({ jobId, onProgress = async () => {} }) {
      if (!jobId) throw new ProviderError('ALIYUN_JOB_ID_REQUIRED', 'jobId is required', { status: 400 });
      const deadline = Date.now() + timeoutMs;

      for (;;) {
        const body = await rpc('GetMediaProducingJob', { JobId: jobId });
        const job = body.MediaProducingJob || body;
        const status = String(job.Status || '').trim();

        await onProgress(
          status === 'Success' ? 100 : status === 'Failed' ? 100 : 50,
          `IMS ${status || 'Running'}`,
        );

        if (status === 'Success') {
          const url = job.OutputMediaURL || job.MediaURL || null;
          if (!url) {
            throw new ProviderError('ALIYUN_OUTPUT_MISSING',
              'job succeeded but returned no OutputMediaURL', { status: 502, details: job });
          }
          return { status, outputUrl: url, durationSeconds: Number(job.Duration) || null, raw: job };
        }
        if (status === 'Failed') {
          throw new ProviderError('ALIYUN_JOB_FAILED',
            `IMS job failed: ${job.Message || job.Code || 'unknown'}`,
            { status: 502, details: job });
        }
        if (Date.now() > deadline) {
          throw new ProviderError('ALIYUN_JOB_TIMEOUT',
            `IMS job ${jobId} did not finish within ${timeoutMs}ms`, { status: 504 });
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    },

    /**
     * Submit and wait. Kept separate from submit() so a caller can hand the
     * job id back to an API response immediately, like the local service does.
     */
    async submitAndWait({ timeline, outputMediaURL, outputMediaTarget = 'OSS', onProgress = async () => {}, extra = {} }) {
      const submitted = await this.submit({ timeline, outputMediaURL, outputMediaTarget, extra });
      const finished = await this.waitFor({ jobId: submitted.jobId, onProgress });
      return { ...submitted, ...finished };
    },
  };
}

/**
 * Presence check without a submit, so a caller can fail fast on a
 * misconfigured deployment. Returns the raw error rather than throwing.
 */
export async function probeExecutor(executor) {
  try {
    const body = await executor.rpc('GetCategories', { RegionId: 'cn-shenzhen', PageSize: 1 });
    return { ok: true, requestId: body.RequestId };
  } catch (error) {
    return { ok: false, code: error.code, message: error.message };
  }
}
