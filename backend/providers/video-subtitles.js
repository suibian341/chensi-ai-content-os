/**
 * Burn subtitles onto a finished video.
 *
 * IMS renders the cut but has no equivalent of this project's subtitle engine, and
 * the look of the subtitles is part of the product, so the burn happens here after
 * the cloud render returns. This mirrors the private ffmpeg pipeline's own
 * subtitle step:
 *
 *   createTikTokAdaptiveSubtitle  ->  an ASS file  ->  burnSubtitles
 *
 * The editing algorithm is not involved: it already decided the cut, and this only
 * draws text on the result.
 */
import { createWriteStream, promises as fs } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { ProviderError } from '../lib/http.js';
import { commitPreparedFile, prepareGeneratedFile } from '../lib/storage.js';
import { burnSubtitles, createTextSrt } from '../video-engine/common.js';
import { createTikTokAdaptiveSubtitle } from '../video-engine/tiktok-subtitles.js';
import { getProviderConfig } from './config.js';
import { runCommand } from './media.js';

/**
 * Draw subtitles onto `sourceUrl` and store the result.
 *
 * Everything happens in `workDirectory`, and only the finished, subtitled file is
 * committed to storage — so a failure part-way through leaves no half-finished
 * object behind for the project to accumulate.
 *
 * @returns {Promise<{storedVideo: object, subtitle: object}>}
 */
export async function burnSubtitlesOnVideo({
  project, task, input, sourceUrl, durationSeconds, ratio, workDirectory, onProgress = async () => {},
}) {
  const config = getProviderConfig().media;
  const subtitleText = String(input.subtitleText || '').trim();
  const timedWords = Array.isArray(input.timedWords) ? input.timedWords : [];
  if (!subtitleText && !timedWords.length) {
    throw new ProviderError('VIDEO_SUBTITLE_INPUT_MISSING', '没有可用于生成字幕的口播文本', { status: 409 });
  }

  const sourcePath = path.join(workDirectory, 'rendered.mp4');
  await downloadTo(sourceUrl, sourcePath);
  const duration = Number(durationSeconds) > 0
    ? Number(durationSeconds)
    : await probeDurationSeconds(sourcePath, config);
  const canvasRatio = ratio || input.ratio || '9:16';

  // Prefer the measured word timings from the plan: they keep cue changes on the
  // speech instead of on character proportions.
  let content = null;
  let format = null;
  let generatedError = null;
  try {
    const meta = await createTikTokAdaptiveSubtitle({
      audioPath: sourcePath,
      text: subtitleText,
      durationSeconds: duration,
      language: input.language,
      ratio: canvasRatio,
      timedWords: timedWords.length ? timedWords : null,
    });
    content = meta.ass;
    format = 'ass';
  } catch (error) {
    generatedError = error?.message || '字幕生成失败';
    if (subtitleText) {
      content = createTextSrt(subtitleText, duration);
      format = 'srt';
    }
  }
  if (!content) {
    throw new ProviderError('VIDEO_SUBTITLE_FAILED', generatedError || '字幕生成失败', { status: 502 });
  }

  const title = input.title || project.name || 'video';
  const subtitlePrepared = await prepareGeneratedFile({
    userId: project.ownerId,
    projectId: project.id,
    taskId: `${task.id}-subtitles`,
    name: `${title}-subtitles.${format}`,
  });
  // The ASS branch keeps a BOM for Windows players that would otherwise guess a
  // system code page on Chinese text. The SRT fallback must stay BOM-free.
  const body = format === 'ass' ? `\ufeff${content}` : content;
  await fs.writeFile(subtitlePrepared.filePath, body, 'utf8');

  // Burn BEFORE committing anything: `commitPreparedFile` uploads and then removes
  // the file's temporary directory by default, so committing the subtitle first
  // deleted the file ffmpeg was about to read ("Unable to open ...-subtitles.ass").
  const burnedPath = path.join(workDirectory, 'rendered-subtitled.mp4');
  await onProgress(90, '正在把字幕烧录到成片');
  await burnSubtitles(sourcePath, subtitlePrepared.filePath, burnedPath, config);

  const prepared = await prepareGeneratedFile({
    userId: project.ownerId,
    projectId: project.id,
    taskId: task.id,
    name: `${title}-${input.template || 'vlog'}-ims.mp4`,
  });
  await fs.copyFile(burnedPath, prepared.filePath);

  const storedSubtitle = await commitPreparedFile(subtitlePrepared, {
    mimeType: format === 'ass' ? 'text/x-ass; charset=utf-8' : 'application/x-subrip; charset=utf-8',
  });
  const storedVideo = await commitPreparedFile(prepared, { mimeType: 'video/mp4' });

  return {
    storedVideo,
    subtitle: {
      storageKey: storedSubtitle.storageKey,
      filename: storedSubtitle.filename,
      format,
      burned: true,
      error: generatedError,
    },
  };
}

/** Stream a URL to a file. Video-sized payloads must never be buffered. */
async function downloadTo(url, destination) {
  if (!/^https?:\/\//i.test(String(url || ''))) {
    throw new ProviderError('VIDEO_SUBTITLE_SOURCE_INVALID', '成片地址不可用，无法烧录字幕', { status: 409 });
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(20 * 60_000) });
  if (!response.ok) {
    throw new ProviderError('VIDEO_SUBTITLE_SOURCE_INVALID', `成片下载失败：HTTP ${response.status}`, { status: 502 });
  }
  await pipeline(response.body, createWriteStream(destination, { flags: 'w' }));
}

async function probeDurationSeconds(filePath, config) {
  const { stdout } = await runCommand(config.ffprobePath, [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', filePath,
  ], {
    timeoutMs: Math.min(config.timeoutMs, 30_000),
    errorCode: 'MEDIA_PROBE_FAILED',
    errorMessage: '无法读取成片时长',
  });
  const duration = Number(String(stdout).trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new ProviderError('MEDIA_DURATION_INVALID', '成片时长无效，无法烧录字幕', { status: 502 });
  }
  return duration;
}
