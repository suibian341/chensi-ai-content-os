import { spawn } from 'node:child_process';
import { ProviderError } from '../lib/http.js';
import { currentRenderSignal } from '../lib/render-context.js';
import { getProviderConfig } from '../providers/config.js';

function commandParts(command) {
  const value = String(command || 'python').trim();
  const match = value.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+(.+))?$/);
  if (!match) return { command: value, args: [] };
  return {
    command: match[1] || match[2] || match[3],
    args: match[4] ? match[4].match(/"[^"]+"|'[^']+'|\S+/g).map((part) => part.replace(/^['"]|['"]$/g, '')) : [],
  };
}

export function transcribeWords(mediaPath, options = {}) {
  const config = getProviderConfig().videoEngine;
  if (!config.enabled) throw new ProviderError('VIDEO_TRANSCRIPTION_UNAVAILABLE', 'Video transcription is unavailable', { status: 503 });
  const signal = currentRenderSignal();
  if (signal?.aborted) throw new ProviderError('RENDER_CANCELED', 'Render canceled', { status: 499 });
  const parts = commandParts(config.pythonCommand);
  const args = [
    ...parts.args,
    config.whisperScript,
    mediaPath,
    '--model', String(options.model || config.whisperModel),
    '--device', String(options.device || config.whisperDevice),
    '--compute-type', String(options.computeType || config.whisperComputeType),
    '--cpu-threads', String(options.cpuThreads || config.whisperCpuThreads),
  ];
  if (options.language) args.push('--language', String(options.language));
  return new Promise((resolve, reject) => {
    const child = spawn(parts.command, args, {
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      callback();
    };
    const abort = () => {
      child.kill();
      finish(() => reject(new ProviderError('RENDER_CANCELED', 'Render canceled', { status: 499 })));
    };
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-12_000); });
    timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new ProviderError('VIDEO_TRANSCRIPTION_TIMEOUT', 'Video transcription timed out', { retryable: true })));
    }, config.timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', (error) => {
      finish(() => reject(new ProviderError('VIDEO_TRANSCRIPTION_UNAVAILABLE', 'Unable to start video transcription', { status: 503, details: error.message })));
    });
    child.once('close', (code) => {
      let payload;
      try {
        payload = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || '{}');
      } catch (error) {
        finish(() => reject(new ProviderError('VIDEO_TRANSCRIPTION_INVALID', 'Video transcription returned invalid data', { details: `${error.message}\n${stderr}` })));
        return;
      }
      if (code !== 0 || payload.ok !== true) {
        finish(() => reject(new ProviderError('VIDEO_TRANSCRIPTION_FAILED', 'Video transcription failed', { retryable: true, details: stderr || payload.error })));
        return;
      }
      finish(() => resolve(payload));
    });
  });
}
