import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ProviderError } from '../lib/http.js';
import { findSource, probeDuration } from '../providers/media.js';
import { burnSubtitles, concatSegments, createTextSrt, ensureNativeMedia, normalizeSegment, prepareVideoOutput, saveSubtitleFile, outputFileInfo, SUBTITLE_MAX_LINE_CHARACTERS, subtitleLineWidth, wrapSubtitleLines } from './common.js';
import { transcribeWords } from './whisper.js';

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Math.min(max, Math.max(min, Number.isFinite(parsed) ? parsed : fallback));
}

export function detectGaps(words, totalDuration, threshold = 0.1, padding = 0.02) {
  const cutIntervals = [];
  const sorted = (Array.isArray(words) ? words : [])
    .map((item) => ({ start: Number(item.start), end: Number(item.end) }))
    .filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start)
    .sort((a, b) => a.start - b.start);
  if (!(totalDuration > 0) || !sorted.length) return cutIntervals;
  const th = boundedNumber(threshold, 0.1, 0.05, 2);
  const pad = boundedNumber(padding, 0.02, 0, 0.5);
  if (sorted[0].start >= th) {
    const end = Math.max(0, sorted[0].start - pad);
    if (end > 0) cutIntervals.push({ start: 0, end, duration: end });
  }
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const gap = sorted[index + 1].start - sorted[index].end;
    if (gap < th) continue;
    const start = sorted[index].end + pad;
    const end = sorted[index + 1].start - pad;
    if (end > start) cutIntervals.push({ start, end, duration: end - start });
  }
  const lastEnd = sorted.at(-1).end;
  if (totalDuration - lastEnd >= th) {
    const start = lastEnd + pad;
    if (start < totalDuration) cutIntervals.push({ start, end: totalDuration, duration: totalDuration - start });
  }
  return cutIntervals;
}

export function cutsToKeep(cuts, totalDuration) {
  const keep = [];
  let cursor = 0;
  for (const cut of [...(cuts || [])].sort((a, b) => a.start - b.start)) {
    const start = Math.max(cursor, Number(cut.start) || 0);
    const end = Math.min(totalDuration, Number(cut.end) || start);
    if (start > cursor) keep.push({ start: cursor, end: start });
    cursor = Math.max(cursor, end);
  }
  if (cursor < totalDuration) keep.push({ start: cursor, end: totalDuration });
  return keep.filter((item) => item.end - item.start > 0.01);
}

function remapWords(words, keep) {
  return (words || []).flatMap((word) => {
    const segment = keep.find((item) => word.start >= item.start && word.end <= item.end);
    if (!segment) return [];
    return [{ ...word, start: word.start - segment.start + keep.slice(0, keep.indexOf(segment)).reduce((sum, item) => sum + item.end - item.start, 0), end: word.end - segment.start + keep.slice(0, keep.indexOf(segment)).reduce((sum, item) => sum + item.end - item.start, 0) }];
  });
}

function wordsToSrt(words) {
  if (!words?.length) return '';
  const lines = [];
  let current = null;
  for (const word of words) {
    if (!current || word.start - current.end > 0.75 || subtitleLineWidth(current.text) >= SUBTITLE_MAX_LINE_CHARACTERS) {
      if (current) lines.push(current);
      current = { start: word.start, end: word.end, text: word.word };
    } else {
      current.end = word.end;
      current.text += /[\u4e00-\u9fff]/.test(current.text.at(-1) || '') ? word.word : ` ${word.word}`;
    }
  }
  if (current) lines.push(current);
  return lines.map((line, index) => `${index + 1}\n${timestamp(line.start)} --> ${timestamp(line.end)}\n${wrapSubtitleLines(line.text).join('\n')}`).join('\n\n') + '\n';
}

function timestamp(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  return `${String(Math.floor(ms / 3_600_000)).padStart(2, '0')}:${String(Math.floor(ms / 60_000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

export async function renderTalkingHead(task, input, project, { onProgress = async () => {} } = {}) {
  const config = ensureNativeMedia();
  const [source] = await (async () => {
    const ids = Array.isArray(input.videoAssetIds) ? input.videoAssetIds : [input.videoAssetId];
    const selected = ids.filter(Boolean);
    if (selected.length > 1) throw new ProviderError('VIDEO_ASSET_COUNT_INVALID', '口播去气口模板只接受一条视频素材', { status: 400 });
    const item = await findSource({ assetId: selected[0], explicit: input.videoSample, assets: project.assets, mimePrefix: 'video/', timeoutMs: config.timeoutMs });
    return item ? [item] : [];
  })();
  if (!source?.filePath) throw new ProviderError('VIDEO_ASSET_REQUIRED', '请先上传并选择口播视频素材', { status: 400 });
  await onProgress(14, '口播视频已读取');
  const totalDuration = await probeDuration(source.filePath, config);
  await onProgress(20, '视频时长已识别');
  const transcript = await transcribeWords(source.filePath, { language: input.language });
  await onProgress(38, '语音时间线已识别');
  const gapThreshold = boundedNumber(input.gapThreshold, 0.1, 0.05, 2);
  const gapPadding = boundedNumber(input.gapPadding, 0.02, 0, 0.5);
  const cuts = detectGaps(transcript.words, totalDuration, gapThreshold, gapPadding);
  const keep = cutsToKeep(cuts, totalDuration);
  const removedSeconds = Number(cuts.reduce((sum, cut) => sum + cut.duration, 0).toFixed(3));
  if (!keep.length) throw new ProviderError('VIDEO_NO_SPEECH', '未检测到可保留的语音片段');
  await onProgress(44, '气口剪辑方案已生成');
  const prepared = await prepareVideoOutput({ project, task, title: input.title, suffix: 'talking-head' });
  const workDir = await fs.mkdtemp(path.join(path.dirname(prepared.filePath), `talking-head-${task.id}-`));
  let subtitleFile = null;
  try {
    const parts = [];
    for (let index = 0; index < keep.length; index += 1) {
      const segmentPath = path.join(workDir, `segment-${index}.mp4`);
      await normalizeSegment({ source: source.filePath, destination: segmentPath, start: keep[index].start, duration: keep[index].end - keep[index].start, ratio: input.ratio || '9:16', config, crop: true, enhance: input.hdFilter !== false });
      parts.push(segmentPath);
      await onProgress(44 + Math.round(((index + 1) / keep.length) * 22), `已处理片段 ${index + 1}/${keep.length}`);
    }
    const subtitle = String(input.subtitleText || '').trim()
      ? createTextSrt(input.subtitleText, keep.reduce((sum, item) => sum + item.end - item.start, 0))
      : wordsToSrt(remapWords(transcript.words, keep));
    subtitleFile = await saveSubtitleFile({ project, task, title: input.title || '口播去气口', content: subtitle });
    await onProgress(70, '字幕文件已生成');
    const basePath = subtitleFile ? path.join(workDir, 'talking-head-base.mp4') : prepared.filePath;
    await concatSegments(parts, basePath, workDir, config);
    await onProgress(78, '口播片段已合并');
    if (subtitleFile) await burnSubtitles(basePath, subtitleFile.filePath, prepared.filePath, config);
    await onProgress(86, subtitleFile ? '字幕已合成到视频' : '视频合成完成');
    const info = await outputFileInfo(prepared.filePath);
    await onProgress(90, '成片文件已校验');
    return {
      provider: 'native-breathcut', model: transcript.language || null, externalTaskId: null,
      output: {
        ...prepared, sizeBytes: info.stat.size, durationSeconds: info.durationSeconds, sourceDurationSeconds: totalDuration, ratio: input.ratio || '9:16', sourceAssetId: source.assetId || null, sourceAssetIds: source.assetId ? [source.assetId] : [], segmentCount: parts.length, removedSeconds, gapCount: cuts.length, gapThreshold, gapPadding, subtitleStorageKey: subtitleFile?.storageKey || null, subtitleFilename: subtitleFile?.filename || null, subtitleText: String(input.subtitleText || '').trim(), template: 'talking-head', templateLabel: '口播去气口', algorithm: '词级停顿剪辑', editSummary: `检测 ${cuts.length} 处气口，自动缩短 ${removedSeconds.toFixed(1)} 秒`
      }
    };
  } catch (error) {
    await fs.rm(prepared.filePath, { force: true }).catch(() => {});
    if (subtitleFile) await fs.rm(subtitleFile.filePath, { force: true }).catch(() => {});
    throw error;
  } finally { await fs.rm(workDir, { recursive: true, force: true }).catch(() => {}); }
}
