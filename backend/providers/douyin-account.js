import { fetchJson, ProviderError } from '../lib/http.js';
import { getProviderConfig } from './config.js';

function config() {
  return getProviderConfig().douyinAccount;
}

function endpoint(pathname) {
  return `${String(config().baseUrl || '').replace(/\/+$/, '')}/${String(pathname || '').replace(/^\/+/, '')}`;
}

function serviceError(error) {
  if (error?.code === 'PROVIDER_UNREACHABLE' || error?.code === 'PROVIDER_TIMEOUT') {
    return new ProviderError('DOUYIN_ACCOUNT_SERVICE_UNAVAILABLE', '抖音账号数据暂时无法读取，请检查解析配置和网络', { status: 503, retryable: true, details: error.details });
  }
  if (error?.code === 'PROVIDER_HTTP_ERROR' && [401, 403].includes(error.status)) {
    return new ProviderError('DOUYIN_ACCOUNT_API_KEY_INVALID', '抖音内容解析配置无效或额度不足，请在后台检查配置', { status: 503, retryable: false, details: error.details });
  }
  return error;
}

async function request(pathname, query = {}) {
  if (!config().enabled) throw new ProviderError('DOUYIN_ACCOUNT_NOT_CONFIGURED', '抖音账号公开内容读取功能尚未配置', { status: 503 });
  const url = new URL(endpoint(pathname));
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  });
  try {
    return await fetchJson(url, {
      timeoutMs: config().timeoutMs,
      headers: { Authorization: `Bearer ${config().apiKey}`, Accept: 'application/json' }
    });
  } catch (error) {
    throw serviceError(error);
  }
}

function unwrap(value) {
  if (!value || typeof value !== 'object') return value;
  if (value.data && typeof value.data === 'object') return unwrap(value.data);
  if (value.result && typeof value.result === 'object') return unwrap(value.result);
  return value;
}

function findValue(value, names, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 5) return '';
  for (const name of names) {
    if (value[name] !== undefined && value[name] !== null && String(value[name]).trim()) return String(value[name]).trim();
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      const found = findValue(child, names, depth + 1);
      if (found) return found;
    }
  }
  return '';
}

function extractUrl(value) {
  const match = String(value || '').match(/https?:\/\/[^\s]+/i);
  if (!match) return '';
  return match[0].replace(/[\u3002，。；;、！？!?）》）\]】>]+$/g, '');
}

function findArray(value, names, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return [];
  for (const name of names) if (Array.isArray(value[name])) return value[name];
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      const found = findArray(child, names, depth + 1);
      if (found.length) return found;
    }
  }
  return [];
}

function findSecUserId(value) {
  const unwrapped = unwrap(value);
  if (typeof unwrapped === 'string' && /^MS4wLjAB[A-Za-z0-9_-]+$/.test(unwrapped.trim())) return unwrapped.trim();
  for (const direct of [unwrapped?.data, unwrapped?.result]) {
    if (typeof direct === 'string' && /^MS4wLjAB[A-Za-z0-9_-]+$/.test(direct.trim())) return direct.trim();
  }
  const candidate = findValue(unwrapped, ['sec_user_id', 'secUserId', 'sec_uid', 'secUid']);
  return /^MS4wLjAB[A-Za-z0-9_-]+$/.test(candidate) ? candidate : '';
}

function normalizeAccountInput(value) {
  const input = String(value || '').trim();
  if (!input) throw new ProviderError('DOUYIN_ACCOUNT_REQUIRED', '请填写抖音账号名称、抖音号或主页链接', { status: 400 });
  const url = extractUrl(input);
  if (url) return { url };
  if (/^MS4wLjAB[A-Za-z0-9_-]+$/.test(input)) return { secUserId: input };
  return { uniqueId: input.replace(/^@/, '') };
}

function normalizePost(item) {
  const id = findValue(item, ['aweme_id', 'awemeId', 'video_id', 'videoId', 'id']);
  const title = findValue(item, ['desc', 'title', 'description']) || (id ? `抖音作品 ${id}` : '抖音作品');
  const url = findValue(item, ['share_url', 'shareUrl', 'url', 'video_url', 'videoUrl']) || (id ? `https://www.douyin.com/video/${id}` : '');
  const stats = item.statistics || item.stats || {};
  return {
    id: id || null,
    title: title.slice(0, 200),
    url,
    createdAt: findValue(item, ['create_time', 'createTime', 'created_at']),
    duration: Number(item.duration || item.video?.duration || 0) || null,
    diggCount: Number(stats.digg_count || stats.diggCount || 0) || 0,
    commentCount: Number(stats.comment_count || stats.commentCount || 0) || 0,
    shareCount: Number(stats.share_count || stats.shareCount || 0) || 0
  };
}

export async function fetchDouyinAccount(value, options = {}) {
  const input = normalizeAccountInput(value);
  let profilePayload;
  let secUserId = input.secUserId || '';
  let resolvedSecUserId = secUserId;
  if (input.url) {
    const extracted = await request('/api/v1/douyin/web/get_sec_user_id', { url: input.url });
    secUserId = findSecUserId(extracted);
    resolvedSecUserId = secUserId;
    if (!secUserId) throw new ProviderError('DOUYIN_ACCOUNT_ID_NOT_FOUND', '没有从该主页链接解析出抖音账号 ID', { status: 422, details: extracted });
  }
  if (input.uniqueId) {
    profilePayload = await request('/api/v1/douyin/web/handler_user_profile_v2', { unique_id: input.uniqueId });
    secUserId = findSecUserId(profilePayload) || secUserId;
  } else if (secUserId) {
    profilePayload = await request('/api/v1/douyin/web/handler_user_profile', { sec_user_id: secUserId });
    // Profile payloads can contain recommended/related users. Keep the ID resolved
    // from the submitted homepage as the authority instead of recursively picking
    // an unrelated nested sec_user_id.
    secUserId = resolvedSecUserId || findSecUserId(profilePayload) || secUserId;
  }
  if (!secUserId) throw new ProviderError('DOUYIN_ACCOUNT_ID_NOT_FOUND', '没有解析到抖音账号 sec_user_id，无法读取真实作品列表', { status: 422 });

  const maxPosts = Math.max(1, Math.min(20, Number(options.maxPosts || config().maxPosts || 10)));
  const posts = [];
  let cursor = '0';
  let hasMore = true;
  for (let page = 0; page < 5 && hasMore && posts.length < maxPosts; page += 1) {
    const postQuery = {
      sec_user_id: secUserId,
      max_cursor: cursor,
      count: Math.min(20, maxPosts - posts.length)
    };
    let payload;
    try {
      payload = await request('/api/v1/douyin/web/fetch_user_post_videos', {
        ...postQuery,
        filter_type: options.filterType || '0'
      });
    } catch (error) {
      // The upstream occasionally rejects optional filters after a schema rollout.
      // Retry once with its stable, minimal parameter set before failing the job.
      if (error?.code !== 'PROVIDER_HTTP_ERROR' || error?.status !== 400) throw error;
      try {
        payload = await request('/api/v1/douyin/web/fetch_user_post_videos', postQuery);
      } catch (minimalError) {
        if (minimalError?.code !== 'PROVIDER_HTTP_ERROR' || minimalError?.status !== 400) throw minimalError;
        // The Web endpoint occasionally rejects otherwise valid public accounts.
        // The provider's App V3 endpoint returns the same public work list and is
        // used only as a transparent fallback.
        payload = await request('/api/v1/douyin/app/v3/fetch_user_post_videos', {
          ...postQuery,
          sort_type: '0',
          channel: 'normal'
        });
      }
    }
    const data = unwrap(payload);
    const items = findArray(data, ['aweme_list', 'awemeList', 'items', 'videos', 'video_list', 'videoList']);
    for (const item of items) {
      const post = normalizePost(item);
      if (post.url && !posts.some((current) => current.id && current.id === post.id || current.url === post.url)) posts.push(post);
      if (posts.length >= maxPosts) break;
    }
    const nextCursor = findValue(data, ['max_cursor', 'maxCursor', 'cursor']);
    const moreValue = findValue(data, ['has_more', 'hasMore']);
    hasMore = moreValue === '' ? Boolean(nextCursor && nextCursor !== cursor && items.length) : ['1', 'true'].includes(moreValue.toLowerCase());
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
  }
  if (!posts.length) throw new ProviderError('DOUYIN_ACCOUNT_POSTS_EMPTY', '没有读取到该账号的公开作品，无法进行真实账号拆解', { status: 422 });
  const profile = unwrap(profilePayload || {});
  return {
    provider: 'tikhub',
    account: findValue(profile, ['nickname', 'unique_id', 'uniqueId', 'short_id', 'shortId']) || input.uniqueId || input.url || value,
    secUserId,
    profile: {
      nickname: findValue(profile, ['nickname', 'nick_name', 'nickName']),
      uniqueId: findValue(profile, ['unique_id', 'uniqueId']),
      avatar: findValue(profile, ['avatar', 'avatar_url', 'avatarUrl'])
    },
    posts,
    fetchedAt: new Date().toISOString()
  };
}
