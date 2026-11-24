import { spawn } from 'node:child_process';
import { ProviderError } from '../lib/http.js';
import { getProviderConfig } from '../providers/config.js';

function commandParts(command) {
  const value = String(command || 'python').trim();
  const match = value.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+(.+))?$/);
  if (!match) return { command: value, args: [] };
  return { command: match[1] || match[2] || match[3], args: match[4] ? match[4].match(/"[^"]+"|'[^']+'|\S+/g).map((part) => part.replace(/^['"]|['"]$/g, '')) : [] };
}

export function transcribeWords(mediaPath, options = {}) {
  const config = getProviderConfig().videoEngine;
  if (!config.enabled) throw new ProviderError('VIDEO_TRANSCRIPTION_UNAVAILABLE', '本地语音识别功能未配置或不可用', { status: 503 });
  const parts = commandParts(config.pythonCommand);
  const args = [
    ...parts.args,
    config.whisperScript,
    mediaPath,
    '--model', String(options.model || config.whisperModel),
    '--compute-type', String(options.computeType || config.whisperComputeType),
    '--cpu-threads', String(options.cpuThreads || config.whisperCpuThreads),
  ];
  if (options.language) args.push('--language', String(options.language));
  return new Promise((resolve, reject) => {
    const child = spawn(parts.command, args, {
      windowsHide: true,
      // Keep JSON word timestamps lossless for Chinese audio on Windows.
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-12_000); });
    const timer = setTimeout(() => {
      child.kill();
      reject(new ProviderError('VIDEO_TRANSCRIPTION_TIMEOUT', '本地语音转写超时', { retryable: true }));
    }, config.timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new ProviderError('VIDEO_TRANSCRIPTION_UNAVAILABLE', '无法启动本地语音识别功能', { status: 503, details: error.message }));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      let payload;
      try { payload = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || '{}'); } catch (error) {
        reject(new ProviderError('VIDEO_TRANSCRIPTION_INVALID', '本地转写没有返回合法 JSON', { details: `${error.message}\n${stderr}` }));
        return;
      }
      if (code !== 0 || payload.ok !== true) {
        reject(new ProviderError('VIDEO_TRANSCRIPTION_FAILED', payload.error || '本地转写失败', { retryable: true, details: stderr }));
        return;
      }
      resolve(payload);
    });
  });
}
