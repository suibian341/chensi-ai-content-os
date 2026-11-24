import { fetchJson } from '../lib/http.js';
import { createQueryPlan } from '../lib/semantic-search.js';
import { getProviderConfig } from './config.js';

function ratioLabel(width, height) {
  if (!width || !height) return '其他';
  const ratio = width / height;
  if (Math.abs(ratio - 9 / 16) < 0.08) return '9:16';
  if (Math.abs(ratio - 16 / 9) < 0.12) return '16:9';
  if (Math.abs(ratio - 1) < 0.08) return '1:1';
  if (Math.abs(ratio - 4 / 5) < 0.08) return '4:5';
  return width < height ? '9:16' : '16:9';
}

function chooseFile(video) {
  return (Array.isArray(video.video_files) ? video.video_files : [])
    .filter((file) => file.link && (!file.file_type || String(file.file_type).includes('mp4')))
    .sort((a, b) => {
      const score = (file) => {
        const width = Number(file.width || 0);
        const height = Number(file.height || 0);
        return Math.min(width * height, 1920 * 1080) + (Math.min(width, height) >= 720 ? 1_000_000_000 : 0) + (file.quality === 'hd' ? 100_000_000 : 0);
      };
      return score(b) - score(a);
    })[0];
}

export async function searchPexels(query, options = {}) {
  const config = getProviderConfig().pexels;
  if (!config.enabled) return [];
  const plan = options.plan || createQueryPlan(query, options);
  const webQuery = plan.web_query || plan.semantic_query || query;
  const perPage = Math.min(80, Math.max(30, (plan.limit || 10) * 5));
  const orientation = { '9:16': 'portrait', '4:5': 'portrait', '16:9': 'landscape', '1:1': 'square' }[plan.ratio] || '';
  const params = new URLSearchParams({ query: webQuery, per_page: String(perPage) });
  if (orientation) params.set('orientation', orientation);
  const payload = await fetchJson(`https://api.pexels.com/videos/search?${params}`, {
    headers: { Authorization: config.apiKey },
    timeoutMs: config.timeoutMs
  });
  return (Array.isArray(payload?.videos) ? payload.videos : []).map((video, index) => {
    const file = chooseFile(video);
    if (!file) return null;
    const width = Number(file.width || video.width || 0);
    const height = Number(file.height || video.height || 0);
    return {
      id: `pexels_${video.id}`,
      name: `${webQuery} · 在线素材 ${index + 1}`,
      kind: '场景',
      size: '网络素材',
      mimeType: 'video/mp4',
      source: '在线素材',
      sourcePage: video.url,
      author: video.user?.name || '',
      url: file.link,
      previewUrl: video.image,
      description: `网络视频；时长 ${video.duration || 0} 秒；分辨率 ${width}x${height}`,
      ratio: ratioLabel(width, height),
      durationSeconds: Number(video.duration || 0) || null,
      relevanceScore: Math.max(35, 80 - index * 1.5),
      external: true
    };
  }).filter(Boolean).slice(0, plan.limit || 10);
}
