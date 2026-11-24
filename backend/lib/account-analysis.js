export function accountAnalysisSampleState(samples = []) {
  const list = Array.isArray(samples) ? samples : [];
  const pending = list.filter((item) => ['analyzing', 'queued'].includes(item?.status));
  const analyzed = list.filter((item) => item?.status === 'analyzed' && item?.analysisVersion === 'multimodal-v1');
  const failed = list.filter((item) => item?.status === 'failed');
  return {
    pending,
    analyzed,
    failed,
    terminal: list.length > 0 && pending.length === 0
  };
}

function durationSeconds(value) {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration <= 0) return Number.POSITIVE_INFINITY;
  return duration > 10_000 ? duration / 1_000 : duration;
}

export function selectAccountAnalysisPosts(posts = [], limit = 4) {
  const selectedLimit = Math.max(1, Math.trunc(Number(limit) || 4));
  const candidates = (Array.isArray(posts) ? posts : [])
    .map((post, index) => ({ post, index, duration: durationSeconds(post?.duration) }))
    .filter(({ post }) => post && String(post.url || '').trim());
  return candidates
    .sort((a, b) => a.duration - b.duration || a.index - b.index)
    .slice(0, selectedLimit)
    .sort((a, b) => a.index - b.index)
    .map(({ post }) => post);
}

export async function runWithConcurrency(items, concurrency, operation) {
  const list = Array.isArray(items) ? items : [];
  const workerCount = Math.min(list.length, Math.max(1, Math.trunc(Number(concurrency) || 1)));
  let nextIndex = 0;
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < list.length) {
      const index = nextIndex;
      nextIndex += 1;
      await operation(list[index], index);
    }
  });
  await Promise.allSettled(workers);
}
