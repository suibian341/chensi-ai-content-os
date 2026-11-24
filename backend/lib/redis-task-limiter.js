import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';

const acquireScript = `
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
  if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[3]) then
    redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
    return 1
  end
  return 0
`;
const releaseScript = `return redis.call('ZREM', KEYS[1], ARGV[1])`;

export function configuredRedisTaskLimiter(env = process.env) {
  const url = String(env.IP_AGENT_REDIS_URL || '').trim();
  if (!url) return null;
  const configuredLimit = Number(env.IP_AGENT_REDIS_CONCURRENCY);
  const concurrency = Number.isFinite(configuredLimit) && configuredLimit > 0
    ? Math.min(20, Math.max(1, Math.trunc(configuredLimit)))
    : 2;
  const configuredLease = Number(env.IP_AGENT_REDIS_TASK_LEASE_MS);
  const leaseMs = Number.isFinite(configuredLease) && configuredLease > 0
    ? Math.max(60_000, configuredLease)
    : 10 * 60_000;
  const configuredAcquire = Number(env.IP_AGENT_REDIS_ACQUIRE_TIMEOUT_MS);
  const acquireTimeoutMs = Number.isFinite(configuredAcquire) && configuredAcquire > 0
    ? Math.max(1_000, configuredAcquire)
    : 15_000;
  const required = String(env.IP_AGENT_REDIS_REQUIRED || '').trim() === '1';
  return { url, concurrency, leaseMs, acquireTimeoutMs, required };
}

export function createRedisTaskLimiter(config) {
  if (!config?.url) return null;
  const key = 'chensi:task-slots';
  const client = createClient({ url: config.url });
  let connectPromise = null;
  let lastError = null;
  let warnedUnavailable = false;
  client.on('error', (error) => {
    lastError = error;
    if (!warnedUnavailable) {
      warnedUnavailable = true;
      console.warn('redis task limiter unavailable; using local queue', error?.message || error);
    }
  });

  async function connect() {
    if (client.isReady) return;
    if (!connectPromise) {
      connectPromise = client.connect().catch((error) => {
        connectPromise = null;
        lastError = error;
        throw error;
      });
    }
    await connectPromise;
  }

  async function acquire(token) {
    const deadline = Date.now() + config.acquireTimeoutMs;
    while (Date.now() < deadline) {
      const now = Date.now();
      const result = await client.eval(acquireScript, {
        keys: [key],
        arguments: [String(now), String(now + config.leaseMs), String(config.concurrency), token]
      });
      if (Number(result) === 1) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  }

  async function release(token) {
    if (!client.isReady) return;
    await client.eval(releaseScript, { keys: [key], arguments: [token] }).catch(() => {});
  }

  async function withPermit(run) {
    let connected = false;
    try {
      await connect();
      connected = true;
    } catch (error) {
      if (config.required) throw Object.assign(error, { code: 'REDIS_UNAVAILABLE', retryable: true });
    }
    if (!connected) return run();
    const token = randomUUID();
    if (!await acquire(token)) {
      throw Object.assign(new Error('任务队列繁忙，请稍后重试'), { code: 'TASK_QUEUE_BACKPRESSURE', retryable: true, statusCode: 429 });
    }
    const renewTimer = setInterval(() => {
      if (!client.isReady) return;
      client.zAdd(key, [{ score: Date.now() + config.leaseMs, value: token }]).catch(() => {});
    }, Math.max(1_000, Math.floor(config.leaseMs / 3)));
    renewTimer.unref?.();
    try {
      return await run();
    } finally {
      clearInterval(renewTimer);
      await release(token);
    }
  }

  async function close() {
    if (client.isOpen) await client.quit().catch(() => client.disconnect());
  }

  async function warmup() {
    try {
      await connect();
      return true;
    } catch (error) {
      if (config.required) throw Object.assign(error, { code: 'REDIS_UNAVAILABLE', retryable: true });
      return false;
    }
  }

  function status() {
    return { configured: true, connected: client.isReady, error: lastError?.code || null, concurrency: config.concurrency };
  }

  return { withPermit, close, warmup, status };
}
