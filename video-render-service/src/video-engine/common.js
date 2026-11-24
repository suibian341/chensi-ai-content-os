import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ProviderError } from '../lib/http.js';
import { prepareGeneratedFile } from '../lib/storage.js';
import { commandAvailable, getProviderConfig } from '../providers/config.js';
import { findSource, probeDuration, runCommand } from '../providers/media.js';

export const VIDEO_DIMENSIONS = {
  '9:16': [1080, 1920],
  '16:9': [1920, 1080],
  '1:1': [1080, 1080],
  '3:4': [1080, 1440]
};

export function requestedDuration(value, fallback = null) {
  const parsed = Number.parseFloat(String(value || '').replace(/s$/i, ''));
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 600) : fallback;
}

export function ensureNativeMedia() {
  const config = getProviderConfig().media;
  if (!config.enabled || !commandAvailable(config.ffmpegPath) || !commandAvailable(config.ffprobePath)) {
    throw new ProviderError('FFMPEG_UNAVAILABLE', '本地视频处理功能不可用，无法运行视频剪辑', { status: 503 });
  }
  return config;
}

export async function resolveVideoSources(input, project, { max = 12, exact = null } = {}) {
  const config = getProviderConfig().media;
  const ids = [...new Set([
    ...(Array.isArray(input.videoAssetIds) ? input.videoAssetIds : []),
    input.videoAssetId
  ].map((item) => String(item || '').trim()).filter(Boolean))];
  if (ids.length > max) throw new ProviderError('VIDEO_ASSET_LIMIT', `该模板单次最多选择 ${max} 条视频素材`, { status: 400 });
  const sources = ids.length
    ? await Promise.all(ids.map((assetId) => findSource({ assetId, assets: project.assets, mimePrefix: 'video/', timeoutMs: config.timeoutMs })))
    : [await findSource({ explicit: input.videoSample, assets: project.assets, mimePrefix: 'video/', timeoutMs: config.timeoutMs })].filter(Boolean);
  if (!sources.length) throw new ProviderError('VIDEO_ASSET_REQUIRED', '请先上传并选择真实视频素材', { status: 400 });
  if (exact !== null && sources.length !== exact) throw new ProviderError('VIDEO_ASSET_COUNT_INVALID', `该模板需要选择 ${exact} 条视频素材`, { status: 400 });
  if (sources.some((source) => !source.filePath)) throw new ProviderError('VIDEO_SOURCE_INVALID', '视频素材没有可处理的本地文件', { status: 400 });
  return sources;
}

export function allocateDurations(sourceDurations, targetDuration) {
  const availableTotal = sourceDurations.reduce((total, value) => total + value, 0);
  const target = Math.min(targetDuration || availableTotal, availableTotal, 600);
  const allocated = sourceDurations.map(() => 0);
  let remaining = target;
  let active = sourceDurations.map((_, index) => index);
  while (remaining > 0.001 && active.length) {
    const share = remaining / active.length;
    let consumed = 0;
    const next = [];
    for (const index of active) {
      const capacity = sourceDurations[index] - allocated[index];
      const amount = Math.min(share, capacity);
      allocated[index] += amount;
      consumed += amount;
      if (capacity - amount > 0.001) next.push(index);
    }
    if (consumed <= 0.001) break;
    remaining -= consumed;
    active = next;
  }
  return allocated;
}

export async function hasAudioStream(source, config) {
  const { stdout } = await runCommand(config.ffprobePath, [
    '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=index', '-of', 'csv=p=0', source
  ], { timeoutMs: 30_000, errorCode: 'MEDIA_PROBE_FAILED', errorMessage: '无法读取视频音轨信息' });
  return Boolean(stdout.trim());
}

export async function normalizeSegment({ source, destination, start = 0, duration, ratio = '9:16', config, crop = true, enhance = false, muteAudio = false, loop = false }) {
  const [width, height] = VIDEO_DIMENSIONS[ratio] || VIDEO_DIMENSIONS['9:16'];
  // `fit`/`setsar`/`fps`/`setpts` are structural, not cosmetic: they make every
  // segment the same size and frame rate so concat/xfade can join them. Removing
  // them breaks the transition pass, so they stay.
  const fit = crop
    ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
    : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`;
  // Cosmetic sharpening (eq/unsharp/cas) is opt-in via `enhance`. Measured on
  // production media it cost 3.7x the encode time (0.863x vs 3.16x realtime), so
  // callers default it off and pass `enhance: true` only when requested.
  const enhancement = enhance ? ',eq=contrast=1.04,unsharp=5:5:0.35:5:5:0,cas=strength=0.18' : '';
  const audio = !muteAudio && await hasAudioStream(source, config);
  const args = ['-hide_banner', '-nostdin', '-y'];
  if (loop) args.push('-stream_loop', '-1');
  if (start > 0) args.push('-ss', Number(start).toFixed(3));
  args.push('-i', source);
  if (!audio) args.push('-f', 'lavfi', '-t', Number(duration).toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo');
  args.push(
    '-t', Number(duration).toFixed(3), '-vf', `${fit},setsar=1,fps=30,setpts=PTS-STARTPTS${enhancement}`,
    '-map', '0:v:0', '-map', audio ? '0:a:0' : '1:a:0',
    // CRF stays fixed at 20 whether or not `enhance` is set. It used to be 20/22
    // depending on the flag, so toggling the cosmetic filters also silently
    // changed the bitrate (~12% smaller output). Keep quality independent of the
    // sharpening switch.
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', destination
  );
  await runCommand(config.ffmpegPath, args, {
    timeoutMs: config.timeoutMs,
    errorCode: 'VIDEO_SEGMENT_FAILED',
    errorMessage: '视频片段标准化失败，请检查素材格式'
  });
}

function concatLine(filePath) {
  return `file '${filePath.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
}

export async function concatSegments(segmentPaths, destination, workDir, config) {
  if (!segmentPaths.length) throw new ProviderError('VIDEO_SEGMENT_EMPTY', '剪辑计划没有可输出片段');
  if (segmentPaths.length === 1) {
    await fs.copyFile(segmentPaths[0], destination);
    return;
  }
  const concatPath = path.join(workDir, 'concat.txt');
  await fs.writeFile(concatPath, segmentPaths.map(concatLine).join('\n'), 'utf8');
  await runCommand(config.ffmpegPath, [
    '-hide_banner', '-nostdin', '-y', '-f', 'concat', '-safe', '0', '-i', concatPath,
    '-c', 'copy', '-movflags', '+faststart', destination
  ], { timeoutMs: config.timeoutMs, errorCode: 'VIDEO_CONCAT_FAILED', errorMessage: '视频片段拼接失败' });
}

const TRANSITION_FILTERS = {
  SLIDE_LEFT: 'slideleft',
  SLIDE_RIGHT: 'slideright',
  SLIDE_UP: 'slideup',
  SLIDE_DOWN: 'slidedown',
  WIPE_DOWN: 'wipedown',
  WIPE_UP: 'wipeup',
  WIPE_RIGHT: 'wiperight',
};

function filterSeconds(value) {
  return Math.max(0, Number(value) || 0).toFixed(3);
}

export async function concatSegmentsWithTransitions(segmentSpecs, destination, workDir, config) {
  if (!segmentSpecs.length) throw new ProviderError('VIDEO_SEGMENT_EMPTY', 'No video segments to render');
  const specs = await Promise.all(segmentSpecs.map(async (item) => {
    const filePath = typeof item === 'string' ? item : item.filePath;
    const suppliedDuration = Number(typeof item === 'string' ? 0 : item.durationSeconds);
    return {
      filePath,
      durationSeconds: suppliedDuration > 0 ? suppliedDuration : await probeDuration(filePath, config),
      transition: typeof item === 'string' ? 'CUT' : String(item.transition || 'CUT'),
      transitionDurationSeconds: Number(typeof item === 'string' ? 0 : item.transitionDurationSeconds) || 0,
    };
  }));
  if (specs.length === 1) {
    await fs.copyFile(specs[0].filePath, destination);
    return;
  }

  const frameSeconds = 1 / 30;
  const boundaries = specs.slice(1).map((incoming, index) => {
    const outgoing = specs[index];
    const filter = TRANSITION_FILTERS[incoming.transition];
    const durationSeconds = Math.min(
      incoming.transitionDurationSeconds,
      Math.max(0, outgoing.durationSeconds - frameSeconds),
      incoming.durationSeconds,
    );
    return {
      filter,
      durationSeconds: filter && durationSeconds >= frameSeconds * 2 ? durationSeconds : 0,
    };
  });
  if (!boundaries.some((item) => item.durationSeconds > 0)) {
    await concatSegments(specs.map((item) => item.filePath), destination, workDir, config);
    return;
  }

  const filters = [];
  const concatInputs = [];
  for (let index = 0; index < specs.length; index += 1) {
    const outgoingTransition = boundaries[index];
    const transitionDuration = outgoingTransition?.durationSeconds || 0;
    const contentEnd = specs[index].durationSeconds - transitionDuration;
    filters.push(
      `[${index}:v:0]trim=start=0:end=${filterSeconds(contentEnd)},setpts=PTS-STARTPTS,`
      + `fps=30,settb=AVTB,format=yuv420p[part${index}]`,
    );
    concatInputs.push(`[part${index}]`);
    if (!transitionDuration) continue;

    filters.push(
      `[${index}:v:0]trim=start=${filterSeconds(contentEnd)}:end=${filterSeconds(specs[index].durationSeconds)},`
      + `setpts=PTS-STARTPTS,fps=30,settb=AVTB,format=yuv420p[transition${index}out]`,
    );
    filters.push(
      `[${index + 1}:v:0]trim=end_frame=1,setpts=PTS-STARTPTS,fps=30,settb=AVTB,format=yuv420p,`
      + `tpad=stop_mode=clone:stop_duration=${filterSeconds(transitionDuration)},`
      + `trim=duration=${filterSeconds(transitionDuration)},setpts=PTS-STARTPTS[transition${index}in]`,
    );
    filters.push(
      `[transition${index}out][transition${index}in]xfade=transition=${outgoingTransition.filter}:`
      + `duration=${filterSeconds(transitionDuration)}:offset=0[transition${index}]`,
    );
    concatInputs.push(`[transition${index}]`);
  }
  filters.push(
    `${concatInputs.join('')}concat=n=${concatInputs.length}:v=1:a=0,`
    + 'fps=30,format=yuv420p[vout]',
  );

  const graphPath = path.join(workDir, 'transition-filter.txt');
  const graphText = filters.join(';\n');
  await fs.writeFile(graphPath, graphText, 'utf8');
  const args = ['-hide_banner', '-nostdin', '-y'];
  for (const spec of specs) args.push('-i', spec.filePath);
  args.push(
    // ffmpeg 9 移除了 -filter_complex_script，改为把滤镜图直接内联传入
    '-filter_complex', graphText,
    '-map', '[vout]', '-an',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', destination,
  );
  await runCommand(config.ffmpegPath, args, {
    timeoutMs: config.timeoutMs,
    errorCode: 'VIDEO_TRANSITION_FAILED',
    errorMessage: 'Unable to compose video transitions',
  });
}

export async function replaceAudioTrack(videoPath, audioPath, destination, duration, config) {
  await runCommand(config.ffmpegPath, [
    '-hide_banner', '-nostdin', '-y', '-i', videoPath, '-i', audioPath,
    '-t', Number(duration).toFixed(3), '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', destination
  ], { timeoutMs: config.timeoutMs, errorCode: 'VIDEO_AUDIO_MIX_FAILED', errorMessage: '配音轨合成失败，请检查音频格式' });
}

export async function mixBackgroundMusic(videoPath, musicPath, destination, volume, config) {
  const duration = await probeDuration(videoPath, config);
  const sourceHasAudio = await hasAudioStream(videoPath, config);
  const normalizedVolume = Math.max(0, Math.min(1, Number(volume) || 0));
  const fadeIn = Math.min(0.35, duration / 4);
  const fadeOut = Math.min(0.6, duration / 3);
  const fadeOutStart = Math.max(0, duration - fadeOut);
  const musicFilter = `[1:a:0]volume=${normalizedVolume.toFixed(3)},atrim=duration=${duration.toFixed(3)},`
    + `asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${fadeIn.toFixed(3)},`
    + `afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOut.toFixed(3)}[bgm]`;
  const filter = sourceHasAudio
    ? `${musicFilter};[0:a:0][bgm]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]`
    : `${musicFilter};[bgm]alimiter=limit=0.95[aout]`;
  await runCommand(config.ffmpegPath, [
    '-hide_banner', '-nostdin', '-y', '-i', videoPath, '-stream_loop', '-1', '-i', musicPath,
    '-filter_complex', filter, '-t', duration.toFixed(3),
    '-map', '0:v:0', '-map', '[aout]', '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart', destination,
  ], {
    timeoutMs: config.timeoutMs,
    errorCode: 'BACKGROUND_MUSIC_MIX_FAILED',
    errorMessage: 'Unable to mix background music into the rendered video',
  });
}

export function srtTimestamp(seconds) {
  const milliseconds = Math.max(0, Math.round(Number(seconds || 0) * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1000);
  const millis = milliseconds % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

export const SUBTITLE_MAX_LINE_CHARACTERS = 15;
const subtitleLineBreakPunctuation = new Set(Array.from('，。！？；：、,.!?;:)]}）】》」』'));
const subtitleGraphemeSegmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('und', { granularity: 'grapheme' })
  : null;

function subtitleGraphemes(value) {
  const text = String(value || '');
  return subtitleGraphemeSegmenter
    ? [...subtitleGraphemeSegmenter.segment(text)].map((item) => item.segment)
    : Array.from(text);
}

function subtitleGraphemeWidth(character) {
  const first = Array.from(String(character || ''))[0] || '';
  const codePoint = first.codePointAt(0) || 0;
  if (/^\s$/u.test(first)) return 0.34;
  if (codePoint >= 0x1f000 || /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6]/u.test(first)) return 1;
  if (/[MW@#%&]/u.test(first)) return 0.92;
  if (/\p{Lu}/u.test(first)) return 0.68;
  if (/\p{N}/u.test(first)) return 0.58;
  if (/\p{P}/u.test(first)) return 0.44;
  return 0.56;
}

export function subtitleLineWidth(value) {
  return subtitleGraphemes(value).reduce((sum, character) => sum + subtitleGraphemeWidth(character), 0);
}

export function wrapSubtitleLines(value, maxCharacters = SUBTITLE_MAX_LINE_CHARACTERS) {
  const limit = Math.max(1, Math.trunc(Number(maxCharacters) || SUBTITLE_MAX_LINE_CHARACTERS));
  let remaining = subtitleGraphemes(String(value || '').replace(/\s+/g, ' ').trim());
  const lines = [];
  while (remaining.length) {
    if (remaining.reduce((sum, character) => sum + subtitleGraphemeWidth(character), 0) <= limit) {
      lines.push(remaining.join('').trim());
      break;
    }
    let windowEnd = 0;
    let windowWidth = 0;
    for (const character of remaining) {
      const characterWidth = subtitleGraphemeWidth(character);
      if (windowEnd > 0 && windowWidth + characterWidth > limit) break;
      windowWidth += characterWidth;
      windowEnd += 1;
    }
    const window = remaining.slice(0, windowEnd);
    const minimumNaturalBreak = Math.max(4, limit / 2);
    const boundaries = [];
    let occupiedWidth = 0;
    window.forEach((character, index) => {
      const position = index + 1;
      const characterWidth = subtitleGraphemeWidth(character);
      occupiedWidth += characterWidth;
      if (/^\s+$/u.test(character) && occupiedWidth - characterWidth >= minimumNaturalBreak) boundaries.push([position - 1, position]);
      else if (subtitleLineBreakPunctuation.has(character.at(-1)) && occupiedWidth >= minimumNaturalBreak) boundaries.push([position, position]);
    });
    const [lineEnd, nextStart] = boundaries.at(-1) || [windowEnd, windowEnd];
    const line = remaining.slice(0, lineEnd).join('').trim();
    lines.push(line || remaining.slice(0, windowEnd).join('').trim());
    remaining = remaining.slice(line ? nextStart : windowEnd);
    while (remaining.length && /^\s+$/u.test(remaining[0])) remaining.shift();
  }
  return lines.filter(Boolean);
}

export function subtitleLineGroups(text, { maxCharacters = SUBTITLE_MAX_LINE_CHARACTERS, maxLines = 2 } = {}) {
  const sentences = String(text || '')
    .split(/\r?\n|(?<=[。！？!?；;.])\s*/u)
    .map((item) => item.trim())
    .filter(Boolean);
  const lines = sentences.flatMap((sentence) => wrapSubtitleLines(sentence, maxCharacters));
  const groupSize = Math.max(1, Math.trunc(Number(maxLines) || 2));
  return Array.from({ length: Math.ceil(lines.length / groupSize) }, (_, index) => lines.slice(index * groupSize, (index + 1) * groupSize));
}

export function createTextSrt(text, duration) {
  const groups = subtitleLineGroups(text).slice(0, 160);
  if (!groups.length) return '';
  const safeDuration = Number.isFinite(Number(duration)) && Number(duration) > 0 ? Number(duration) : groups.length * 0.8;
  const weights = groups.map((group) => Math.max(1, subtitleGraphemes(group.join('')).length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let consumedWeight = 0;
  return groups.map((group, index) => {
    const start = safeDuration * (consumedWeight / totalWeight);
    consumedWeight += weights[index];
    const end = index === groups.length - 1 ? safeDuration : safeDuration * (consumedWeight / totalWeight);
    return `${index + 1}\n${srtTimestamp(start)} --> ${srtTimestamp(Math.max(start + 0.5, end))}\n${group.join('\n')}`;
  }).join('\n\n') + '\n';
}

export async function saveSubtitleFile({ project, task, title, content }) {
  if (!content) return null;
  const prepared = await prepareGeneratedFile({ projectId: project.id, taskId: `${task.id}-subtitles`, name: `${title || project.name || 'video'}-subtitles.srt` });
  // BOM makes the UTF-8 contract explicit for Windows players, NLEs and
  // spreadsheet-like previewers that otherwise guess the system code page.
  await fs.writeFile(prepared.filePath, `\ufeff${content}`, 'utf8');
  return prepared;
}

function subtitleFilterPath(filePath) {
  // FFmpeg's filter parser treats the Windows drive colon as a separator.
  // Forward slashes plus an escaped colon work on Windows and POSIX builds.
  return String(filePath || '').replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

export function subtitleBurnFilter(subtitlePath, { width = 1080, height = 1920 } = {}) {
  const subtitle = subtitleFilterPath(subtitlePath);
  const base = `subtitles=filename='${subtitle}':charenc=UTF-8`;
  if (path.extname(String(subtitlePath || '')).toLowerCase() === '.ass') return base;
  const safeWidth = Math.max(1, Number(width) || 1080);
  const safeHeight = Math.max(1, Number(height) || 1920);
  const margin = Math.max(24, Math.round(safeWidth * 0.06));
  const outline = Math.max(2, Math.round(safeWidth / 270));
  const fontSize = Math.max(16, Math.min(88, Math.floor((safeWidth - margin * 2 - outline * 4) / (SUBTITLE_MAX_LINE_CHARACTERS * 1.04))));
  const marginBottom = Math.max(48, Math.min(Math.floor(safeHeight / 2), Math.round(safeHeight * 400 / 1920)));
  return `${base}:force_style='FontName=Noto Sans SC,FontSize=${fontSize},PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=${outline},Shadow=0,Alignment=2,MarginL=${margin},MarginR=${margin},MarginV=${marginBottom}'`;
}

export async function burnSubtitles(videoPath, subtitlePath, destination, config) {
  if (!subtitlePath) {
    await fs.copyFile(videoPath, destination);
    return;
  }
  let dimensions = {};
  if (path.extname(String(subtitlePath || '')).toLowerCase() !== '.ass') {
    try {
      const { stdout } = await runCommand(config.ffprobePath, [
        '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', videoPath
      ], { timeoutMs: 30_000, errorCode: 'MEDIA_PROBE_FAILED', errorMessage: '无法读取视频尺寸' });
      const [width, height] = stdout.trim().split(',').map(Number);
      if (width > 0 && height > 0) dimensions = { width, height };
    } catch {
      // The conservative 1080x1920 fallback still keeps 15 full-width glyphs inside frame.
    }
  }
  const filter = subtitleBurnFilter(subtitlePath, dimensions);
  await runCommand(config.ffmpegPath, [
    '-hide_banner', '-nostdin', '-y', '-i', videoPath,
    '-vf', filter, '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', destination,
  ], { timeoutMs: config.timeoutMs, errorCode: 'VIDEO_SUBTITLE_BURN_FAILED', errorMessage: '字幕烧录失败，请检查本机中文字体和视频处理配置' });
}

export async function prepareVideoOutput({ project, task, title, suffix }) {
  return prepareGeneratedFile({ projectId: project.id, taskId: task.id, name: `${title || project.name || 'video'}-${suffix}.mp4` });
}

export async function outputFileInfo(filePath) {
  const config = getProviderConfig().media;
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size <= 0) throw new ProviderError('VIDEO_RENDER_EMPTY', '视频生成结果为空');
  return { stat, durationSeconds: Math.round((await probeDuration(filePath, config)) * 10) / 10 };
}
