import { ProviderError } from '../lib/http.js';
import { renderTalkingHead } from './breathcut.js';
import { renderVlog } from './tiktok-vlog.js';
import { renderIndustryViral } from './autoclip.js';
import { renderVlogPlan } from './vlog-plan.js';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolveStorageKey } from '../lib/storage.js';
import { getProviderConfig } from '../providers/config.js';
import { mixBackgroundMusic } from './common.js';

export const TEMPLATE_DISPATCH = Object.freeze({
  'talking-head': renderTalkingHead,
  vlog: renderVlog,
  'industry-viral': renderIndustryViral,
  // Plan-only variant: computes the auto-edit decisions and returns an IMS
  // Timeline instead of rendering, so a caller that can reach IMS directly
  // (the main application) executes it there. Same algorithm, no local encode.
  'vlog-plan': renderVlogPlan,
});

export function templateRenderer(template) {
  return TEMPLATE_DISPATCH[String(template || '').trim()] || null;
}

export async function renderVideo(task, input = {}, project, options = {}) {
  const requestedTemplate = String(input.template || 'vlog').trim();
  const renderer = templateRenderer(requestedTemplate);
  if (!renderer) throw new ProviderError('VIDEO_TEMPLATE_UNAVAILABLE', `暂不支持视频模板：${requestedTemplate}`, { status: 400 });
  const result = await renderer(task, { ...input, template: requestedTemplate }, project, options);
  // Plan-only results describe work for another renderer; they have no file, so
  // the background-music and provider-naming steps below do not apply.
  if (result?.planOnly) return result;
  if (input.backgroundMusicPath) {
    const outputPath = resolveStorageKey(result?.output?.storageKey);
    const temporary = `${outputPath}.${randomUUID()}.background-music.mp4`;
    await options.onProgress?.(93, 'Mixing background music');
    try {
      await mixBackgroundMusic(
        outputPath,
        input.backgroundMusicPath,
        temporary,
        input.backgroundMusicVolume,
        getProviderConfig().media,
      );
      await fs.copyFile(temporary, outputPath);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
    result.output.backgroundMusicId = input.backgroundMusicId;
    result.output.backgroundMusicName = input.backgroundMusicName;
    result.output.backgroundMusicVolume = input.backgroundMusicVolume;
    await options.onProgress?.(95, 'Background music mixed');
  }
  if (!input.template && result?.provider === 'native-tiktok-auto-edit') result.provider = 'project-ffmpeg';
  return result;
}
