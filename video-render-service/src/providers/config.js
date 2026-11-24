import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';

const serviceRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

function loadServiceEnv() {
  let content;
  try {
    content = readFileSync(path.join(serviceRoot, '.env'), 'utf8');
  } catch {
    return;
  }
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let current = match[2].trim();
    if ((current.startsWith('"') && current.endsWith('"')) || (current.startsWith("'") && current.endsWith("'"))) {
      current = current.slice(1, -1);
    } else {
      current = current.replace(/\s+#.*$/, '').trim();
    }
    process.env[match[1]] = current;
  }
}

loadServiceEnv();

function value(name, fallback = '') {
  const current = String(process.env[name] ?? '').trim();
  return current || fallback;
}

function numberValue(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = value(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export function commandAvailable(command, args = ['-version']) {
  if (!command) return false;
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 3_000,
  });
  return !result.error && result.status === 0;
}

export function getProviderConfig() {
  const pythonCommand = value('VIDEO_RENDER_PYTHON_COMMAND', 'python');
  const whisperScript = path.join(serviceRoot, 'src', 'video-engine', 'python', 'transcribe_words.py');
  const defaultCpuThreads = Math.max(1, availableParallelism());
  return {
    service: {
      root: serviceRoot,
      host: value('VIDEO_RENDER_HOST', '0.0.0.0'),
      port: numberValue('VIDEO_RENDER_PORT', 4399, { max: 65_535 }),
      apiKeys: value('VIDEO_RENDER_API_KEYS', value('VIDEO_RENDER_API_KEY'))
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
      maxJsonBytes: numberValue('VIDEO_RENDER_MAX_JSON_BYTES', 4 * 1024 * 1024),
      queueConcurrency: numberValue('VIDEO_RENDER_QUEUE_CONCURRENCY', 1, { max: 8 }),
      jobTimeoutMs: numberValue('VIDEO_RENDER_JOB_TIMEOUT_MS', 45 * 60_000),
      // How long an outbound asset import (a signed OSS URL supplied by the main
      // application) may take. Large objects over a slow link need headroom, so
      // this matches the job timeout by default.
      assetImportTimeoutMs: numberValue('VIDEO_RENDER_ASSET_IMPORT_TIMEOUT_MS', 45 * 60_000),
      completedJobTtlMs: numberValue('VIDEO_RENDER_COMPLETED_JOB_TTL_MS', 24 * 60 * 60_000),
    },
    storage: {
      root: path.resolve(value('VIDEO_RENDER_STORAGE_ROOT', path.join(serviceRoot, 'runtime-data'))),
      maxBytes: numberValue('VIDEO_RENDER_MAX_ASSET_BYTES', 2 * 1024 * 1024 * 1024),
      maxBackgroundMusicBytes: numberValue('VIDEO_RENDER_MAX_BACKGROUND_MUSIC_BYTES', 100 * 1024 * 1024),
    },
    media: {
      enabled: value('VIDEO_RENDER_MEDIA_DISABLED') !== '1',
      ffmpegPath: value('VIDEO_RENDER_FFMPEG_PATH', 'ffmpeg'),
      ffprobePath: value('VIDEO_RENDER_FFPROBE_PATH', 'ffprobe'),
      timeoutMs: numberValue('VIDEO_RENDER_MEDIA_TIMEOUT_MS', 30 * 60_000),
    },
    videoEngine: {
      enabled: existsSync(whisperScript) && commandAvailable(pythonCommand, ['--version']),
      pythonCommand,
      whisperScript,
      titokProjectRoot: value('VIDEO_RENDER_SUBTITLE_PROJECT_ROOT', serviceRoot),
      whisperModel: value('VIDEO_RENDER_WHISPER_MODEL', 'Systran/faster-whisper-large-v3'),
      whisperDevice: value('VIDEO_RENDER_WHISPER_DEVICE', 'auto').toLowerCase(),
      whisperComputeType: value('VIDEO_RENDER_WHISPER_COMPUTE_TYPE', 'auto').toLowerCase(),
      whisperCpuThreads: numberValue('VIDEO_RENDER_WHISPER_CPU_THREADS', defaultCpuThreads, { max: 256 }),
      timeoutMs: numberValue('VIDEO_RENDER_TRANSCRIPTION_TIMEOUT_MS', 30 * 60_000),
    },
  };
}
