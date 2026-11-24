import test from 'node:test';
import assert from 'node:assert/strict';
import { createTikTokAdaptiveSubtitle } from '../src/video-engine/tiktok-subtitles.js';
import { createTextSrt, subtitleBurnFilter, subtitleLineWidth, wrapSubtitleLines } from '../src/video-engine/common.js';

test('render service applies the unified 15-character subtitle layout', async () => {
  const exact = '一二三四五六七八九十甲乙丙丁戊';
  assert.deepEqual(wrapSubtitleLines(exact), [exact]);
  assert.deepEqual(wrapSubtitleLines(`${exact}己`), [exact, '己']);

  const result = await createTikTokAdaptiveSubtitle({
    text: 'Supercalifragilisticexpialidocious stays readable across the frame',
    durationSeconds: 4,
    language: 'en',
    ratio: '9:16',
  });
  const renderedLines = result.cues.flatMap((cue) => cue.current_text.split('\n'));
  assert.ok(renderedLines.some((line) => Array.from(line).length > 15));
  assert.ok(renderedLines.every((line) => subtitleLineWidth(line) <= 15));
  assert.match(result.ass, /Style: Unified Subtitle,Noto Sans SC,59\.0,/);
  assert.match(result.ass, /WrapStyle: 2/);
  assert.doesNotMatch(result.ass, /Montserrat|Microsoft YaHei/);

  const srt = createTextSrt('Supercalifragilisticexpialidocious stays readable', 3);
  const lines = srt.split(/\r?\n/).filter((line) => line && !/^\d+$/.test(line) && !line.includes('-->'));
  assert.ok(lines.every((line) => subtitleLineWidth(line) <= 15));
  assert.match(subtitleBurnFilter('fallback.srt', { width: 720, height: 1280 }), /FontName=Noto Sans SC,FontSize=39/);
});
