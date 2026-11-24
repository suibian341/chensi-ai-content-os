import { ProviderError } from '../lib/http.js';
import { commandAvailable, getProviderConfig } from './config.js';
import { probeDuration, runCommand } from './media.js';

const round1 = (value) => Math.round(Number(value) * 10) / 10;

function detectSilences(stderr) {
  const silences = [];
  let pendingStart = null;
  for (const line of stderr.split(/\r?\n/)) {
    const startMatch = line.match(/silence_start:\s*([0-9.]+)/);
    if (startMatch) {
      pendingStart = Number(startMatch[1]);
      continue;
    }
    const endMatch = line.match(/silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/);
    if (endMatch && pendingStart !== null) {
      const end = Number(endMatch[1]);
      const duration = Number(endMatch[2]);
      if (Number.isFinite(end) && Number.isFinite(duration) && end > pendingStart) {
        silences.push({ start: pendingStart, end, duration });
      }
      pendingStart = null;
    }
  }
  return silences.sort((left, right) => left.start - right.start);
}

function detectSceneChanges(stderr, duration) {
  const boundaries = [0];
  for (const line of stderr.split(/\r?\n/)) {
    const match = line.match(/showinfo.*?pts_time:([0-9.]+)/);
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > 0.1 && value < duration - 0.1 && value - boundaries.at(-1) >= 0.25) boundaries.push(value);
  }
  boundaries.push(duration);
  return boundaries.slice(0, 82).map(round1).filter((value, index, values) => index === 0 || value > values[index - 1]);
}

function buildShots(boundaries) {
  const shots = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    if (end <= start) continue;
    shots.push({ index: index + 1, start, end, duration: round1(end - start) });
  }
  return shots;
}

function buildCutPlan({ silences, sceneBoundaries, duration, source, keyword, ratio, options }) {
  const startPad = Number(options.startPad ?? 0.08);
  const endPad = Number(options.endPad ?? 0.08);
  const minCut = Number(options.minCut ?? 0.25);
  const minKeep = Number(options.minKeep ?? 0.08);
  const totalEnd = round1(duration);
  const cutGaps = [];

  for (const silence of silences) {
    let cutStart = round1(silence.start + startPad);
    let cutEnd = round1(silence.end - endPad);
    if (silence.start <= 0.05) cutStart = 0;
    if (totalEnd - silence.end <= 0.05) cutEnd = totalEnd;
    if (cutEnd - cutStart >= minCut) {
      cutGaps.push({
        type: silence.duration >= 1.5 ? '停顿' : '气口',
        start: cutStart,
        end: cutEnd,
        duration: round1(cutEnd - cutStart),
        raw_start: round1(silence.start),
        raw_end: round1(silence.end),
        raw_duration: round1(silence.duration)
      });
    }
  }

  const merged = [];
  for (const gap of cutGaps.sort((left, right) => left.start - right.start)) {
    const last = merged.at(-1);
    if (last && gap.start <= last.end) {
      last.end = Math.max(last.end, gap.end);
      last.duration = round1(last.end - last.start);
      last.raw_end = Math.max(last.raw_end, gap.raw_end);
    } else {
      merged.push({ ...gap });
    }
  }

  const keepSegments = [];
  let cursor = 0;
  for (const gap of merged) {
    if (gap.start - cursor >= minKeep) {
      keepSegments.push({ start: round1(cursor), end: round1(gap.start), duration: round1(gap.start - cursor) });
    }
    cursor = Math.max(cursor, gap.end);
  }
  if (totalEnd - cursor >= minKeep) {
    keepSegments.push({ start: round1(cursor), end: totalEnd, duration: round1(totalEnd - cursor) });
  }

  return {
    mode: 'project_ffmpeg_silencedetect',
    analysisVersion: 'silence-and-scene-v1',
    source,
    duration: totalEnd,
    params: {
      noise_db: Number(options.noiseDb ?? -30),
      min_silence: Number(options.minSilence ?? 0.18),
      start_pad: startPad,
      end_pad: endPad,
      min_cut: minCut,
      min_keep: minKeep,
      scene_threshold: Number(options.sceneThreshold ?? 0.3)
    },
    raw_silences: silences.map((item) => ({ start: round1(item.start), end: round1(item.end), duration: round1(item.duration) })),
    breath_gaps: merged,
    scene_changes: sceneBoundaries.slice(1, -1),
    shots: buildShots(sceneBoundaries),
    keep_segments: keepSegments,
    trim_tasks: keepSegments.map((segment, index) => ({
      segment: index + 1,
      source,
      start_time: segment.start,
      end_time: segment.end,
      keyword: `${keyword || '口播素材'} 去气口段${index + 1}`,
      ratio: ratio || '9:16'
    })),
    summary: `检测到 ${merged.length} 个可裁气口、${Math.max(0, sceneBoundaries.length - 2)} 个镜头变化，生成 ${keepSegments.length} 个保留片段`
  };
}

export async function analyzeWithCutApi(input) {
  const config = getProviderConfig().media;
  if (!config.enabled || !commandAvailable(config.ffmpegPath) || !commandAvailable(config.ffprobePath)) {
    throw new ProviderError('FFMPEG_UNAVAILABLE', '本地视频处理功能不可用，无法执行气口分析', { status: 503 });
  }
  const source = String(input.filePath || input.url || '').trim();
  if (!source) throw new ProviderError('BENCHMARK_MEDIA_REQUIRED', '需要上传视频文件或提供可直接访问的视频文件地址');
  const duration = await probeDuration(source, config);
  const options = {
    noiseDb: Number(input.noiseDb ?? -30),
    minSilence: Number(input.minSilence ?? 0.18),
    startPad: Number(input.startPad ?? 0.08),
    endPad: Number(input.endPad ?? 0.08),
    minCut: Number(input.minCut ?? 0.25),
    minKeep: Number(input.minKeep ?? 0.08),
    sceneThreshold: Math.min(1, Math.max(0.01, Number(input.sceneThreshold ?? 0.3)))
  };
  const filter = `silencedetect=noise=${options.noiseDb}dB:d=${options.minSilence}`;
  const { stderr } = await runCommand(config.ffmpegPath, [
    '-hide_banner', '-nostats', '-i', source, '-af', filter, '-f', 'null', '-'
  ], {
    timeoutMs: config.timeoutMs,
    errorCode: 'SILENCE_DETECTION_FAILED',
    errorMessage: '气口分析失败，请确认输入是可访问的视频文件'
  });
  const sceneFilter = `select='gt(scene,${options.sceneThreshold})',showinfo`;
  const sceneResult = await runCommand(config.ffmpegPath, [
    '-hide_banner', '-nostats', '-i', source, '-vf', sceneFilter, '-an', '-f', 'null', '-'
  ], {
    timeoutMs: config.timeoutMs,
    errorCode: 'SCENE_DETECTION_FAILED',
    errorMessage: '镜头检测失败，请确认输入是可读取的视频文件'
  });
  const sceneBoundaries = detectSceneChanges(sceneResult.stderr, duration);
  const data = buildCutPlan({
    silences: detectSilences(stderr),
    sceneBoundaries,
    duration,
    source: input.url || input.assetId || 'uploaded-file',
    keyword: input.keyword,
    ratio: input.ratio,
    options
  });
  return { available: true, data, warning: null };
}
