import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadProviderOverrides, providerSettingDefinitions } from '../lib/provider-settings.js';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runningTests = process.env.NODE_ENV === 'test' || Boolean(process.env.NODE_TEST_CONTEXT);
// In production, provider credentials and service endpoints are owned by the
// persisted project settings edited in the admin UI. Environment variables
// remain available for local development/tests and for deployment-only
// runtime knobs, but must not silently override an empty project setting.
const projectSettingKeys = new Set(providerSettingDefinitions.map((item) => item.key));

function loadProjectEnv() {
  // Support both the repository-level `.env` and the long-standing
  // `backend/.env` deployment layout. This is required when the API is
  // started directly from the project directory; otherwise provider keys are
  // silently omitted.
  const envFiles = [path.join(projectRoot, 'backend', '.env'), path.join(projectRoot, '.env')];
  for (const envFile of envFiles) {
    let content;
    try {
      content = readFileSync(envFile, 'utf8');
    } catch {
      continue;
    }
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match || process.env[match[1]] !== undefined) continue;
      let current = match[2].trim();
      if ((current.startsWith('"') && current.endsWith('"')) || (current.startsWith("'") && current.endsWith("'"))) {
        const quote = current[0];
        current = current.slice(1, -1);
        if (quote === '"') current = current.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      } else {
        current = current.replace(/\s+#.*$/, '').trim();
      }
      process.env[match[1]] = current;
    }
  }
}

if (!runningTests && process.env.IP_AGENT_SKIP_PROJECT_ENV !== '1') loadProjectEnv();

function value(...names) {
  const overrides = loadProviderOverrides();
  for (const name of names) {
    const current = String(overrides[name] || '').trim();
    if (current) return current;
  }
  if (!runningTests && process.env.NODE_ENV === 'production' && names.some((name) => projectSettingKeys.has(name))) return '';
  for (const name of names) {
    const current = String(process.env[name] || '').trim();
    if (current) return current;
  }
  return '';
}

function numberValue(name, fallback) {
  const parsed = Number(value(name));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function boolValue(name, fallback = false) {
  const current = String(process.env[name] ?? '').trim().toLowerCase();
  if (!current) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(current);
}

function boolSetting(name, fallback = false) {
  const current = String(value(name) || '').trim().toLowerCase();
  if (!current) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(current);
}

export function detectJianyingDraftRoot(localAppData = process.env.LOCALAPPDATA || '') {
  const fallback = path.join(localAppData, 'JianyingPro', 'User Data', 'Projects', 'com.lveditor.draft');
  if (!localAppData) return fallback;
  try {
    const settingsPath = path.join(localAppData, 'JianyingPro', 'User Data', 'Config', 'globalSetting');
    const settings = readFileSync(settingsPath, 'utf8');
    const match = settings.match(/^currentCustomDraftPath\s*=\s*(.+?)\s*$/m);
    if (!match) return fallback;
    const configured = match[1].trim().replace(/^['"]|['"]$/g, '').replace(/\\\\/g, '\\');
    return configured && existsSync(configured) ? configured : fallback;
  } catch {
    return fallback;
  }
}

export function commandAvailable(command, args = ['-version']) {
  if (!command) return false;
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 3_000
  });
  return !result.error && result.status === 0;
}

export function getProviderConfig() {
  const llmBaseUrl = value('IP_AGENT_LLM_BASE_URL', 'VOLCENGINE_ARK_BASE_URL');
  const llmApiKey = value('IP_AGENT_LLM_API_KEY', 'VOLCENGINE_ARK_API_KEY');
  const llmModel = value('IP_AGENT_LLM_MODEL', 'VOLCENGINE_ARK_MODEL');
  const llmAccountId = value('IP_AGENT_LLM_ACCOUNT_ID', 'VOLCENGINE_ARK_ACCOUNT_ID');
  const textLlmBaseOverride = value('IP_AGENT_TEXT_LLM_BASE_URL', 'OPENAI_BASE_URL');
  const textLlmApiKeyOverride = value('IP_AGENT_TEXT_LLM_API_KEY', 'OPENAI_API_KEY');
  const textLlmModelOverride = value('IP_AGENT_TEXT_LLM_MODEL', 'OPENAI_MODEL');
  const textLlmAccountIdOverride = value('IP_AGENT_TEXT_LLM_ACCOUNT_ID', 'OPENAI_ORGANIZATION_ID');
  const dedicatedTextLlm = Boolean(textLlmBaseOverride || textLlmApiKeyOverride || textLlmModelOverride);
  const textLlmBaseUrl = textLlmBaseOverride || (dedicatedTextLlm ? 'https://api.openai.com/v1/responses' : llmBaseUrl);
  const textLlmApiKey = textLlmApiKeyOverride || (dedicatedTextLlm ? '' : llmApiKey);
  const textLlmModel = textLlmModelOverride || (dedicatedTextLlm ? 'gpt-5.6-sol' : llmModel);
  const textLlmAccountId = textLlmAccountIdOverride || (dedicatedTextLlm ? '' : llmAccountId);
  const chatBaseOverride = value('IP_AGENT_CHAT_BASE_URL');
  const chatApiKeyOverride = value('IP_AGENT_CHAT_API_KEY');
  const chatModelOverride = value('IP_AGENT_CHAT_MODEL');
  const chatBaseUrl = chatBaseOverride || (dedicatedTextLlm ? textLlmBaseUrl : llmBaseUrl);
  const chatApiKey = chatApiKeyOverride || (dedicatedTextLlm ? textLlmApiKey : llmApiKey);
  // Keep chat usable out of the box by following the already configured
  // content model. An account may list many public models while its endpoint
  // is only entitled to a subset; the content model has already passed that
  // entitlement check in this project.
  const chatModel = chatModelOverride || (dedicatedTextLlm ? textLlmModel : llmModel) || 'gpt-5.6-sol';
  const imageModel = value('IP_AGENT_IMAGE_MODEL');
  const imageProvider = value('IP_AGENT_IMAGE_PROVIDER') || (/^gpt-image-2(?:-vip)?$/i.test(imageModel) ? 'grsai-gpt-image' : 'openai-compatible');
  const imageBaseUrl = value('IP_AGENT_IMAGE_BASE_URL') || (imageProvider === 'grsai-gpt-image' ? 'https://grsai.dakka.com.cn/v1/api/generate' : llmBaseUrl);
  const imageApiKey = value('IP_AGENT_IMAGE_API_KEY') || (imageProvider === 'grsai-gpt-image' ? '' : llmApiKey);
  const ffmpegPath = value('IP_AGENT_FFMPEG_PATH') || 'ffmpeg';
  const ffprobePath = value('IP_AGENT_FFPROBE_PATH') || 'ffprobe';
  const voiceApiKey = value('IP_AGENT_VOLCENGINE_VOICE_API_KEY', 'VOLCENGINE_TTS_API_KEY');
  const multilingualTtsApiKey = value('IP_AGENT_MULTILINGUAL_TTS_API_KEY', 'VOLCENGINE_MULTILINGUAL_TTS_API_KEY');
  const skyHumanToken = value('IP_AGENT_SKYHUMAN_API_TOKEN', 'SKYHUMAN_API_TOKEN');
  const talkingPhotoAccessKeyId = value('IP_AGENT_VOLCENGINE_VISUAL_ACCESS_KEY_ID', 'VOLC_ACCESSKEY');
  const talkingPhotoSecretKey = value('IP_AGENT_VOLCENGINE_VISUAL_SECRET_KEY', 'VOLC_SECRETKEY');
  const talkingPhotoBaiduAppId = value('IP_AGENT_BAIDU_XILING_APP_ID');
  const talkingPhotoBaiduAppKey = value('IP_AGENT_BAIDU_XILING_APP_KEY');
  const requestedTalkingPhotoProvider = value('IP_AGENT_TALKING_PHOTO_PROVIDER').trim().toLowerCase();
  const talkingPhotoProvider = ['baidu-xiling', 'volcengine'].includes(requestedTalkingPhotoProvider)
    ? requestedTalkingPhotoProvider
    : 'baidu-xiling';
  const publishPythonCommand = value('IP_AGENT_PUBLISH_PYTHON_COMMAND') || 'python';
  const publishBridgePath = path.resolve(value('IP_AGENT_PUBLISH_BRIDGE_PATH') || path.join(projectRoot, 'embedded-publisher', 'bridge.py'));
  const publishSessionRoot = path.resolve(value('IP_AGENT_PUBLISH_SESSION_ROOT') || path.join(projectRoot, 'data', 'publishing-sessions'));
  const jianyingPythonCommand = value('IP_AGENT_JIANYING_PYTHON_COMMAND') || publishPythonCommand;
  const jianyingBridgePath = path.resolve(value('IP_AGENT_JIANYING_BRIDGE_PATH') || path.join(projectRoot, 'jianying', 'bridge.py'));
  const configuredJianyingDraftRoot = value('IP_AGENT_JIANYING_DRAFT_ROOT');
  const configuredJianyingIndexPath = value('IP_AGENT_JIANYING_INDEX_PATH');
  const jianyingDefaultRoot = path.join(process.env.LOCALAPPDATA || '', 'JianyingPro', 'User Data', 'Projects', 'com.lveditor.draft');
  const jianyingDraftRoot = path.resolve(configuredJianyingDraftRoot || detectJianyingDraftRoot());
  const jianyingIndexPath = path.resolve(configuredJianyingIndexPath || (runningTests ? path.join(jianyingDraftRoot, 'root_meta_info.json') : path.join(jianyingDefaultRoot, 'root_meta_info.json')));
  const douyinAccountApiKey = value('IP_AGENT_TIKHUB_API_KEY');
  const douyinAccountBaseUrl = value('IP_AGENT_TIKHUB_BASE_URL') || 'https://api.tikhub.io';
  const videoEnginePythonCommand = value('IP_AGENT_VIDEO_ENGINE_PYTHON_COMMAND') || publishPythonCommand;
  const videoEngineWhisperScript = path.join(projectRoot, 'video-engine', 'python', 'transcribe_words.py');
  const titokProjectRoot = value('IP_AGENT_TITOK_PROJECT_ROOT') || 'D:\\suibian\\Downloads\\TiTok文案生成';
  const videoRenderServiceUrl = value('IP_AGENT_VIDEO_RENDER_SERVICE_URL');
  const videoRenderServiceApiKey = value('IP_AGENT_VIDEO_RENDER_SERVICE_API_KEY');
  const requestedVideoBackend = value('IP_AGENT_VIDEO_RENDER_BACKEND').trim().toLowerCase();
  const videoBackend = ['local', 'ims'].includes(requestedVideoBackend) ? requestedVideoBackend : 'local';
  const ossRegion = value('ALIYUN_OSS_REGION');
  const ossBucket = value('ALIYUN_OSS_BUCKET');
  const ossAccessKeyId = value('ALIYUN_OSS_ACCESS_KEY_ID');
  const ossAccessKeySecret = value('ALIYUN_OSS_ACCESS_KEY_SECRET');
  const ossEndpoint = value('ALIYUN_OSS_ENDPOINT', 'ALIYUN_OSS_PUBLIC_ENDPOINT');
  const requestedStorageDriver = value('IP_AGENT_STORAGE_DRIVER').toLowerCase();
  const ossConfigured = Boolean(ossBucket && ossAccessKeyId && ossAccessKeySecret && (ossRegion || ossEndpoint));
  const storageDriver = requestedStorageDriver || (ossConfigured ? 'oss' : 'local');

  return {
    storage: {
      driver: storageDriver,
      root: path.resolve(value('IP_AGENT_STORAGE_ROOT') || path.join(projectRoot, 'storage', 'assets')),
      maxBytes: numberValue('IP_AGENT_MAX_UPLOAD_BYTES', 500 * 1024 * 1024),
      directUploadExpiresSeconds: numberValue('IP_AGENT_OSS_UPLOAD_EXPIRES_SECONDS', 15 * 60),
      readUrlExpiresSeconds: numberValue('IP_AGENT_OSS_READ_EXPIRES_SECONDS', 60 * 60),
      uploadSigningSecret: value('IP_AGENT_UPLOAD_SIGNING_SECRET'),
      allowLocalInProduction: boolSetting('IP_AGENT_ALLOW_LOCAL_STORAGE_IN_PRODUCTION'),
      oss: {
        configured: ossConfigured,
        region: ossRegion,
        bucket: ossBucket,
        accessKeyId: ossAccessKeyId,
        accessKeySecret: ossAccessKeySecret,
        stsToken: value('ALIYUN_OSS_STS_TOKEN'),
        endpoint: ossEndpoint,
        internalEndpoint: value('ALIYUN_OSS_INTERNAL_ENDPOINT'),
        secure: !/^http:\/\//i.test(ossEndpoint || value('ALIYUN_OSS_INTERNAL_ENDPOINT'))
      },
      cdn: {
        domain: value('ALIYUN_CDN_DOMAIN').replace(/^https?:\/\//i, '').replace(/\/+$/, ''),
        authKey: value('ALIYUN_CDN_AUTH_KEY'),
        authType: (value('ALIYUN_CDN_AUTH_TYPE') || 'a').toLowerCase(),
        expiresSeconds: numberValue('ALIYUN_CDN_URL_EXPIRES_SECONDS', 60 * 60)
      }
    },
    llm: {
      enabled: Boolean(llmBaseUrl && llmModel),
      baseUrl: llmBaseUrl,
      apiKey: llmApiKey,
      model: llmModel,
      accountId: llmAccountId,
      timeoutMs: numberValue('IP_AGENT_LLM_TIMEOUT_MS', 45_000)
    },
    textLlm: {
      enabled: Boolean(textLlmBaseUrl && textLlmModel),
      dedicated: dedicatedTextLlm,
      baseUrl: textLlmBaseUrl,
      apiKey: textLlmApiKey,
      model: textLlmModel,
      accountId: textLlmAccountId,
      timeoutMs: numberValue('IP_AGENT_TEXT_LLM_TIMEOUT_MS', 60_000),
      fallbackToVideo: !dedicatedTextLlm
    },
    chat: {
      enabled: Boolean(chatBaseUrl && chatModel),
      baseUrl: chatBaseUrl,
      apiKey: chatApiKey,
      model: chatModel,
      inheritedBaseUrl: !chatBaseOverride,
      inheritedApiKey: !chatApiKeyOverride,
      inheritedTextModel: !chatBaseOverride && !chatApiKeyOverride && !chatModelOverride && dedicatedTextLlm,
      timeoutMs: numberValue('IP_AGENT_CHAT_TIMEOUT_MS', 60_000)
    },
    image: {
      enabled: Boolean(imageBaseUrl && imageModel),
      provider: imageProvider,
      baseUrl: imageBaseUrl,
      apiKey: imageApiKey,
      model: imageModel,
      replyType: value('IP_AGENT_IMAGE_REPLY_TYPE') || 'json',
      defaultAspectRatio: value('IP_AGENT_IMAGE_ASPECT_RATIO') || '1:1',
      pollIntervalMs: numberValue('IP_AGENT_IMAGE_POLL_INTERVAL_MS', 2_000),
      timeoutMs: numberValue('IP_AGENT_IMAGE_TIMEOUT_MS', 90_000)
    },
    pexels: {
      enabled: Boolean(value('PEXELS_API_KEY')),
      apiKey: value('PEXELS_API_KEY'),
      timeoutMs: numberValue('IP_AGENT_PEXELS_TIMEOUT_MS', 15_000)
    },
    media: {
      enabled: !boolValue('IP_AGENT_MEDIA_DISABLED'),
      ffmpegPath,
      ffprobePath,
      timeoutMs: numberValue('IP_AGENT_MEDIA_TIMEOUT_MS', 10 * 60_000)
    },
    platformMedia: {
      ytdlpCommand: value('IP_AGENT_YTDLP_COMMAND') || 'python -m yt_dlp',
      cookiesFile: value('IP_AGENT_YTDLP_COOKIES_FILE'),
      // A persisted Cookie file is authoritative. This also prevents an
      // environment-level browser setting from reintroducing the two-source
      // conflict after an administrator refreshes Cookie state.
      cookiesFromBrowser: value('IP_AGENT_YTDLP_COOKIES_FILE') ? '' : value('IP_AGENT_YTDLP_COOKIES_FROM_BROWSER'),
      timeoutMs: numberValue('IP_AGENT_YTDLP_TIMEOUT_MS', 10 * 60_000),
      maxBytes: numberValue('IP_AGENT_PLATFORM_VIDEO_MAX_BYTES', 100 * 1024 * 1024)
    },
    douyinAccount: {
      enabled: Boolean(douyinAccountApiKey),
      baseUrl: douyinAccountBaseUrl,
      apiKey: douyinAccountApiKey,
      timeoutMs: numberValue('IP_AGENT_TIKHUB_TIMEOUT_MS', 30_000),
      maxPosts: numberValue('IP_AGENT_TIKHUB_MAX_POSTS', 10)
    },
    videoEngine: {
      enabled: existsSync(videoEngineWhisperScript) && commandAvailable(videoEnginePythonCommand, ['--version']),
      pythonCommand: videoEnginePythonCommand,
      whisperScript: videoEngineWhisperScript,
      titokProjectRoot,
      whisperModel: value('IP_AGENT_VIDEO_ENGINE_WHISPER_MODEL') || 'Systran/faster-whisper-large-v3',
      whisperComputeType: value('IP_AGENT_VIDEO_ENGINE_WHISPER_COMPUTE_TYPE') || 'int8',
      whisperCpuThreads: numberValue('IP_AGENT_VIDEO_ENGINE_WHISPER_CPU_THREADS', 6),
      timeoutMs: numberValue('IP_AGENT_VIDEO_ENGINE_TIMEOUT_MS', 30 * 60_000)
    },
    videoRenderService: {
      url: videoRenderServiceUrl.replace(/\/+$/, ''),
      apiKey: videoRenderServiceApiKey,
      enabled: Boolean(videoRenderServiceUrl && videoRenderServiceApiKey),
      backend: videoBackend,
      // Keep the legacy key as a compatibility alias for existing releases;
      // the new key is exposed in the admin provider settings panel.
      fallbackLocal: boolSetting('IP_AGENT_VIDEO_RENDER_FALLBACK_LOCAL')
        || boolSetting('IP_AGENT_VIDEO_RENDER_SERVICE_FALLBACK_LOCAL'),
      timeoutMs: numberValue('IP_AGENT_VIDEO_RENDER_SERVICE_TIMEOUT_MS', 45 * 60_000),
      pollIntervalMs: numberValue('IP_AGENT_VIDEO_RENDER_SERVICE_POLL_INTERVAL_MS', 800),
      ims: {
        region: value('ALIYUN_IMS_REGION') || ossRegion || 'cn-shenzhen',
        endpoint: value('ALIYUN_IMS_ENDPOINT') || '',
        apiVersion: value('ALIYUN_IMS_API_VERSION') || '2020-11-09',
        accessKeyId: value('ALIYUN_IMS_ACCESS_KEY_ID') || ossAccessKeyId,
        accessKeySecret: value('ALIYUN_IMS_ACCESS_KEY_SECRET') || ossAccessKeySecret,
        storageLocation: value('ALIYUN_IMS_STORAGE_LOCATION') || '',
        timeoutMs: numberValue('IP_AGENT_VIDEO_RENDER_IMS_TIMEOUT_MS', 45 * 60_000),
        pollIntervalMs: numberValue('IP_AGENT_VIDEO_RENDER_IMS_POLL_INTERVAL_MS', 2_000),
        // `bare` = the reference implementation's unsigned OSS url; `signed` = the form a
        // private bucket actually needs. See remote-video-ims.js for what each one does.
        subtitleUrlMode: String(value('IP_AGENT_VIDEO_RENDER_IMS_SUBTITLE_URL') || 'bare').trim().toLowerCase(),
        enabled: Boolean((value('ALIYUN_IMS_ACCESS_KEY_ID') || ossAccessKeyId) && (value('ALIYUN_IMS_ACCESS_KEY_SECRET') || ossAccessKeySecret)),
      }
    },
    voice: {
      enabled: Boolean(voiceApiKey),
      apiKey: voiceApiKey,
      // This deployment is prepaid-only. Ignore legacy/admin overrides so a
      // request can never fall through to the billable custom voice path.
      billingMode: 'prepaid',
      prepaidSpeakerIds: (value('IP_AGENT_VOLCENGINE_VOICE_PREPAID_SPEAKER_IDS', 'IP_AGENT_VOLCENGINE_VOICE_PREPAID_SPEAKER_ID', 'VOLCENGINE_VOICE_PREPAID_SPEAKER_IDS', 'VOLCENGINE_VOICE_PREPAID_SPEAKER_ID') || '')
        .split(/[\s,;]+/)
        .map((item) => item.trim())
        .filter((item) => item && item !== 'custom_speaker_id'),
      cloneEndpoint: value('IP_AGENT_VOLCENGINE_VOICE_CLONE_ENDPOINT', 'VOLCENGINE_VOICE_CLONE_ENDPOINT') || 'https://openspeech.bytedance.com/api/v3/tts/voice_clone',
      statusEndpoint: value('IP_AGENT_VOLCENGINE_VOICE_STATUS_ENDPOINT', 'VOLCENGINE_VOICE_STATUS_ENDPOINT') || 'https://openspeech.bytedance.com/api/v3/tts/get_voice',
      ttsEndpoint: value('IP_AGENT_VOLCENGINE_TTS_ENDPOINT', 'VOLCENGINE_TTS_ENDPOINT') || 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
      appId: value('IP_AGENT_VOLCENGINE_TTS_APP_ID', 'VOLCENGINE_TTS_APP_ID'),
      cluster: value('IP_AGENT_VOLCENGINE_TTS_CLUSTER', 'VOLCENGINE_TTS_CLUSTER') || 'volcano_tts',
      uid: value('IP_AGENT_VOLCENGINE_TTS_UID', 'VOLCENGINE_TTS_UID') || 'domestic-ip-agent',
      resourceId: value('IP_AGENT_VOLCENGINE_TTS_RESOURCE_ID', 'VOLCENGINE_TTS_RESOURCE_ID') || 'seed-icl-2.0',
      demoText: value('IP_AGENT_VOLCENGINE_VOICE_DEMO_TEXT', 'VOLCENGINE_VOICE_DEMO_TEXT'),
      language: Number(value('IP_AGENT_VOLCENGINE_VOICE_LANGUAGE', 'VOLCENGINE_VOICE_CLONE_LANGUAGE') || 0),
      modelType: numberValue('IP_AGENT_VOLCENGINE_VOICE_MODEL_TYPE', 5),
      maxBytes: numberValue('IP_AGENT_VOLCENGINE_VOICE_MAX_BYTES', 10 * 1024 * 1024),
      timeoutMs: numberValue('IP_AGENT_VOLCENGINE_VOICE_TIMEOUT_MS', 120_000),
      pollIntervalMs: numberValue('IP_AGENT_VOLCENGINE_VOICE_POLL_INTERVAL_MS', 3_000)
    },
    multilingualTts: {
      enabled: Boolean(multilingualTtsApiKey),
      apiKey: multilingualTtsApiKey,
      endpoint: value('IP_AGENT_MULTILINGUAL_TTS_ENDPOINT', 'VOLCENGINE_MULTILINGUAL_TTS_ENDPOINT') || 'https://openspeech.bytedance.com/api/v3/tts/create',
      model: value('IP_AGENT_MULTILINGUAL_TTS_MODEL', 'VOLCENGINE_MULTILINGUAL_TTS_MODEL') || 'seed-audio-1.0-multilingual',
      timeoutMs: numberValue('IP_AGENT_MULTILINGUAL_TTS_TIMEOUT_MS', 310_000)
    },
    digitalHuman: {
      enabled: Boolean(skyHumanToken),
      token: skyHumanToken,
      baseUrl: value('IP_AGENT_SKYHUMAN_BASE_URL', 'SKYHUMAN_API_BASE_URL') || 'https://skyhumanapi.pilihu.vip',
      avatarId: value('IP_AGENT_SKYHUMAN_AVATAR_ID'),
      timeoutMs: numberValue('IP_AGENT_SKYHUMAN_TIMEOUT_MS', 10 * 60_000),
      uploadTimeoutMs: numberValue('IP_AGENT_SKYHUMAN_UPLOAD_TIMEOUT_MS', 5 * 60_000),
      downloadTimeoutMs: numberValue('IP_AGENT_SKYHUMAN_DOWNLOAD_TIMEOUT_MS', 5 * 60_000),
      maxVideoBytes: numberValue('IP_AGENT_SKYHUMAN_MAX_VIDEO_BYTES', 500 * 1024 * 1024),
      pollIntervalMs: numberValue('IP_AGENT_SKYHUMAN_POLL_INTERVAL_MS', 10_000),
      // SkyHuman may introduce a small mux/startup offset between the
      // uploaded narration and the returned MP4. Advance burned captions by
      // this amount; deployments can tune it without changing code.
      subtitleLeadMs: numberValue('IP_AGENT_DIGITAL_HUMAN_SUBTITLE_LEAD_MS', 120)
    },
    talkingPhoto: {
      enabled: Boolean(voiceApiKey && (
        talkingPhotoProvider === 'baidu-xiling'
          ? talkingPhotoBaiduAppId && talkingPhotoBaiduAppKey
          : talkingPhotoAccessKeyId && talkingPhotoSecretKey
      )),
      provider: talkingPhotoProvider,
      appId: talkingPhotoBaiduAppId,
      appKey: talkingPhotoBaiduAppKey,
      accessKeyId: talkingPhotoAccessKeyId,
      secretKey: talkingPhotoSecretKey,
      sessionToken: value('IP_AGENT_VOLCENGINE_VISUAL_SESSION_TOKEN', 'VOLC_SESSIONTOKEN'),
      baseUrl: talkingPhotoProvider === 'baidu-xiling'
        ? value('IP_AGENT_BAIDU_XILING_BASE_URL') || 'https://open.xiling.baidu.com'
        : value('IP_AGENT_VOLCENGINE_VISUAL_BASE_URL') || 'https://visual.volcengineapi.com',
      region: value('IP_AGENT_VOLCENGINE_VISUAL_REGION') || 'cn-north-1',
      service: value('IP_AGENT_VOLCENGINE_VISUAL_SERVICE') || 'cv',
      driveMode: ['auto', 'standard', 'expressive', 'large'].includes(value('IP_AGENT_TALKING_PHOTO_DRIVE_MODE').trim().toLowerCase())
        ? value('IP_AGENT_TALKING_PHOTO_DRIVE_MODE').trim().toLowerCase()
        : 'auto',
      engine: talkingPhotoProvider === 'baidu-xiling' ? 'photo-audio-driven' : 'single-image-audio-driven',
      model: ['quality_v2', 'turbo_v2'].includes(value('IP_AGENT_BAIDU_XILING_MODEL').trim().toLowerCase())
        ? value('IP_AGENT_BAIDU_XILING_MODEL').trim().toLowerCase()
        : 'quality_v2',
      standardVideoReqKey: 'realman_avatar_picture_v2',
      supportsVoiceCloning: false,
      requiresVoiceSelection: true,
      reusesMediaVoices: true,
      pricePerSecondCny: Number(value('IP_AGENT_TALKING_PHOTO_PRICE_PER_SECOND_CNY') || (talkingPhotoProvider === 'baidu-xiling' ? 0.075 : 0.3)),
      rolePriceCny: Number(value('IP_AGENT_TALKING_PHOTO_ROLE_PRICE_CNY') || (talkingPhotoProvider === 'baidu-xiling' ? 0 : 0.1)),
      aspectRatio: value('IP_AGENT_TALKING_PHOTO_ASPECT_RATIO') || '9:16',
      requestTimeoutMs: numberValue('IP_AGENT_TALKING_PHOTO_REQUEST_TIMEOUT_MS', 60_000),
      timeoutMs: numberValue('IP_AGENT_TALKING_PHOTO_TIMEOUT_MS', 15 * 60_000),
      downloadTimeoutMs: numberValue('IP_AGENT_TALKING_PHOTO_DOWNLOAD_TIMEOUT_MS', 5 * 60_000),
      pollIntervalMs: numberValue('IP_AGENT_TALKING_PHOTO_POLL_INTERVAL_MS', 5_000),
      largeMaxSeconds: numberValue('IP_AGENT_TALKING_PHOTO_LARGE_MAX_SECONDS', 45),
      maxImageBytes: numberValue('IP_AGENT_TALKING_PHOTO_MAX_IMAGE_BYTES', talkingPhotoProvider === 'baidu-xiling' ? 3 * 1024 * 1024 : 10 * 1024 * 1024),
      maxVideoBytes: numberValue('IP_AGENT_TALKING_PHOTO_MAX_VIDEO_BYTES', 500 * 1024 * 1024)
    },
    publishing: {
      enabled: existsSync(publishBridgePath) && commandAvailable(publishPythonCommand, ['--version']),
      pythonCommand: publishPythonCommand,
      bridgePath: publishBridgePath,
      sessionRoot: publishSessionRoot,
      // Login may need a headed renderer for platform risk-control pages. The
      // window stays hidden while its page is relayed into the web dialog.
      loginHeadless: boolSetting(
        'IP_AGENT_PUBLISH_LOGIN_HEADLESS',
        process.platform !== 'win32' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY
      ),
      timeoutMs: numberValue('IP_AGENT_PUBLISH_SERVICE_TIMEOUT_MS', 10_000),
      loginTimeoutMs: numberValue('IP_AGENT_PUBLISH_LOGIN_TIMEOUT_MS', 10 * 60_000),
      taskTimeoutMs: numberValue('IP_AGENT_PUBLISH_TASK_TIMEOUT_MS', 30 * 60_000),
      downloadTimeoutMs: numberValue('IP_AGENT_PUBLISH_DOWNLOAD_TIMEOUT_MS', 5 * 60_000),
      maxVideoBytes: numberValue('IP_AGENT_PUBLISH_MAX_VIDEO_BYTES', 500 * 1024 * 1024)
    },
    jianying: {
      enabled: existsSync(jianyingBridgePath) && existsSync(jianyingDraftRoot) && commandAvailable(jianyingPythonCommand, ['--version']),
      pythonCommand: jianyingPythonCommand,
      bridgePath: jianyingBridgePath,
      draftRoot: jianyingDraftRoot,
      indexPath: jianyingIndexPath,
      draftRootSource: configuredJianyingDraftRoot ? 'configured' : (jianyingDraftRoot === path.resolve(jianyingDefaultRoot) ? 'default' : 'jianying-settings'),
      timeoutMs: numberValue('IP_AGENT_JIANYING_TIMEOUT_MS', 5 * 60_000),
      downloadTimeoutMs: numberValue('IP_AGENT_JIANYING_DOWNLOAD_TIMEOUT_MS', 5 * 60_000),
      maxVideoBytes: numberValue('IP_AGENT_JIANYING_MAX_VIDEO_BYTES', 500 * 1024 * 1024)
    }
  };
}

export function providerStatus() {
  const config = getProviderConfig();
  const ffmpegReady = config.media.enabled && commandAvailable(config.media.ffmpegPath);
  const ffprobeReady = config.media.enabled && commandAvailable(config.media.ffprobePath);
  const mediaReady = ffmpegReady && ffprobeReady;
  const remoteVideoReady = config.videoRenderService.enabled;
  const imsVideoReady = config.videoRenderService.ims.enabled && config.storage.driver === 'oss';
  const videoReady = config.videoRenderService.backend === 'ims' ? imsVideoReady : remoteVideoReady;

  return [
    {
      id: 'llm',
      provider: /doubao-seed-evolving/i.test(config.llm.model) ? 'volcengine-ark-responses' : 'openai-compatible',
      state: config.llm.enabled ? 'configured' : 'needs_config',
      model: config.llm.model || null,
      accountId: config.llm.accountId || null,
      capabilities: ['video-understanding', 'benchmark-structure']
    },
    {
      id: 'text-llm',
      provider: /gpt-5/i.test(config.textLlm.model)
        ? 'openai-responses'
        : /ark\.cn-beijing\.volces\.com/i.test(config.textLlm.baseUrl)
          ? 'volcengine-ark-responses'
          : 'openai-compatible',
      state: config.textLlm.enabled ? 'configured' : 'needs_config',
      model: config.textLlm.model || null,
      accountId: config.textLlm.accountId || null,
      capabilities: ['positioning', 'copywriting', 'account-analysis', 'speech-translation'],
      diagnostic: config.textLlm.dedicated
        ? '文本任务使用独立 GPT 配置'
        : '未配置独立文本模型，文本任务回退视频理解模型'
    },
    {
      id: 'chat',
      provider: /gpt-5/i.test(config.chat.model)
        ? 'openai-responses'
        : /ark\.cn-beijing\.volces\.com/i.test(config.chat.baseUrl)
          ? 'volcengine-ark'
          : 'openai-compatible',
      state: config.chat.enabled ? 'configured' : 'needs_config',
      model: config.chat.model || null,
      capabilities: ['project-aware-chat', 'role-presets', 'conversation-history']
    },
    {
      id: 'semantic-search',
      provider: 'project-semantic-ranker',
      state: 'ready',
      capabilities: ['asset-query-plan', 'weighted-rank', 'deduplication']
    },
    {
      id: 'asset-storage',
      provider: config.storage.driver === 'oss' ? 'object-storage' : 'development-file-storage',
      state: config.storage.driver === 'oss' ? (config.storage.oss.configured ? 'configured' : 'needs_config') : 'ready',
      capabilities: config.storage.driver === 'oss'
        ? ['browser-direct-upload', 'private-object-storage', 'signed-read', ...(config.storage.cdn.domain ? ['cdn-delivery'] : [])]
        : ['development-upload', 'sha256', 'safe-access'],
      diagnostic: config.storage.driver === 'oss'
        ? (config.storage.oss.configured ? `对象存储已就绪${config.storage.cdn.domain ? '，CDN 已配置' : ''}` : 'OSS 配置不完整')
        : '当前为开发存储；生产环境将拒绝本地素材落盘'
    },
    {
      id: 'pexels',
      provider: 'pexels',
      state: config.pexels.enabled ? 'configured' : 'needs_config',
      capabilities: ['online-video-search']
    },
    {
      id: 'cut-analysis',
      provider: 'project-ffmpeg',
      state: mediaReady ? 'ready' : 'unavailable',
      capabilities: ['silence-detection', 'scene-detection', 'shot-timeline', 'keep-segments', 'trim-plan']
    },
    {
      id: 'douyin-account',
      provider: 'tikhub',
      state: config.douyinAccount.enabled ? 'configured' : 'needs_config',
      endpoint: config.douyinAccount.baseUrl,
      capabilities: ['account-profile', 'real-public-post-list', 'pagination'],
      diagnostic: config.douyinAccount.enabled ? '账号公开作品读取已就绪' : '账号公开作品读取功能待配置'
    },
    {
      id: 'douyin-video',
      provider: 'tikhub',
      state: config.douyinAccount.enabled ? 'configured' : 'needs_config',
      endpoint: config.douyinAccount.baseUrl,
      capabilities: ['share-url-resolve', 'video-download', 'cookie-free-analysis'],
      diagnostic: config.douyinAccount.enabled ? '抖音分享链接解析已就绪' : '抖音视频解析功能待配置'
    },
    {
      id: 'video',
      provider: config.videoRenderService.backend === 'ims' ? 'aliyun-ims' : 'private-video-render-service',
      state: videoReady ? 'ready' : 'unavailable',
      capabilities: config.videoRenderService.backend === 'ims'
        ? ['ims-render', 'oss-output', 'template-dispatch']
        : ['remote-render', 'template-dispatch'],
      diagnostic: config.videoRenderService.backend === 'ims' && !imsVideoReady
        ? 'IMS 需要有效的 OSS 素材存储和阿里云凭据'
        : null
    },
    {
      id: 'video-template-talking-head',
      provider: config.videoRenderService.backend === 'ims' ? 'aliyun-ims' : 'private-video-render-service',
      state: videoReady ? 'ready' : 'unavailable',
      capabilities: ['talking-head-edit', 'subtitle-render']
    },
    {
      id: 'video-template-vlog',
      provider: config.videoRenderService.backend === 'ims' ? 'aliyun-ims' : 'private-video-render-service',
      state: videoReady ? 'ready' : 'unavailable',
      capabilities: ['smart-edit', 'adaptive-subtitles', 'transitions']
    },
    {
      id: 'image',
      provider: config.image.provider === 'grsai-gpt-image' ? 'grsai-gpt-image' : 'openai-compatible-image',
      state: config.image.enabled && (config.image.provider !== 'grsai-gpt-image' || Boolean(config.image.apiKey)) ? 'configured' : 'needs_config',
      capabilities: ['text-to-image']
    },
    {
      id: 'voice-clone',
      provider: 'volcengine-direct',
      state: config.voice.enabled && (config.voice.billingMode === 'postpaid' || config.voice.prepaidSpeakerIds.length > 0) ? 'configured' : 'needs_config',
      capabilities: ['voice-clone', 'training-status', 'saved-voice-selection'],
      diagnostic: !config.voice.enabled
        ? '请配置声音服务 API Key'
        : config.voice.billingMode === 'prepaid' && !config.voice.prepaidSpeakerIds.length
          ? '预付费模式需要配置火山控制台提供的 S_... 音色槽位 ID'
          : null
    },
    {
      id: 'voice-tts',
      provider: 'volcengine-tts-direct',
      state: config.voice.enabled && Boolean(config.voice.ttsEndpoint && (config.voice.ttsEndpoint.includes('/api/v3/tts/unidirectional') ? config.voice.resourceId : config.voice.appId)) ? 'configured' : 'needs_config',
      capabilities: ['text-to-speech', 'cloned-voice-synthesis']
    },
    {
      id: 'multilingual-tts',
      provider: 'volcengine-seed-audio-multilingual',
      state: config.multilingualTts.enabled ? 'configured' : 'needs_config',
      model: config.multilingualTts.model,
      capabilities: ['multilingual-text-to-speech', 'uyghur-text-to-speech']
    },
    {
      id: 'digital-human',
      provider: 'skyhuman-direct',
      state: config.digitalHuman.enabled ? 'configured' : 'needs_config',
      capabilities: ['avatar-clone', 'saved-avatar-selection', 'audio-driven-video', 'script-and-cloned-voice-video']
    },
    {
      id: 'talking-photo',
      provider: config.talkingPhoto.provider === 'baidu-xiling' ? 'baidu-xiling' : 'volcengine-visual',
      state: config.talkingPhoto.enabled ? 'configured' : 'needs_config',
      endpoint: config.talkingPhoto.baseUrl,
      model: config.talkingPhoto.engine,
      pricePerSecondCny: config.talkingPhoto.pricePerSecondCny,
      rolePriceCny: config.talkingPhoto.rolePriceCny,
      capabilities: [
        'single-photo-video',
        'text-driven-speech',
        'reuse-media-lab-voice',
        'lip-sync',
        'natural-gesture-motion'
      ]
    },
    {
      id: 'publish-package',
      provider: 'project-publish-adapter',
      state: 'ready',
      capabilities: ['real-output-manifest', 'platform-metadata', 'json-export']
    },
    {
      id: 'platform-publish',
      provider: 'embedded-browser-automation',
      state: config.publishing.enabled ? 'configured' : 'unavailable',
      capabilities: ['qr-login', 'session-check', 'single-publish', 'batch-publish', 'draft', 'scheduled-publish'],
      diagnostic: config.publishing.enabled ? '内置发布模块已就绪；实际可用性以平台登录态和真实发布结果为准' : '内置发布模块不可用，请安装 Python 依赖并检查 Python 命令'
    },
    {
      id: 'jianying-draft',
      provider: 'pyJianYingDraft',
      state: config.jianying.enabled ? 'configured' : 'unavailable',
      capabilities: ['local-draft-create', 'video-track', 'srt-subtitles', 'material-copy', 'draft-index-registration'],
      diagnostic: config.jianying.enabled ? `真实草稿文件生成与剪映索引登记已就绪：${config.jianying.draftRoot}${config.jianying.draftRootSource === 'jianying-settings' ? '（已从剪映设置自动识别）' : ''}` : '未找到剪映草稿目录、Python 或剪映桥接模块'
    },
    {
      id: 'official-platform-publish',
      provider: 'official-platform-api',
      state: 'unavailable',
      capabilities: ['douyin-publish', 'xiaohongshu-publish', 'wechat-channel-publish']
    },
    {
      id: 'multimodal-analysis',
      provider: 'project-ffmpeg-plus-external-workers',
      state: mediaReady ? 'partial' : 'unavailable',
      capabilities: mediaReady ? ['shot-detection'] : [],
      missingCapabilities: ['asr', 'ocr', 'visual-understanding'],
      diagnostic: mediaReady ? '本地镜头检测可用；语音、文字和视觉理解能力仍待接入' : '镜头检测与多模态分析功能均未就绪'
    }
  ];
}
