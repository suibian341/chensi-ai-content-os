import { createWriteStream, promises as fs } from 'node:fs';
import dns from 'node:dns/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { fetchJson, ProviderError } from '../lib/http.js';
import { getProviderConfig } from './config.js';
import { updateProviderOverrides } from '../lib/provider-settings.js';
import { replaceFileDurably } from '../lib/file-persistence.js';
import { extensionMime, runCommand } from './media.js';
import { decryptWechatVideo } from './wechat-video-decrypt.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const runtimeDataDir = path.resolve(process.env.IP_AGENT_DATA_DIR || path.join(projectRoot, 'runtime-data'));
const cookieDirectory = path.join(runtimeDataDir, 'platform-cookies');
const runtimeCookieFile = path.join(cookieDirectory, 'platform-cookies.txt');
const cookieMetadataFile = path.join(cookieDirectory, 'status.json');
const supportedCookieBrowsers = new Set(['chrome', 'edge', 'firefox', 'brave', 'chromium', 'opera', 'vivaldi']);
let cookieRefreshPromise = null;

async function readCookieMetadata() {
  try {
    const value = JSON.parse(await fs.readFile(cookieMetadataFile, 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

async function writeCookieMetadata(value) {
  await fs.mkdir(cookieDirectory, { recursive: true });
  const temporary = `${cookieMetadataFile}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  const content = JSON.stringify(value, null, 2);
  await fs.writeFile(temporary, content, 'utf8');
  await replaceFileDurably(temporary, cookieMetadataFile, content);
}

function cookieStatusMessage(status, browser = '') {
  if (status === 'valid') return '\u0059\u0054\u002d\u0064\u006c\u0070 \u0043\u006f\u006f\u006b\u0069\u0065 \u5df2\u5c31\u7eea\uff0c\u53ef\u76f4\u63a5\u62c6\u89e3\u3002';
  if (status === 'browser') return `\u5c06\u5728\u62c6\u89e3\u65f6\u81ea\u52a8\u8bfb\u53d6 ${browser || '\u6d4f\u89c8\u5668'} Cookie\u3002`;
  if (status === 'refreshing') return '\u6b63\u5728\u4ece\u6d4f\u89c8\u5668\u5bfc\u51fa Cookie\uff0c\u8bf7\u4e0d\u8981\u5173\u95ed\u9875\u9762\u3002';
  if (status === 'locked') return '\u65e0\u6cd5\u8bfb\u53d6\u6d4f\u89c8\u5668 Cookie\u6570\u636e\u5e93\uff0c\u8bf7\u5b8c\u5168\u9000\u51fa Chrome \u540e\u518d\u70b9\u51fb\u83b7\u53d6\u3002';
  if (status === 'invalid') return '\u4fdd\u5b58\u7684 Cookie \u5df2\u5931\u6548\uff0c\u8bf7\u70b9\u51fb\u83b7\u53d6\u66f4\u65b0\u3002';
  return '\u5c1a\u672a\u914d\u7f6e\u53ef\u7528\u7684 Cookie\uff0c\u8bf7\u70b9\u51fb\u83b7\u53d6\u3002';
}

export async function platformCookieStatus() {
  const config = getProviderConfig().platformMedia;
  const metadata = await readCookieMetadata();
  const configuredBrowser = String(config.cookiesFromBrowser || metadata.browser || '').trim().toLowerCase();
  const configuredFile = String(config.cookiesFile || runtimeCookieFile).trim();
  const stat = await fs.stat(configuredFile).catch(() => null);
  let status = 'unconfigured';
  if (metadata.status === 'refreshing') status = 'refreshing';
  else if (metadata.status === 'locked') status = 'locked';
  else if (metadata.status === 'invalid') status = 'invalid';
  else if (stat?.isFile() && stat.size > 0) status = 'valid';
  else if (configuredBrowser) status = 'browser';
  return {
    status,
    state: status,
    browser: configuredBrowser || null,
    source: status === 'valid' ? (metadata.source || 'cookie_file') : (configuredBrowser ? 'browser' : null),
    configured: status === 'valid' || status === 'browser',
    canRefresh: true,
    updatedAt: metadata.updatedAt || (stat?.mtime?.toISOString() || null),
    lastError: metadata.status === 'invalid' || metadata.status === 'locked' ? (metadata.error || null) : null,
    message: cookieStatusMessage(status, configuredBrowser)
  };
}

export async function refreshPlatformCookies({ browser } = {}) {
  if (cookieRefreshPromise) return cookieRefreshPromise;
  cookieRefreshPromise = (async () => {
    const config = getProviderConfig().platformMedia;
    const commandParts = splitCommandLine(config.ytdlpCommand || 'python -m yt_dlp');
    const selectedBrowser = String(browser || config.cookiesFromBrowser || (await readCookieMetadata()).browser || 'chrome').trim().toLowerCase();
    if (!supportedCookieBrowsers.has(selectedBrowser)) {
      cookieRefreshPromise = null;
      throw new ProviderError('PLATFORM_COOKIE_BROWSER_UNSUPPORTED', '\u4e0d\u652f\u6301\u8be5\u6d4f\u89c8\u5668 Cookie \u6765\u6e90', { status: 400 });
    }
    if (!commandParts.length) {
      cookieRefreshPromise = null;
      throw new ProviderError('YTDLP_UNAVAILABLE', '\u540e\u53f0\u672a\u914d\u7f6e yt-dlp \u547d\u4ee4', { status: 503 });
    }
    await fs.mkdir(cookieDirectory, { recursive: true });
    await writeCookieMetadata({ status: 'refreshing', browser: selectedBrowser, startedAt: new Date().toISOString() });
    const temporaryCookieFile = `${runtimeCookieFile}.${process.pid}.${Date.now()}.tmp`;
    const args = [
      ...commandParts.slice(1),
      '--cookies-from-browser', selectedBrowser,
      '--cookies', temporaryCookieFile,
      '--skip-download', '--simulate', '--ignore-no-formats', '--no-warnings',
      'https://www.douyin.com/'
    ];
    try {
      await runCommand(commandParts[0], args, {
        timeoutMs: Math.min(config.timeoutMs, 90_000),
        errorCode: 'PLATFORM_COOKIE_REFRESH_FAILED',
        errorMessage: '\u83b7\u53d6\u5e73\u53f0 Cookie \u5931\u8d25'
      });
      const stat = await fs.stat(temporaryCookieFile).catch(() => null);
      if (!stat?.isFile() || stat.size <= 0) throw new ProviderError('PLATFORM_COOKIE_REFRESH_EMPTY', '\u6d4f\u89c8\u5668\u4e2d\u6ca1\u6709\u53ef\u7528\u7684 Cookie', { status: 422 });
      const content = await fs.readFile(temporaryCookieFile);
      await replaceFileDurably(temporaryCookieFile, runtimeCookieFile, content);
      await updateProviderOverrides({ IP_AGENT_YTDLP_COOKIES_FILE: runtimeCookieFile, IP_AGENT_YTDLP_COOKIES_FROM_BROWSER: '' });
      const updatedAt = new Date().toISOString();
      await writeCookieMetadata({ status: 'valid', browser: selectedBrowser, source: 'cookie_file', updatedAt, size: stat.size });
      return platformCookieStatus();
    } catch (error) {
      await fs.rm(temporaryCookieFile, { force: true }).catch(() => {});
      const details = `${error?.message || ''}\n${error?.details || ''}`;
      const locked = /Could not copy .* cookie database|database is locked|cannot copy.*cookie/i.test(details);
      const status = locked ? 'locked' : 'invalid';
      await writeCookieMetadata({ status, browser: selectedBrowser, error: locked ? cookieStatusMessage('locked', selectedBrowser) : (error?.message || cookieStatusMessage('invalid')), updatedAt: new Date().toISOString() }).catch(() => {});
      if (locked) throw new ProviderError('PLATFORM_COOKIE_BROWSER_LOCKED', cookieStatusMessage('locked', selectedBrowser), { status: 422, details: error?.details });
      throw error;
    }
  })();
  cookieRefreshPromise = cookieRefreshPromise.finally(() => { cookieRefreshPromise = null; });
  return cookieRefreshPromise;
}

async function markCookieInvalid(error) {
  const details = `${error?.message || ''}\n${error?.details || ''}`;
  if (!/fresh cookies|cookies.*needed|sign in|login required|not logged in|\u9700\u8981.*cookie/i.test(details)) return;
  const metadata = await readCookieMetadata();
  await writeCookieMetadata({ ...metadata, status: 'invalid', error: error?.message || cookieStatusMessage('invalid'), updatedAt: new Date().toISOString() }).catch(() => {});
}

const platformHosts = {
  '抖音': ['douyin.com', 'iesdouyin.com'],
  '小红书': ['xiaohongshu.com', 'xhslink.com', 'xhslink.cn'],
  '视频号': ['weixin.qq.com', 'channels.weixin.qq.com', 'wechat.com']
};

function hostMatches(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function extractFirstUrl(value) {
  const match = String(value || '').match(/https?:\/\/[^\s<>"']+/i);
  if (!match) return '';
  const candidate = match[0].replace(/[，。；、！？：）】》」』]+$/u, '').replace(/[),.;!?\]}]+$/, '');
  try {
    const url = new URL(candidate);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

export function detectPlatform(value) {
  const sourceUrl = extractFirstUrl(value);
  if (!sourceUrl) return '其他';
  const hostname = new URL(sourceUrl).hostname.toLowerCase();
  for (const [platform, domains] of Object.entries(platformHosts)) {
    if (domains.some((domain) => hostMatches(hostname, domain))) return platform;
  }
  return '其他';
}

export function isPlatformShareUrl(value) {
  return detectPlatform(value) !== '其他';
}

function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [first, second] = parts;
  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19))
    || first >= 224;
}

function isPrivateAddress(value) {
  const address = String(value || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIPv4(address)) return isPrivateIpv4(address);
  if (!net.isIPv6(address)) return false;
  if (address.startsWith('::ffff:')) return isPrivateIpv4(address.slice('::ffff:'.length));
  return address === '::' || address === '::1' || address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe8') || address.startsWith('fe9') || address.startsWith('fea') || address.startsWith('feb');
}

export async function validateExternalUrl(value) {
  const sourceUrl = extractFirstUrl(value);
  if (!sourceUrl) throw new ProviderError('INVALID_MEDIA_URL', '没有找到有效的 HTTP/HTTPS 视频链接', { status: 400 });
  const parsed = new URL(sourceUrl);
  if (parsed.username || parsed.password) throw new ProviderError('UNSAFE_MEDIA_URL', '视频链接不能包含账号或密码', { status: 400 });
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || isPrivateAddress(hostname)) {
    throw new ProviderError('UNSAFE_MEDIA_URL', '不允许访问本机或内网视频地址', { status: 400 });
  }
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new ProviderError('SOURCE_URL_UNREACHABLE', '视频链接域名无法解析', { retryable: true, details: error.message });
  }
  if (!addresses.length || addresses.some((item) => isPrivateAddress(item.address))) {
    throw new ProviderError('UNSAFE_MEDIA_URL', '视频链接解析到了本机或内网地址', { status: 400 });
  }
  return sourceUrl;
}

export function splitCommandLine(value) {
  const parts = [];
  for (const match of String(value || '').matchAll(/"([^"]*)"|'([^']*)'|[^\s]+/g)) {
    parts.push(match[1] ?? match[2] ?? match[0]);
  }
  return parts;
}

async function cleanupDirectory(directory) {
  if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
}

async function prepareAnalysisCopy(filePath, directory, maxBytes) {
  let currentPath = filePath;
  let stat = await fs.stat(currentPath).catch(() => null);
  if (!stat?.isFile()) throw new ProviderError('PLATFORM_VIDEO_NOT_FOUND', '平台解析完成但没有生成可读取的视频文件');
  if (stat.size <= maxBytes) return { filePath: currentPath, stat };

  const mediaConfig = getProviderConfig().media;
  if (!mediaConfig.enabled) {
    throw new ProviderError('PLATFORM_VIDEO_TOO_LARGE', '平台原视频超过分析上限，且本地视频压缩功能未启用');
  }
  const profiles = [
    { name: 'analysis-360', height: 360, videoRate: '120k', audioRate: '32k' },
    { name: 'analysis-240', height: 240, videoRate: '80k', audioRate: '24k' }
  ];
  for (const profile of profiles) {
    const outputPath = path.join(directory, `${profile.name}.mp4`);
    await runCommand(mediaConfig.ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-i', currentPath,
      '-vf', `scale=-2:${profile.height}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', profile.videoRate,
      '-maxrate', profile.videoRate, '-bufsize', `${Number.parseInt(profile.videoRate, 10) * 2}k`,
      '-c:a', 'aac', '-b:a', profile.audioRate,
      '-movflags', '+faststart', '-y', outputPath
    ], {
      timeoutMs: mediaConfig.timeoutMs,
      errorCode: 'PLATFORM_VIDEO_COMPRESSION_FAILED',
      errorMessage: '平台原视频过大，分析副本压缩失败'
    });
    stat = await fs.stat(outputPath).catch(() => null);
    if (stat?.isFile() && stat.size <= maxBytes) return { filePath: outputPath, stat };
    currentPath = outputPath;
  }
  throw new ProviderError('PLATFORM_VIDEO_TOO_LARGE', `平台视频完整压缩后仍超过 ${Math.round(maxBytes / 1024 / 1024)} MB，请上传较短的授权视频片段`);
}

function tikhubEndpoint(pathname) {
  const config = getProviderConfig().douyinAccount;
  return `${String(config.baseUrl || 'https://api.tikhub.io').replace(/\/+$/, '')}/${String(pathname || '').replace(/^\/+/, '')}`;
}

async function requestContentParser(pathname, { query = {}, method = 'GET', body = null, timeoutMs = null } = {}) {
  const config = getProviderConfig().douyinAccount;
  if (!config.enabled) {
    throw new ProviderError('CONTENT_PARSER_NOT_CONFIGURED', '内容解析功能尚未配置', { status: 503 });
  }
  const url = new URL(tikhubEndpoint(pathname));
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  });
  try {
    const payload = await fetchJson(url, {
      method,
      body: body ? JSON.stringify(body) : undefined,
      timeoutMs: timeoutMs || config.timeoutMs,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      }
    });
    const responseCode = payload?.code;
    if (responseCode !== undefined && !['0', '200'].includes(String(responseCode))) {
      throw new ProviderError('CONTENT_PARSER_REJECTED', '内容解析服务未能读取该作品，请检查分享链接后重试', {
        status: 422,
        retryable: false,
        details: { code: responseCode }
      });
    }
    return payload;
  } catch (error) {
    if (error instanceof ProviderError && error.code === 'CONTENT_PARSER_REJECTED') throw error;
    if (error?.code === 'PROVIDER_HTTP_ERROR' && [401, 402, 403, 429].includes(error.status)) {
      throw new ProviderError('CONTENT_PARSER_CONFIG_INVALID', '内容解析服务配置无效或额度不足，请联系管理员', { status: 503, details: error.details });
    }
    if (error?.code === 'PROVIDER_UNREACHABLE' || error?.code === 'PROVIDER_TIMEOUT') {
      throw new ProviderError('CONTENT_PARSER_UNAVAILABLE', '内容解析服务暂时不可用，请稍后重试', { status: 503, retryable: true, details: error.details });
    }
    throw error;
  }
}

async function requestTikhubVideo(pathname, query = {}) {
  return requestContentParser(pathname, { query });
}

const tikhubVideoKeys = new Set([
  'original_video_url', 'originalVideoUrl', 'video_url', 'videoUrl', 'play_url', 'playUrl',
  'download_url', 'downloadUrl', 'nwm_video_url', 'nwmVideoUrl', 'play_addr', 'playAddr',
  'download_addr', 'downloadAddr', 'url_list', 'urlList'
]);

function isTikhubVideoUrl(value, key = '') {
  if (!/^https?:\/\//i.test(String(value || ''))) return false;
  if (/\.(?:jpe?g|png|webp|gif|avif|bmp)(?:[?#]|$)/i.test(String(value))) return false;
  const normalizedKey = String(key).replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
  return tikhubVideoKeys.has(key) || /(video|play|download|original|nwm|addr|url_list)/i.test(normalizedKey)
    || /\.(?:mp4|mov|webm|m4v|m3u8)(?:[?#]|$)/i.test(String(value));
}

export function extractTikhubVideoUrl(value, key = '', depth = 0, context = '') {
  if (depth > 8 || value === null || value === undefined) return '';
  if (typeof value === 'string') {
    if (/(?:cover|music|audio|avatar|image|author)/i.test(`${context} ${key}`)) return '';
    const contextLooksVideo = /(?:video|play|download|original)/i.test(context);
    return isTikhubVideoUrl(value, key) || (contextLooksVideo && /^https?:\/\//i.test(value)) ? value.trim() : '';
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractTikhubVideoUrl(item, key, depth + 1, context);
      if (found) return found;
    }
    return '';
  }
  if (typeof value !== 'object') return '';
  const entries = Object.entries(value);
  for (const [name, child] of entries.sort(([a], [b]) => Number(tikhubVideoKeys.has(b)) - Number(tikhubVideoKeys.has(a)))) {
    const nextContext = `${context} ${name}`.trim();
    const found = extractTikhubVideoUrl(child, name, depth + 1, nextContext);
    if (found) return found;
  }
  return '';
}

function xiaohongshuNoteId(sourceUrl) {
  try {
    return new URL(sourceUrl).pathname.match(/\/(?:discovery\/item|explore)\/([^/?#]+)/i)?.[1] || '';
  } catch {
    return '';
  }
}

export function extractXiaohongshuVideoUrl(payload, sourceUrl = '') {
  const noteLists = [payload?.data?.data, payload?.data?.data?.data, payload?.data];
  const notes = noteLists.find((value) => Array.isArray(value)) || [];
  const expectedId = xiaohongshuNoteId(sourceUrl);
  const note = (expectedId ? notes.find((item) => String(item?.id || item?.note_id || item?.noteId || '') === expectedId) : null)
    || notes[0]
    || null;
  if (!note || (note.type && note.type !== 'video')) return '';

  const streams = note.video_info_v2?.media?.stream || note.videoInfoV2?.media?.stream || {};
  const candidates = Object.entries(streams).flatMap(([codec, records]) => (Array.isArray(records) ? records : []).flatMap((record) => {
    const urls = [record?.master_url, record?.masterUrl, ...(record?.backup_urls || record?.backupUrls || [])]
      .map((value) => String(value || '').trim())
      .filter((value) => /^https?:\/\//i.test(value));
    return urls.map((url, index) => ({
      url,
      codec,
      primary: index === 0,
      isDefault: Number(record?.default_stream ?? record?.defaultStream ?? 0) === 1,
      size: Number(record?.size) || Number.MAX_SAFE_INTEGER
    }));
  }));
  candidates.sort((a, b) => Number(b.isDefault) - Number(a.isDefault)
    || Number(b.primary) - Number(a.primary)
    || a.size - b.size
    || Number(a.codec !== 'h264') - Number(b.codec !== 'h264'));
  return candidates[0]?.url || '';
}

function findWechatMedia(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8) return null;
  if (!Array.isArray(value)) {
    const decodeKey = value.decode_key ?? value.decodeKey;
    const mediaUrl = value.full_url ?? value.fullUrl ?? value.url;
    if (decodeKey !== undefined && mediaUrl) return value;
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findWechatMedia(child, depth + 1);
    if (found) return found;
  }
  return null;
}

export function extractWechatChannelsMedia(payload) {
  const media = payload?.data?.media
    || payload?.data?.objects?.[0]?.objectDesc?.media?.[0]
    || payload?.data?.object_desc?.media?.[0]
    || findWechatMedia(payload);
  if (!media || typeof media !== 'object') return { videoUrl: '', decodeKey: '' };
  let videoUrl = String(media.full_url || media.fullUrl || media.url || '').trim();
  const token = String(media.url_token || media.urlToken || '').trim();
  if (videoUrl && token && !videoUrl.includes(token)) {
    try {
      const parsed = new URL(videoUrl);
      if (!parsed.searchParams.has('token')) videoUrl += token;
    } catch {
      videoUrl += token;
    }
  }
  return {
    videoUrl,
    decodeKey: String(media.decode_key ?? media.decodeKey ?? '').trim()
  };
}

function tikhubVideoExtension(videoUrl, mimeType = '') {
  const mimeExtension = {
    'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm', 'application/vnd.apple.mpegurl': '.mp4'
  }[String(mimeType || '').toLowerCase()];
  if (mimeExtension) return mimeExtension;
  try {
    const extension = path.extname(new URL(videoUrl).pathname).toLowerCase();
    if (['.mp4', '.mov', '.webm', '.m4v'].includes(extension)) return extension;
  } catch {
    // The URL has already been validated by the caller; use the stable default if it has no file suffix.
  }
  return '.mp4';
}

export function tikhubVideoStatus() {
  const config = getProviderConfig().douyinAccount;
  const configured = Boolean(config.enabled);
  return {
    status: configured ? 'configured' : 'unconfigured',
    state: configured ? 'configured' : 'unconfigured',
    configured,
    message: configured ? '抖音、小红书与视频号分享链接解析已就绪。' : '内容解析功能尚未配置。'
  };
}

async function downloadDouyinVideoWithTikHub(sourceUrl) {
  const payload = await requestTikhubVideo('/api/v1/douyin/web/fetch_one_video_by_share_url', { share_url: sourceUrl });
  let videoUrl = extractTikhubVideoUrl(payload);
  if (!videoUrl) {
    const highQuality = await requestTikhubVideo('/api/v1/douyin/web/fetch_video_high_quality_play_url', { share_url: sourceUrl, region: 'CN' });
    videoUrl = extractTikhubVideoUrl(highQuality);
  }
  if (!videoUrl) throw new ProviderError('DOUYIN_VIDEO_URL_NOT_FOUND', '已读取作品数据，但没有找到可下载的视频地址', { status: 422, details: payload });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'domestic-ip-content-parser-'));
  try {
    return await downloadResolvedParserVideo({ sourceUrl, videoUrl, platform: '抖音', directory });
  } catch (error) {
    await cleanupDirectory(directory);
    throw error;
  }
}

async function downloadResolvedParserVideo({ sourceUrl, videoUrl, decodeKey = '', platform, directory }) {
  const providerConfig = getProviderConfig();
  const mediaConfig = providerConfig.platformMedia;
  const safeVideoUrl = await validateExternalUrl(videoUrl);
  let response;
  try {
    response = await fetch(safeVideoUrl, {
      headers: { Accept: 'video/*', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(Math.min(mediaConfig.timeoutMs, 180_000))
    });
  } catch (error) {
    throw new ProviderError('PLATFORM_VIDEO_DOWNLOAD_FAILED', `${platform}作品视频下载失败，请稍后重试`, {
      status: 502,
      retryable: true,
      details: error instanceof Error ? error.message : String(error)
    });
  }
  if (!response.ok) {
    throw new ProviderError('PLATFORM_VIDEO_DOWNLOAD_FAILED', `${platform}作品视频下载失败：HTTP ${response.status}`, {
      status: 502,
      retryable: response.status >= 500
    });
  }
  const mimeType = platform === '视频号' ? 'video/mp4' : (response.headers.get('content-type')?.split(';')[0] || 'video/mp4');
  let filePath = path.join(directory, `source${tikhubVideoExtension(safeVideoUrl, mimeType)}`);
  const rawMaxBytes = Math.max(mediaConfig.maxBytes, Math.min(providerConfig.storage.maxBytes, 512 * 1024 * 1024));
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > rawMaxBytes) {
    throw new ProviderError('PLATFORM_VIDEO_TOO_LARGE', '读取到的视频超过原片下载大小限制', { status: 413 });
  }
  if (!response.body) throw new ProviderError('PLATFORM_VIDEO_DOWNLOAD_EMPTY', '读取到的视频文件为空', { status: 422 });
  let received = 0;
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      received += chunk.length;
      if (received > rawMaxBytes) {
        callback(new ProviderError('PLATFORM_VIDEO_TOO_LARGE', '读取到的视频超过原片下载大小限制', { status: 413 }));
      } else {
        callback(null, chunk);
      }
    }
  });
  await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(filePath, { flags: 'wx' }));
  if (!received) throw new ProviderError('PLATFORM_VIDEO_DOWNLOAD_EMPTY', '读取到的视频文件为空', { status: 422 });
  if (platform === '视频号') {
    const decryptedPath = path.join(directory, 'source-decrypted.mp4');
    const decrypted = await decryptWechatVideo(await fs.readFile(filePath), decodeKey);
    await fs.writeFile(decryptedPath, decrypted);
    filePath = decryptedPath;
  }

  const prepared = await prepareAnalysisCopy(filePath, directory, Math.min(mediaConfig.maxBytes, 40 * 1024 * 1024));
  filePath = prepared.filePath;
  const preparedData = await fs.readFile(filePath);
  const preparedMimeType = extensionMime(filePath);
  return {
    sourceUrl,
    sourceType: 'content_parser',
    sourcePlatform: platform,
    filePath,
    data: preparedData,
    mimeType: preparedMimeType,
    video: { data: preparedData, mimeType: preparedMimeType, fps: 2 },
    cleanup: () => cleanupDirectory(directory)
  };
}

async function downloadXiaohongshuVideoWithContentParser(sourceUrl) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'domestic-ip-content-parser-'));
  try {
    const payload = await requestContentParser('/api/v1/xiaohongshu/app_v2/get_video_note_detail', {
      query: { share_text: sourceUrl }
    });
    const videoUrl = extractXiaohongshuVideoUrl(payload, sourceUrl);
    if (!videoUrl) {
      throw new ProviderError('PLATFORM_VIDEO_URL_NOT_FOUND', '该小红书笔记没有可拆解的视频，请确认分享的是视频笔记', { status: 422 });
    }
    return await downloadResolvedParserVideo({ sourceUrl, videoUrl, platform: '小红书', directory });
  } catch (error) {
    await cleanupDirectory(directory);
    throw error;
  }
}

async function downloadWechatChannelsVideoWithContentParser(sourceUrl) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'domestic-ip-content-parser-'));
  try {
    const config = getProviderConfig().douyinAccount;
    const payload = await requestContentParser('/api/v1/wechat_channels/v2/fetch_video_detail', {
      method: 'POST',
      body: { share_url: sourceUrl, raw: false },
      timeoutMs: Math.max(config.timeoutMs, 45_000)
    });
    const { videoUrl, decodeKey } = extractWechatChannelsMedia(payload);
    if (!videoUrl || !decodeKey) {
      throw new ProviderError('PLATFORM_VIDEO_URL_NOT_FOUND', '该视频号作品没有返回可拆解的视频，请重新复制分享链接', { status: 422 });
    }
    return await downloadResolvedParserVideo({ sourceUrl, videoUrl, decodeKey, platform: '视频号', directory });
  } catch (error) {
    await cleanupDirectory(directory);
    throw error;
  }
}

export async function downloadPlatformVideo(value) {
  const sourceUrl = await validateExternalUrl(value);
  const config = getProviderConfig().platformMedia;
  const commandParts = splitCommandLine(config.ytdlpCommand || 'python -m yt_dlp');
  if (!commandParts.length) throw new ProviderError('YTDLP_UNAVAILABLE', '后台未配置平台视频解析命令', { status: 503 });
  if (config.cookiesFile && config.cookiesFromBrowser) {
    throw new ProviderError('PLATFORM_COOKIE_SOURCE_CONFLICT', 'Cookie 文件路径和浏览器 Cookie 来源只能配置一个', { status: 400 });
  }

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'domestic-ip-platform-'));
  const outputTemplate = path.join(directory, 'source.%(ext)s');
  const args = [
    ...commandParts.slice(1),
    '--no-playlist',
    '--restrict-filenames',
    '--format', 'bv*[height<=480]+ba/b[height<=480]/b',
    '--merge-output-format', 'mp4',
    '--output', outputTemplate,
    '--print', 'after_move:filepath'
  ];

  if (config.cookiesFile) {
    const cookieStat = await fs.stat(config.cookiesFile).catch(() => null);
    if (!cookieStat?.isFile()) {
      await cleanupDirectory(directory);
      throw new ProviderError('PLATFORM_COOKIE_FILE_NOT_FOUND', '后台配置的平台 Cookie 文件不存在', { status: 503 });
    }
    args.push('--cookies', config.cookiesFile);
  } else if (config.cookiesFromBrowser) {
    args.push('--cookies-from-browser', config.cookiesFromBrowser);
  }
  args.push(sourceUrl);

  try {
    const result = await runCommand(commandParts[0], args, {
      timeoutMs: config.timeoutMs,
      errorCode: 'PLATFORM_VIDEO_DOWNLOAD_FAILED',
      errorMessage: '平台分享链接解析失败'
    });
    const printedPaths = result.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).reverse();
    let filePath = printedPaths.find((item) => path.isAbsolute(item));
    let stat = filePath ? await fs.stat(filePath).catch(() => null) : null;
    if (!stat?.isFile()) {
      const files = await fs.readdir(directory, { withFileTypes: true });
      const mediaFile = files.find((item) => item.isFile() && !item.name.endsWith('.part'));
      filePath = mediaFile ? path.join(directory, mediaFile.name) : '';
      stat = filePath ? await fs.stat(filePath).catch(() => null) : null;
    }
    const analysisMaxBytes = Math.min(config.maxBytes, 40 * 1024 * 1024);
    const prepared = await prepareAnalysisCopy(filePath, directory, analysisMaxBytes);
    filePath = prepared.filePath;
    const data = await fs.readFile(filePath);
    return {
      sourceUrl,
      sourceType: 'platform_share',
      filePath,
      data,
      mimeType: extensionMime(filePath),
      video: { data, mimeType: extensionMime(filePath), fps: 2 },
      cleanup: () => cleanupDirectory(directory)
    };
  } catch (error) {
    await cleanupDirectory(directory);
    const details = `${error?.message || ''}\n${error?.details || ''}`;
    if (/Could not copy .* cookie database|database is locked|cannot copy.*cookie/i.test(details)) {
      const metadata = await readCookieMetadata();
      await writeCookieMetadata({ ...metadata, status: 'locked', error: cookieStatusMessage('locked', getProviderConfig().platformMedia.cookiesFromBrowser || metadata.browser || 'chrome'), updatedAt: new Date().toISOString() }).catch(() => {});
      throw new ProviderError('PLATFORM_COOKIE_BROWSER_LOCKED', cookieStatusMessage('locked', getProviderConfig().platformMedia.cookiesFromBrowser || metadata.browser || 'chrome'), { status: 422, details: error?.details });
    }
    if (/fresh cookies|cookies.*needed|sign in|login required|not logged in/i.test(details)) await markCookieInvalid(error);
    if (/fresh cookies|cookies.*needed|sign in|login required|not logged in|需要.*cookie/i.test(details)) {
      throw new ProviderError('PLATFORM_COOKIES_REQUIRED', '该平台内容需要登录 Cookie，请在后台配置 Cookie 文件或浏览器 Cookie 来源后重试', { status: 422 });
    }
    if (/No module named yt_dlp|not recognized|ENOENT|无法启动/i.test(details)) {
      throw new ProviderError('YTDLP_UNAVAILABLE', '平台视频解析器不可用，请在后台配置 yt-dlp 命令', { status: 503 });
    }
    throw error;
  }
}

export async function resolveBenchmarkMedia(value) {
  const sourceUrl = await validateExternalUrl(value);
  const platform = detectPlatform(sourceUrl);
  if (platform === '抖音') return downloadDouyinVideoWithTikHub(sourceUrl);
  if (platform === '小红书') return downloadXiaohongshuVideoWithContentParser(sourceUrl);
  if (platform === '视频号') return downloadWechatChannelsVideoWithContentParser(sourceUrl);
  throw new ProviderError('PLATFORM_LINK_UNSUPPORTED', '目前仅支持抖音、小红书和视频号分享链接；其他平台请上传视频文件', { status: 400 });
}
