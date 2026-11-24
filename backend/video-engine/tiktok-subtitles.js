import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProviderConfig } from '../providers/config.js';
import { prepareGeneratedFile } from '../lib/storage.js';
import { transcribeWords } from './whisper.js';

const bridgePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'python', 'tiktok_subtitle_bridge.py');

function commandParts(command) {
  const value = String(command || 'python').trim();
  const match = value.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+(.+))?$/);
  if (!match) return { command: value, args: [] };
  const args = match[4]
    ? match[4].match(/"[^"]+"|'[^']+'|\S+/g).map((part) => part.replace(/^['"]|['"]$/g, ''))
    : [];
  return { command: match[1] || match[2] || match[3], args };
}

function ratioCanvas(ratio) {
  const normalized = String(ratio || '9:16').trim();
  if (normalized === '16:9') return { width: 1920, height: 1080 };
  if (normalized === '1:1') return { width: 1080, height: 1080 };
  if (normalized === '4:3') return { width: 1440, height: 1080 };
  return { width: 1080, height: 1920 };
}

function splitFallbackSentences(text) {
  const value = String(text || '').replace(/\r/g, '').trim();
  if (!value) return [];
  if (/\s/.test(value) && !/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(value)) {
    return value.split(/\n+|(?<=[.!?;])\s+/).map((item) => item.trim()).filter(Boolean);
  }
  const sentences = value.match(/[^。！？；!?;\n]+[。！？；!?;]?/g)
    ?.map((item) => item.trim()).filter(Boolean) || [];
  if (!sentences.length) return [value];
  return sentences.flatMap((sentence) => {
    if (sentence.length <= 28) return [sentence];
    const chunks = sentence.split(/(?<=[，,、])\s*/).map((item) => item.trim()).filter(Boolean);
    if (chunks.length > 1) return chunks;
    return sentence.match(/[\s\S]{1,24}/g) || [sentence];
  });
}

function fallbackWords(text, durationSeconds, referenceTimeline = []) {
  const value = String(text || '').trim();
  if (!value) return [];
  const tokens = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(value)
    ? splitFallbackSentences(value)
    : value.split(/\s+/).filter(Boolean);
  const durationMs = Math.max(1_000, Math.round(Number(durationSeconds || 1) * 1000));
  const timeline = (Array.isArray(referenceTimeline) ? referenceTimeline : [])
    .map((item) => ({
      start: Number(item?.start ?? (Number(item?.start_ms) / 1000)),
      end: Number(item?.end ?? (Number(item?.end_ms) / 1000)),
    }))
    .filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start);
  const useReference = timeline.length === tokens.length;
  const weights = tokens.map((token) => Math.max(1, token.replace(/\s/g, '').length));
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = 0;
  return tokens.map((token, index) => {
    let start;
    let end;
    if (useReference) {
      const sourceTotal = timeline.at(-1).end;
      const scale = sourceTotal > 0 ? durationMs / (sourceTotal * 1000) : 1;
      start = Math.round(Math.max(0, timeline[index].start * 1000 * scale));
      end = Math.round(Math.min(durationMs, timeline[index].end * 1000 * scale));
    } else {
      start = Math.round(cursor);
      cursor += durationMs * (weights[index] / weightTotal);
      end = Math.round(index === tokens.length - 1 ? durationMs : cursor);
    }
    start = Math.max(0, Math.min(durationMs - 1, start));
    end = Math.min(durationMs, Math.max(start + 1, end));
    return { text: token, start_ms: start, end_ms: end, confidence: null };
  });
}

function normalizeWords(words, durationMs) {
  const limit = Math.max(1, Math.round(Number(durationMs) || 1));
  return (Array.isArray(words) ? words : []).map((item) => {
    const text = String(item?.text ?? item?.word ?? '').trim();
    const startValue = Number(item?.start_ms ?? (Number(item?.start) * 1000));
    const endValue = Number(item?.end_ms ?? (Number(item?.end) * 1000));
    if (!text || !Number.isFinite(startValue) || !Number.isFinite(endValue) || endValue <= 0 || startValue >= limit) return null;
    const start = Math.max(0, Math.min(limit - 1, Math.round(startValue)));
    const end = Math.min(limit, Math.max(start + 1, Math.round(endValue)));
    if (end <= start) return null;
    const confidence = Number(item?.confidence);
    return {
      text,
      start_ms: start,
      end_ms: end,
      confidence: Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? confidence : null,
    };
  }).filter(Boolean);
}

function invokeBridge(payload, timeoutMs) {
  const config = getProviderConfig().videoEngine;
  const parts = commandParts(config.pythonCommand);
  return new Promise((resolve, reject) => {
    const child = spawn(parts.command, [...parts.args, bridgePath], {
      windowsHide: true,
      env: {
        ...process.env,
        // Python defaults to the Windows console code page (GBK). The bridge
        // returns JSON containing Chinese subtitle text, so force a UTF-8
        // stream before Node decodes stdout.
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        ...(config.titokProjectRoot ? { IP_AGENT_TITOK_PROJECT_ROOT: config.titokProjectRoot } : {}),
      },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('字幕生成超时'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4_000); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      let result;
      try {
        result = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || '{}');
      } catch (error) {
        reject(new Error(`字幕处理返回无效数据: ${error.message}`));
        return;
      }
      if (code !== 0 || result.ok !== true || typeof result.ass !== 'string' || !result.ass.trim()) {
        reject(new Error(result.error || stderr || '字幕生成失败'));
        return;
      }
      resolve(result);
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

export async function createTikTokAdaptiveSubtitle({ audioPath, text, durationSeconds, language, ratio = '9:16', referenceTimeline = [], subtitleOffsetMs = 0, timedWords = null }) {
  const duration = Number.isFinite(Number(durationSeconds)) && Number(durationSeconds) > 0
    ? Number(durationSeconds)
    : Math.max(1, Math.min(600, String(text || '').length / 4.8));
  const durationMs = Math.max(1_000, Math.round(duration * 1000));
  let words = [];
  let transcribed = false;
  if (Array.isArray(timedWords) && timedWords.length) {
    words = normalizeWords(timedWords, durationMs);
    transcribed = words.length > 0;
  } else if (audioPath) {
    try {
      const transcript = await transcribeWords(audioPath, { language: String(language || '').split(/[-_]/)[0] || undefined });
      words = normalizeWords((transcript.words || []).map((item) => ({
        text: item.word,
        start: item.start,
        end: item.end,
        confidence: item.confidence ?? null,
      })), durationMs);
      transcribed = words.length > 0;
    } catch {
      // Local faster-whisper is optional. The bridge still produces a stable
      // subtitle timeline from the known speech script below.
    }
  }
  const canvas = ratioCanvas(ratio);
  const fallback = words.length ? words : fallbackWords(text, duration, referenceTimeline);
  const referenceTimed = !transcribed && !words.length && fallback.length > 0
    && Array.isArray(referenceTimeline) && referenceTimeline.length === fallback.length;
  const result = await invokeBridge({
    text: String(text || '').trim(),
    words: fallback,
    duration_ms: durationMs,
    language: String(language || ''),
    reference_timeline: Array.isArray(referenceTimeline) ? referenceTimeline : [],
    word_timings_measured: transcribed,
    subtitle_offset_ms: Number.isFinite(Number(subtitleOffsetMs)) ? Math.round(Number(subtitleOffsetMs)) : 0,
    width: canvas.width,
    height: canvas.height,
  }, Math.min(30 * 60_000, getProviderConfig().videoEngine.timeoutMs));
  return { ...result, transcribed, referenceTimed, canvas };
}

export async function saveAdaptiveSubtitleFile({ project, task, title, content }) {
  if (!content) return null;
  const prepared = await prepareGeneratedFile({
    userId: project.ownerId,
    projectId: project.id,
    taskId: `${task.id}-subtitles`,
    name: `${title || project.name || 'video'}-subtitles.ass`,
  });
  // Keep the UTF-8 BOM for Windows media players and NLEs that otherwise
  // guess the system code page when opening Chinese ASS files.
  await fs.writeFile(prepared.filePath, `\ufeff${content}`, 'utf8');
  return prepared;
}
