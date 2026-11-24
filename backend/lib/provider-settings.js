import { readFileSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replaceFileDurably } from './file-persistence.js';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runningTests = process.env.NODE_ENV === 'test' || Boolean(process.env.NODE_TEST_CONTEXT);
const settingsFile = path.resolve(process.env.IP_AGENT_PROVIDER_SETTINGS_FILE || path.join(projectRoot, 'data', 'provider-settings.json'));

export const providerSettingDefinitions = [
  { key: 'IP_AGENT_STORAGE_DRIVER', group: '对象存储与 CDN', label: '素材存储模式（生产填写 oss）', secret: false, defaultValue: 'local' },
  { key: 'ALIYUN_OSS_REGION', group: '对象存储与 CDN', label: 'OSS 地域（例如 oss-cn-shenzhen）', secret: false },
  { key: 'ALIYUN_OSS_BUCKET', group: '对象存储与 CDN', label: 'OSS Bucket', secret: false },
  { key: 'ALIYUN_OSS_ACCESS_KEY_ID', group: '对象存储与 CDN', label: 'OSS AccessKey ID', secret: true },
  { key: 'ALIYUN_OSS_ACCESS_KEY_SECRET', group: '对象存储与 CDN', label: 'OSS AccessKey Secret', secret: true },
  { key: 'ALIYUN_OSS_STS_TOKEN', group: '对象存储与 CDN', label: 'OSS STS Token（使用临时凭证时填写）', secret: true },
  { key: 'ALIYUN_OSS_ENDPOINT', group: '对象存储与 CDN', label: 'OSS 公网 Endpoint（可留空自动识别）', secret: false },
  { key: 'ALIYUN_OSS_INTERNAL_ENDPOINT', group: '对象存储与 CDN', label: 'OSS 内网 Endpoint（ECS 推荐）', secret: false },
  { key: 'ALIYUN_CDN_DOMAIN', group: '对象存储与 CDN', label: 'CDN 加速域名（可选）', secret: false },
  { key: 'ALIYUN_CDN_AUTH_KEY', group: '对象存储与 CDN', label: 'CDN URL 鉴权主 Key（可选）', secret: true },
  { key: 'ALIYUN_CDN_AUTH_TYPE', group: '对象存储与 CDN', label: 'CDN URL 鉴权类型（当前支持 a）', secret: false, defaultValue: 'a' },
  { key: 'IP_AGENT_UPLOAD_SIGNING_SECRET', group: '对象存储与 CDN', label: '上传回调签名密钥', secret: true },
  { key: 'IP_AGENT_MAX_UPLOAD_BYTES', group: '对象存储与 CDN', label: '单个素材最大字节数', secret: false, defaultValue: '524288000' },
  { key: 'IP_AGENT_OSS_UPLOAD_EXPIRES_SECONDS', group: '对象存储与 CDN', label: '直传地址有效期（秒）', secret: false, defaultValue: '900' },
  { key: 'IP_AGENT_OSS_READ_EXPIRES_SECONDS', group: '对象存储与 CDN', label: '私有素材播放地址有效期（秒）', secret: false, defaultValue: '3600' },
  { key: 'IP_AGENT_LLM_BASE_URL', group: 'AI 视频理解模型', label: '视频理解模型 API 地址', secret: false },
  { key: 'IP_AGENT_LLM_API_KEY', group: 'AI 视频理解模型', label: '视频理解模型 API Key', secret: true },
  { key: 'IP_AGENT_LLM_MODEL', group: 'AI 视频理解模型', label: '视频理解模型名称', secret: false },
  { key: 'IP_AGENT_LLM_ACCOUNT_ID', group: 'AI 视频理解模型', label: '视频模型服务账号 ID', secret: false },
  { key: 'IP_AGENT_TEXT_LLM_BASE_URL', group: 'AI 文本模型', label: '文本模型 API 地址', secret: false },
  { key: 'IP_AGENT_TEXT_LLM_API_KEY', group: 'AI 文本模型', label: '文本模型 API Key', secret: true },
  { key: 'IP_AGENT_TEXT_LLM_MODEL', group: 'AI 文本模型', label: '文本模型名称', secret: false, defaultValue: 'gpt-5.6-sol' },
  { key: 'IP_AGENT_TEXT_LLM_ACCOUNT_ID', group: 'AI 文本模型', label: '文本模型服务账号 ID', secret: false },
  { key: 'IP_AGENT_TEXT_LLM_TIMEOUT_MS', group: 'AI 文本模型', label: '文本模型请求超时（毫秒）', secret: false, defaultValue: '60000' },
  { key: 'IP_AGENT_CHAT_BASE_URL', group: 'AI 对话', label: '对话 API 地址（留空继承 AI 文本模型）', secret: false },
  { key: 'IP_AGENT_CHAT_API_KEY', group: 'AI 对话', label: '对话 API Key（留空继承 AI 文本模型）', secret: true },
  { key: 'IP_AGENT_CHAT_MODEL', group: 'AI 对话', label: '对话模型（留空跟随 AI 文本模型）', secret: false, defaultValue: 'gpt-5.6-sol' },
  { key: 'IP_AGENT_CHAT_TIMEOUT_MS', group: 'AI 对话', label: '单次对话超时（毫秒）', secret: false, defaultValue: '60000' },
  { key: 'IP_AGENT_IMAGE_BASE_URL', group: 'AI 图片生成', label: '图片 API 地址', secret: false },
  { key: 'IP_AGENT_IMAGE_API_KEY', group: 'AI 图片生成', label: '图片 API Key', secret: true },
  { key: 'IP_AGENT_IMAGE_PROVIDER', group: 'AI 图片生成', label: '图片接口模式', secret: false },
  { key: 'IP_AGENT_IMAGE_MODEL', group: 'AI 图片生成', label: '图片模型', secret: false },
  { key: 'IP_AGENT_IMAGE_REPLY_TYPE', group: 'AI 图片生成', label: '图片返回模式（json / async）', secret: false },
  { key: 'IP_AGENT_IMAGE_ASPECT_RATIO', group: 'AI 图片生成', label: '默认图片比例', secret: false },
  { key: 'IP_AGENT_IMAGE_POLL_INTERVAL_MS', group: 'AI 图片生成', label: '异步轮询间隔（毫秒）', secret: false },
  { key: 'IP_AGENT_IMAGE_TIMEOUT_MS', group: 'AI 图片生成', label: '图片任务超时（毫秒）', secret: false },
  { key: 'PEXELS_API_KEY', group: '素材搜索', label: '素材搜索 API Key', secret: true },
  { key: 'IP_AGENT_VOLCENGINE_VOICE_API_KEY', group: '语音与声音克隆', label: '语音服务 API Key', secret: true },
  { key: 'IP_AGENT_VOLCENGINE_VOICE_BILLING_MODE', group: '语音与声音克隆', label: '声音克隆计费模式（系统固定为 prepaid）', secret: false, defaultValue: 'prepaid', locked: true },
  { key: 'IP_AGENT_VOLCENGINE_VOICE_PREPAID_SPEAKER_IDS', group: '语音与声音克隆', label: '预付费音色槽位 ID（多个用逗号分隔）', secret: false },
  { key: 'IP_AGENT_VOLCENGINE_VOICE_CLONE_ENDPOINT', group: '语音与声音克隆', label: '声音克隆地址', secret: false },
  { key: 'IP_AGENT_VOLCENGINE_VOICE_STATUS_ENDPOINT', group: '语音与声音克隆', label: '声音状态地址', secret: false },
  { key: 'IP_AGENT_VOLCENGINE_TTS_ENDPOINT', group: '语音与声音克隆', label: 'TTS 地址', secret: false },
  { key: 'IP_AGENT_VOLCENGINE_TTS_RESOURCE_ID', group: '语音与声音克隆', label: 'TTS Resource ID', secret: false },
  { key: 'IP_AGENT_JIANYING_DRAFT_ROOT', group: '剪映草稿', label: '剪映草稿目录', secret: false },
  { key: 'IP_AGENT_JIANYING_INDEX_PATH', group: '剪映草稿', label: '剪映全局草稿索引（高级）', secret: false },
  { key: 'IP_AGENT_JIANYING_PYTHON_COMMAND', group: '剪映草稿', label: 'Python 命令', secret: false },
  { key: 'IP_AGENT_SKYHUMAN_BASE_URL', group: '数字人服务', label: '数字人 API 地址', secret: false },
  { key: 'IP_AGENT_SKYHUMAN_API_TOKEN', group: '数字人服务', label: '数字人访问令牌', secret: true },
  { key: 'IP_AGENT_VOLCENGINE_VISUAL_ACCESS_KEY_ID', group: '纯口播数字人', label: '视频能力 AccessKey ID', secret: true },
  { key: 'IP_AGENT_VOLCENGINE_VISUAL_SECRET_KEY', group: '纯口播数字人', label: '视频能力 SecretKey', secret: true },
  { key: 'IP_AGENT_VOLCENGINE_VISUAL_SESSION_TOKEN', group: '纯口播数字人', label: '临时会话凭证（可选）', secret: true },
  { key: 'IP_AGENT_VOLCENGINE_VISUAL_BASE_URL', group: '纯口播数字人', label: '视频能力 API 地址', secret: false, defaultValue: 'https://visual.volcengineapi.com' },
  { key: 'IP_AGENT_TALKING_PHOTO_DRIVE_MODE', group: '纯口播数字人', label: '驱动模式（auto / standard / expressive / large）', secret: false, defaultValue: 'auto' },
  { key: 'IP_AGENT_TALKING_PHOTO_PRICE_PER_SECOND_CNY', group: '纯口播数字人', label: '视频参考价格（元/秒）', secret: false, defaultValue: '0.3' },
  { key: 'IP_AGENT_TALKING_PHOTO_ROLE_PRICE_CNY', group: '纯口播数字人', label: '首次形象参考价格（元/次）', secret: false, defaultValue: '0.1' },
  { key: 'IP_AGENT_TALKING_PHOTO_LARGE_MAX_SECONDS', group: '纯口播数字人', label: '自然动作模式最长秒数', secret: false, defaultValue: '45' },
  { key: 'IP_AGENT_TALKING_PHOTO_TIMEOUT_MS', group: '纯口播数字人', label: '生成任务超时（毫秒）', secret: false, defaultValue: '900000' },
  { key: 'IP_AGENT_TALKING_PHOTO_POLL_INTERVAL_MS', group: '纯口播数字人', label: '进度刷新间隔（毫秒）', secret: false, defaultValue: '5000' },
  { key: 'IP_AGENT_TIKHUB_BASE_URL', group: '内容解析', label: '内容解析 API 地址', secret: false, defaultValue: 'https://api.tikhub.io' },
  { key: 'IP_AGENT_TIKHUB_API_KEY', group: '内容解析', label: '内容解析 API Key', secret: true },
  { key: 'IP_AGENT_TIKHUB_TIMEOUT_MS', group: '内容解析', label: '请求超时（毫秒）', secret: false },
  { key: 'IP_AGENT_TIKHUB_MAX_POSTS', group: '内容解析', label: '账号拆解最多读取作品数', secret: false },
  { key: 'IP_AGENT_VIDEO_RENDER_SERVICE_URL', group: '远端剪辑服务', label: '服务地址', secret: false },
  { key: 'IP_AGENT_VIDEO_RENDER_SERVICE_API_KEY', group: '远端剪辑服务', label: '服务密钥', secret: true },
  { key: 'IP_AGENT_VIDEO_RENDER_SERVICE_TIMEOUT_MS', group: '远端剪辑服务', label: '任务超时（毫秒）', secret: false, defaultValue: '2700000' },
  { key: 'IP_AGENT_VIDEO_RENDER_SERVICE_POLL_INTERVAL_MS', group: '远端剪辑服务', label: '进度刷新间隔（毫秒）', secret: false, defaultValue: '800' },
  // Rendering engine. Both values run the same editing algorithm; this only
  // chooses whether the encode happens on the private box or on Aliyun IMS.
  { key: 'IP_AGENT_VIDEO_RENDER_BACKEND', group: '远端剪辑服务', label: '渲染后端（local=私有服务器 / ims=阿里云）', secret: false, defaultValue: 'local' },
  { key: 'IP_AGENT_VIDEO_RENDER_FALLBACK_LOCAL', group: '远端剪辑服务', label: 'IMS 失败时回退私有服务器（true/false）', secret: false, defaultValue: 'false' },
  { key: 'IP_AGENT_VIDEO_RENDER_IMS_TIMEOUT_MS', group: '远端剪辑服务', label: 'IMS 任务超时（毫秒）', secret: false, defaultValue: '2700000' },
  { key: 'IP_AGENT_VIDEO_RENDER_IMS_POLL_INTERVAL_MS', group: '远端剪辑服务', label: 'IMS 进度刷新间隔（毫秒）', secret: false, defaultValue: '2000' },
  // Off by default: the cloud result is already a finished MP4, and burning subtitles
  // here re-encodes the whole video on this host (~87 s for a 67 s cut).
  { key: 'IP_AGENT_VIDEO_RENDER_IMS_BURN_SUBTITLES', group: '远端剪辑服务', label: 'IMS 出片后在本机烧字幕（true/false，默认关）', secret: false, defaultValue: 'false' },
  // How the subtitle file is addressed to IMS. `bare` is what the reference
  // implementation emits (an unsigned OSS url) and cannot be fetched from a private
  // bucket; `signed` is the correct form but IMS currently rejects it with
  // `…SubtitleConfig:…:ExtSubtitle:Input:Object is not supported`. Kept switchable so the
  // Aliyun ticket can be reproduced on demand — see the notes in remote-video-ims.js.
  { key: 'IP_AGENT_VIDEO_RENDER_IMS_SUBTITLE_URL', group: '远端剪辑服务', label: 'IMS 字幕文件地址形式（bare/signed，默认 bare）', secret: false, defaultValue: 'bare' },
  { key: 'IP_AGENT_PUBLISH_PYTHON_COMMAND', group: '平台发布', label: 'Python 命令', secret: false, defaultValue: 'python' },
  { key: 'IP_AGENT_PUBLISH_SESSION_ROOT', group: '平台发布', label: '平台登录态目录', secret: false },
  { key: 'IP_AGENT_PUBLISH_SERVICE_TIMEOUT_MS', group: '平台发布', label: '状态检查超时（毫秒）', secret: false },
  { key: 'IP_AGENT_PUBLISH_LOGIN_TIMEOUT_MS', group: '平台发布', label: '扫码登录超时（毫秒）', secret: false },
  { key: 'IP_AGENT_PUBLISH_TASK_TIMEOUT_MS', group: '平台发布', label: '发布任务超时（毫秒）', secret: false },
  { key: 'IP_AGENT_MULTILINGUAL_TTS_API_KEY', group: '多语言语音', label: '多语言语音 API Key', secret: true },
  { key: 'IP_AGENT_MULTILINGUAL_TTS_ENDPOINT', group: '多语言语音', label: '多语言语音接口地址', secret: false, defaultValue: 'https://openspeech.bytedance.com/api/v3/tts/create' },
  { key: 'IP_AGENT_MULTILINGUAL_TTS_MODEL', group: '多语言语音', label: '多语言语音模型', secret: false, defaultValue: 'seed-audio-1.0-multilingual' },
  { key: 'IP_AGENT_MULTILINGUAL_TTS_TIMEOUT_MS', group: '多语言语音', label: '多语言语音超时（毫秒）', secret: false, defaultValue: '310000' }
];

export function loadProviderOverrides() {
  if (runningTests && !process.env.IP_AGENT_PROVIDER_SETTINGS_FILE) return {};
  try {
    const parsed = JSON.parse(readFileSync(settingsFile, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export async function updateProviderOverrides(input = {}) {
  const definitions = new Map(providerSettingDefinitions.map((item) => [item.key, item]));
  const current = loadProviderOverrides();
  for (const [key, raw] of Object.entries(input)) {
    const definition = definitions.get(key);
    if (!definition || definition.locked) continue;
    const value = String(raw ?? '').trim();
    if (value) current[key] = value;
    else delete current[key];
  }
  await fs.mkdir(path.dirname(settingsFile), { recursive: true });
  const temporary = `${settingsFile}.${process.pid}.tmp`;
  const content = JSON.stringify(current, null, 2);
  await fs.writeFile(temporary, content, 'utf8');
  await replaceFileDurably(temporary, settingsFile, content);
  return current;
}

function mask(value) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= 8) return '********';
  return `${text.slice(0, 4)}••••${text.slice(-4)}`;
}

export function publicProviderSettings() {
  const overrides = loadProviderOverrides();
  return providerSettingDefinitions.map((definition) => {
    const override = overrides[definition.key];
    const environment = process.env[definition.key];
    const textBase = overrides.IP_AGENT_TEXT_LLM_BASE_URL || process.env.IP_AGENT_TEXT_LLM_BASE_URL || process.env.OPENAI_BASE_URL || '';
    const textKey = overrides.IP_AGENT_TEXT_LLM_API_KEY || process.env.IP_AGENT_TEXT_LLM_API_KEY || process.env.OPENAI_API_KEY || '';
    const textModel = overrides.IP_AGENT_TEXT_LLM_MODEL || process.env.IP_AGENT_TEXT_LLM_MODEL || process.env.OPENAI_MODEL || '';
    const dedicatedTextModel = Boolean(textBase || textKey || textModel);
    let value = override || environment || '';
    let source = override ? '后台配置' : environment ? '环境变量' : '未配置';
    let configured = Boolean(value);
    if (definition.locked) {
      value = definition.defaultValue || '';
      source = '系统固定';
      configured = Boolean(value);
    }
    if (!value && definition.key === 'IP_AGENT_CHAT_MODEL') {
      value = textModel || (dedicatedTextModel ? 'gpt-5.6-sol' : '')
        || overrides.IP_AGENT_LLM_MODEL || process.env.IP_AGENT_LLM_MODEL || overrides.VOLCENGINE_ARK_MODEL || process.env.VOLCENGINE_ARK_MODEL || '';
      if (value) configured = true;
      if (value) source = dedicatedTextModel ? '继承 AI 文本模型' : '继承视频理解模型';
    }
    if (!value && definition.defaultValue) {
      value = definition.defaultValue;
      source = '默认值';
    }
    if (!value && definition.key === 'IP_AGENT_CHAT_BASE_URL') {
      value = textBase || (dedicatedTextModel ? 'https://api.openai.com/v1/responses' : '')
        || overrides.IP_AGENT_LLM_BASE_URL || process.env.IP_AGENT_LLM_BASE_URL || overrides.VOLCENGINE_ARK_BASE_URL || process.env.VOLCENGINE_ARK_BASE_URL || '';
      if (value) configured = true;
      if (value) source = dedicatedTextModel ? '继承 AI 文本模型' : '继承视频理解模型';
    }
    if (!value && definition.key === 'IP_AGENT_CHAT_API_KEY') {
      value = textKey || (!dedicatedTextModel
        ? overrides.IP_AGENT_LLM_API_KEY || process.env.IP_AGENT_LLM_API_KEY || overrides.VOLCENGINE_ARK_API_KEY || process.env.VOLCENGINE_ARK_API_KEY || ''
        : '');
      if (value) configured = true;
      if (value) source = dedicatedTextModel ? '继承 AI 文本模型' : '继承视频理解模型';
    }
    return {
      ...definition,
      concealed: definition.secret || /(?:BASE_URL|API_KEY|MODEL|PROVIDER|ACCOUNT_ID|ENDPOINT|RESOURCE_ID|TITOK|FFMPEG|FFPROBE)/i.test(definition.key),
      configured,
      source,
      displayValue: definition.secret ? mask(value) : String(value || '')
    };
  });
}
