import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ProviderError } from '../lib/http.js';
import { findSource, probeDuration } from '../providers/media.js';
import { burnSubtitles, concatSegments, createTextSrt, ensureNativeMedia, normalizeSegment, outputFileInfo, prepareVideoOutput, saveSubtitleFile, SUBTITLE_MAX_LINE_CHARACTERS, subtitleLineWidth, wrapSubtitleLines } from './common.js';
import { transcribeWords } from './whisper.js';

const HOOK_WORDS = /^(今天|现在|你知道|为什么|如果|其实|先说|重点|注意|大家好|揭秘|最重要|不要)/i;
const EMOTION_WORDS = /(但是|然而|惊喜|关键|问题|结果|成功|失败|最|千万|一定|真的|绝对|爆款|避坑)/i;

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Math.min(max, Math.max(min, Number.isFinite(parsed) ? parsed : fallback));
}

function transcriptSegments(transcript, duration) {
  const source = Array.isArray(transcript?.segments) ? transcript.segments : [];
  if (source.length) return source.map((item, index) => ({ id: `segment-${index + 1}`, start: Number(item.start) || 0, end: Math.min(duration, Number(item.end) || 0), text: String(item.text || '').trim(), words: item.words || [] })).filter((item) => item.end > item.start + 0.15);
  const words = Array.isArray(transcript?.words) ? transcript.words : [];
  const result = [];
  let current = null;
  for (const word of words) {
    if (!current || word.start - current.end > 0.8 || current.text.length > 90) {
      if (current) result.push(current);
      current = { id: `segment-${result.length + 1}`, start: word.start, end: word.end, text: word.word, words: [word] };
    } else {
      current.end = word.end;
      current.text += word.word;
      current.words.push(word);
    }
  }
  if (current) result.push(current);
  return result.filter((item) => item.end > item.start + 0.15 && item.end <= duration + 0.5);
}

function semanticWindowBounds(duration) {
  if (duration <= 90) return { min: Math.max(2, duration * 0.35), target: duration, max: duration + 0.5 };
  if (duration <= 600) return { min: 15, target: 35, max: 75 };
  return { min: 120, target: 300, max: 720 };
}

function appendSegmentText(current, text) {
  const next = String(text || '').trim();
  if (!current || !next) return `${current || ''}${next}`;
  const separator = /[A-Za-z0-9]$/.test(current) && /^[A-Za-z0-9]/.test(next) ? ' ' : '';
  return `${current}${separator}${next}`;
}

export function semanticSegments(transcript, duration) {
  const raw = transcriptSegments(transcript, duration);
  if (raw.length <= 1) return raw;
  const bounds = semanticWindowBounds(duration);
  const windows = [];
  let current = null;
  const finish = () => {
    if (!current) return;
    windows.push({ ...current, id: `segment-${windows.length + 1}` });
    current = null;
  };
  for (const segment of raw) {
    const gap = current ? segment.start - current.end : 0;
    if (current && gap >= 3) finish();
    if (!current) current = { start: segment.start, end: segment.end, text: segment.text, words: [...(segment.words || [])] };
    else {
      current.end = segment.end;
      current.text = appendSegmentText(current.text, segment.text);
      current.words.push(...(segment.words || []));
    }
    const segmentDuration = current.end - current.start;
    const naturalBoundary = /[。！？!?；;.]$/.test(current.text);
    if (segmentDuration >= bounds.max || (segmentDuration >= bounds.target && naturalBoundary)) finish();
  }
  finish();
  if (windows.length > 1) {
    const last = windows.at(-1);
    const previous = windows.at(-2);
    const lastDuration = last.end - last.start;
    if (lastDuration < bounds.min && last.start - previous.end < 3 && last.end - previous.start <= bounds.max) {
      previous.end = last.end;
      previous.text = appendSegmentText(previous.text, last.text);
      previous.words.push(...last.words);
      windows.pop();
    }
  }
  return windows;
}

export function scoreSegment(segment, { index = 0, total = 1, category = '' } = {}) {
  const text = String(segment.text || '').trim();
  const words = text.split(/\s+/).filter(Boolean).length || text.length;
  const hook = HOOK_WORDS.test(text) ? 0.24 : index === 0 ? 0.1 : 0;
  const emotion = EMOTION_WORDS.test(text) ? 0.2 : 0;
  const density = Math.min(0.3, words / Math.max(1, segment.end - segment.start) / 8);
  const length = segment.end - segment.start >= 4 && segment.end - segment.start <= 120 ? 0.16 : 0.06;
  const completeness = /[。！？!?；;.]$/.test(text) ? 0.1 : 0;
  const categoryBoost = category && text.toLowerCase().includes(String(category).toLowerCase()) ? 0.12 : 0;
  const position = total > 1 ? (1 - index / total) * 0.1 : 0.1;
  const score = Math.min(1, hook + emotion + density + length + completeness + categoryBoost + position);
  return { ...segment, score: Number(score.toFixed(3)), reasons: [hook ? '开场钩子' : '', emotion ? '情绪词密度' : '', density > 0.15 ? '信息密度高' : '', categoryBoost ? '行业关键词' : ''].filter(Boolean) };
}

// The original AutoClip stages are kept as small, deterministic project
// functions so the pipeline remains inspectable without an external worker.
export function extractOutline(segments) {
  return (segments || []).map((segment, index) => ({
    id: segment.id || `segment-${index + 1}`,
    title: String(segment.text || '').slice(0, 38),
    start: segment.start,
    end: segment.end,
    hook: HOOK_WORDS.test(String(segment.text || '')),
  }));
}

export function generateHookTitle(segment, industry = '') {
  const text = String(segment?.text || '').replace(/\s+/g, ' ').trim();
  const prefix = industry ? `${industry}：` : '';
  return `${prefix}${text.slice(0, 28)}${text.length > 28 ? '…' : ''}` || `${prefix}行业高光片段`;
}

export function clusterHighlights(segments) {
  const clusters = new Map();
  for (const segment of segments || []) {
    const key = segment.reasons?.includes('行业关键词') ? 'industry' : segment.reasons?.includes('开场钩子') ? 'hook' : 'insight';
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(segment);
  }
  return [...clusters.entries()].map(([label, items]) => ({ label, segments: items.sort((a, b) => b.score - a.score) }));
}

export function selectHighlights(segments, options = {}) {
  const scoreThreshold = boundedNumber(options.scoreThreshold, 0.7, 0.5, 0.95);
  const maxHighlights = Math.round(boundedNumber(options.maxHighlights, 5, 1, 10));
  const candidates = [...(segments || [])]
    .filter((segment) => Number(segment.end) > Number(segment.start) + 0.15)
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || a.start - b.start);
  const selected = [];
  for (const segment of candidates) {
    if (Number(segment.score || 0) < scoreThreshold) continue;
    if (selected.some((item) => Math.max(item.start, segment.start) < Math.min(item.end, segment.end))) continue;
    selected.push(segment);
    if (selected.length >= maxHighlights) break;
  }
  if (!selected.length && candidates.length) selected.push(candidates[0]);
  return selected.sort((a, b) => a.start - b.start);
}

function remapWords(words, selected) {
  let offset = 0;
  const output = [];
  for (const segment of selected) {
    for (const word of words || []) if (word.start >= segment.start && word.end <= segment.end) output.push({ ...word, start: word.start - segment.start + offset, end: word.end - segment.start + offset });
    offset += segment.end - segment.start;
  }
  return output;
}

function wordsSrt(words) {
  if (!words.length) return '';
  const lines = [];
  let current = null;
  for (const word of words) {
    if (!current || word.start - current.end > 0.65 || subtitleLineWidth(current.text) >= SUBTITLE_MAX_LINE_CHARACTERS) { if (current) lines.push(current); current = { start: word.start, end: word.end, text: word.word }; }
    else { current.end = word.end; current.text += /[\u4e00-\u9fff]/.test(current.text.at(-1) || '') ? word.word : ` ${word.word}`; }
  }
  if (current) lines.push(current);
  const timestamp = (seconds) => {
    const ms = Math.max(0, Math.round(seconds * 1000));
    return `${String(Math.floor(ms / 3_600_000)).padStart(2, '0')}:${String(Math.floor(ms / 60_000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
  };
  return lines.map((line, index) => `${index + 1}\n${timestamp(line.start)} --> ${timestamp(line.end)}\n${wrapSubtitleLines(line.text).join('\n')}`).join('\n\n') + '\n';
}

export async function renderIndustryViral(task, input, project, { onProgress = async () => {} } = {}) {
  const config = ensureNativeMedia();
  const ids = [...new Set([...(Array.isArray(input.videoAssetIds) ? input.videoAssetIds : []), input.videoAssetId].filter(Boolean).map(String))];
  if (ids.length > 1) throw new ProviderError('VIDEO_ASSET_COUNT_INVALID', '行业爆款模板只接受一条原始视频', { status: 400 });
  const selectedId = ids[0] || '';
  const source = await findSource({ assetId: selectedId, explicit: input.videoSample, assets: project.assets, mimePrefix: 'video/', timeoutMs: config.timeoutMs });
  if (!source?.filePath) throw new ProviderError('VIDEO_ASSET_REQUIRED', '请先上传并选择行业爆款原始视频', { status: 400 });
  await onProgress(14, '原始视频已读取');
  const duration = await probeDuration(source.filePath, config);
  await onProgress(20, '视频时长已识别');
  const transcript = await transcribeWords(source.filePath, { language: input.language });
  await onProgress(38, '内容时间线已识别');
  const timeline = semanticSegments(transcript, duration);
  const outline = extractOutline(timeline);
  const segments = timeline.map((segment, index, all) => scoreSegment(segment, { index, total: all.length, category: input.industry || input.category || '' }));
  const clusters = clusterHighlights(segments);
  const scoreThreshold = boundedNumber(input.scoreThreshold, 0.7, 0.5, 0.95);
  const maxHighlights = Math.round(boundedNumber(input.maxHighlights, 5, 1, 10));
  const selected = selectHighlights(segments, { scoreThreshold, maxHighlights });
  if (!selected.length) throw new ProviderError('VIDEO_HIGHLIGHT_EMPTY', '未找到可用的行业高光片段');
  await onProgress(44, '高光片段已筛选');
  const prepared = await prepareVideoOutput({ project, task, title: input.title, suffix: 'industry-viral' });
  const workDir = await fs.mkdtemp(path.join(path.dirname(prepared.filePath), `industry-viral-${task.id}-`));
  let subtitleFile = null;
  try {
    const paths = [];
    for (let index = 0; index < selected.length; index += 1) {
      const segmentPath = path.join(workDir, `highlight-${index}.mp4`);
      await normalizeSegment({ source: source.filePath, destination: segmentPath, start: selected[index].start, duration: selected[index].end - selected[index].start, ratio: input.ratio || '9:16', config, crop: true, enhance: input.hdFilter !== false });
      paths.push(segmentPath);
      await onProgress(44 + Math.round(((index + 1) / selected.length) * 22), `已处理高光 ${index + 1}/${selected.length}`);
    }
    const subtitle = String(input.subtitleText || '').trim()
      ? createTextSrt(input.subtitleText, selected.reduce((sum, item) => sum + item.end - item.start, 0))
      : wordsSrt(remapWords(transcript.words, selected));
    subtitleFile = await saveSubtitleFile({ project, task, title: input.title || '行业爆款', content: subtitle });
    await onProgress(70, '字幕文件已生成');
    const basePath = subtitleFile ? path.join(workDir, 'industry-viral-base.mp4') : prepared.filePath;
    await concatSegments(paths, basePath, workDir, config);
    await onProgress(78, '高光片段已合并');
    if (subtitleFile) await burnSubtitles(basePath, subtitleFile.filePath, prepared.filePath, config);
    await onProgress(86, subtitleFile ? '字幕已合成到视频' : '视频合成完成');
    const info = await outputFileInfo(prepared.filePath);
    await onProgress(90, '成片文件已校验');
    return {
      provider: 'native-autoclip', model: transcript.language || null, externalTaskId: null,
      output: {
        ...prepared, sizeBytes: info.stat.size, durationSeconds: info.durationSeconds, sourceDurationSeconds: duration, ratio: input.ratio || '9:16', sourceAssetId: source.assetId || null, sourceAssetIds: source.assetId ? [source.assetId] : [], segmentCount: paths.length, subtitleStorageKey: subtitleFile?.storageKey || null, subtitleFilename: subtitleFile?.filename || null, subtitleText: String(input.subtitleText || '').trim(), subtitleSource: input.subtitleSource === 'manual' ? 'manual' : 'auto', template: 'industry-viral', templateLabel: '行业爆款高光', algorithm: '语义高光剪辑', pipelineStages: ['outline', 'timeline', 'scoring', 'title', 'clustering', 'video'], outline, clusters: clusters.map((cluster) => ({ label: cluster.label, count: cluster.segments.length })), industry: input.industry || input.category || '', scoreThreshold, maxHighlights, highlights: selected.map(({ id, start, end, score, reasons, text }) => ({ id, start, end, score, reasons, title: generateHookTitle({ text }, input.industry || input.category || ''), text })), editSummary: `从 ${segments.length} 个语义片段中自动筛选 ${selected.length} 个高光片段`
      }
    };
  } catch (error) {
    await fs.rm(prepared.filePath, { force: true }).catch(() => {});
    if (subtitleFile) await fs.rm(subtitleFile.filePath, { force: true }).catch(() => {});
    throw error;
  } finally { await fs.rm(workDir, { recursive: true, force: true }).catch(() => {}); }
}
