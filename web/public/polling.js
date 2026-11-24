export function createPollingManager({
  now = () => Date.now(),
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (timer) => clearTimeout(timer),
  pauseWhenHidden = true,
  hiddenIntervalMs = 10_000
} = {}) {
  const polls = new Map();
  const visibilityTarget = pauseWhenHidden && typeof document !== 'undefined' ? document : null;

  function stop(key) {
    const entry = polls.get(key);
    if (!entry) return false;
    entry.stopped = true;
    if (entry.timer !== null) clearTimer(entry.timer);
    polls.delete(key);
    return true;
  }

  function stopWhere(predicate) {
    for (const [key, entry] of polls) {
      if (predicate(entry, key)) stop(key);
    }
  }

  async function notify(callback, value) {
    if (!callback) return;
    try {
      await callback(value);
    } catch (error) {
      console.error('polling completion handler failed', error);
    }
  }

  function start(key, {
    poll,
    intervalMs = 1_000,
    timeoutMs = 30 * 60_000,
    startedAt = now(),
    maxFailures = 3,
    onTimeout,
    onError,
    meta = null
  }) {
    if (!key || typeof poll !== 'function' || polls.has(key)) return false;
    const parsedStartedAt = Number(startedAt);
    const entry = {
      key,
      timer: null,
      stopped: false,
      failures: 0,
      startedAt: Number.isFinite(parsedStartedAt) ? parsedStartedAt : now(),
      meta,
      wake: null
    };

    const finish = async (callback, value) => {
      if (polls.get(key) !== entry) return;
      stop(key);
      await notify(callback, value);
    };

    const schedule = (delay = intervalMs) => {
      if (entry.stopped || polls.get(key) !== entry) return;
      entry.timer = setTimer(tick, Math.max(0, delay));
    };

    const tick = async () => {
      if (entry.stopped || polls.get(key) !== entry) return;
      entry.timer = null;
      if (visibilityTarget?.visibilityState === 'hidden') {
        schedule(Math.max(hiddenIntervalMs, intervalMs));
        return;
      }
      const remainingMs = timeoutMs - (now() - entry.startedAt);
      if (remainingMs <= 0) return finish(onTimeout);
      try {
        const done = await poll();
        if (entry.stopped || polls.get(key) !== entry) return;
        entry.failures = 0;
        if (done) return finish();
      } catch (error) {
        if (entry.stopped || polls.get(key) !== entry) return;
        entry.failures += 1;
        if (entry.failures >= Math.max(1, maxFailures)) return finish(onError, error);
      }
      schedule(Math.min(intervalMs, Math.max(0, remainingMs)));
    };

    entry.wake = tick;
    polls.set(key, entry);
    schedule(Math.min(intervalMs, Math.max(0, timeoutMs - (now() - entry.startedAt))));
    return true;
  }

  visibilityTarget?.addEventListener('visibilitychange', () => {
    if (visibilityTarget.visibilityState === 'hidden') return;
    for (const entry of polls.values()) {
      if (entry.stopped || !entry.wake) continue;
      if (entry.timer !== null) clearTimer(entry.timer);
      entry.timer = setTimer(entry.wake, 0);
    }
  });

  return {
    start,
    stop,
    stopWhere,
    has: (key) => polls.has(key),
    get size() { return polls.size; }
  };
}
