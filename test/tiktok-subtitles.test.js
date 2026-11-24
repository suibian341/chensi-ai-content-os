import test from 'node:test';
import assert from 'node:assert/strict';
import { createTikTokAdaptiveSubtitle } from '../backend/video-engine/tiktok-subtitles.js';
import { createTextSrt, subtitleBurnFilter, subtitleLineWidth, wrapSubtitleLines } from '../backend/video-engine/common.js';
import { subtitleTextFromAudioAsset } from '../backend/video-engine/subtitle-source.js';

test('audio subtitle source reuses the complete related narration script', () => {
  const text = subtitleTextFromAudioAsset(
    { id: 'audio-1', description: '截断的素材说明' },
    { outputs: [
      { narrationAssetId: 'audio-1', speechScript: null },
      { narrationAssetId: 'audio-1', speechScript: '完整的数字人口播文案。' }
    ] }
  );
  assert.equal(text, '完整的数字人口播文案。');
});

test('TiTok subtitle bridge produces adaptive ASS cues for Chinese scripts', async () => {
  const result = await createTikTokAdaptiveSubtitle({
    text: '这是一段较长的中文数字人口播文案，用于验证自适应字幕时间轴。',
    durationSeconds: 5,
    language: 'zh-CN',
    ratio: '9:16',
  });

  assert.match(result.ass, /\[Script Info\]/);
  assert.match(result.ass, /\[Events\]/);
  assert.match(result.ass, /Dialogue: 0,/);
  assert.equal(result.canvas.width, 1080);
  assert.equal(result.canvas.height, 1920);
  assert.match(result.ass, /Style: Unified Subtitle,Noto Sans SC,59\.0,/);
  assert.match(result.ass, /WrapStyle: 2/);
  assert.match(result.ass, /,2,65,65,400,1/);
  assert.doesNotMatch(result.ass, /Microsoft YaHei|Montserrat/);
  assert.ok(result.cues.length >= 1);
  assert.ok(result.cues.every((cue) => cue.start_ms >= 0 && cue.end_ms <= 5_000 && cue.end_ms > cue.start_ms));
  assert.match(result.ass.replace(/\\N/g, ''), /这是一段较长/);
  assert.doesNotMatch(result.ass, /�/);
});

test('long precise Chinese subtitle cues are repartitioned within the 1080px safe width', async () => {
  const text = '产品不能只有一个模样我们提供3000款排插供你选择可根据品牌定位匹配合适的规格、功能和外观方向。';
  const result = await createTikTokAdaptiveSubtitle({
    text,
    durationSeconds: 6,
    language: 'zh-CN',
    ratio: '9:16',
    timedWords: [{ text: text.replace(/。$/, ''), start_ms: 0, end_ms: 5_800 }],
  });
  const displayLines = result.cues.flatMap((cue) => cue.current_text.split('\n'));
  assert.ok(result.cues.length > 1);
  assert.ok(displayLines.every((line) => subtitleLineWidth(line) <= 15), JSON.stringify(displayLines));
  assert.equal(result.cues.map((cue) => cue.current_text.replace(/\n/g, '')).join(''), text);
  assert.ok(result.cues.every((cue, index, cues) => cue.end_ms > cue.start_ms && (index === 0 || cue.start_ms >= cues[index - 1].end_ms)));
});

test('Chinese punctuation does not create a one-character orphan line', async () => {
  const result = await createTikTokAdaptiveSubtitle({
    text: '包装定制，工厂直接对接。',
    durationSeconds: 2,
    language: 'zh-CN',
    timedWords: [{ text: '包装定制工厂直接对接', start_ms: 0, end_ms: 1_900 }],
  });
  const lines = result.cues.flatMap((cue) => cue.current_text.split('\n'));
  assert.ok(lines.every((line) => [...line].filter((char) => /[\u3400-\u9fff]/.test(char)).length >= 2), JSON.stringify(lines));
  assert.doesNotMatch(result.cues.map((cue) => cue.current_text).join('\n'), /工\n厂/);
});

test('Chinese narration is split into sentence cues and can scale a matching teardown timeline', async () => {
  const result = await createTikTokAdaptiveSubtitle({
    text: '\u7b2c\u4e00\u53e5\u8bb2\u91cd\u70b9\u3002\u7b2c\u4e8c\u53e5\u7ed9\u65b9\u6cd5\uff01\u7b2c\u4e09\u53e5\u505a\u603b\u7ed3\uff1f',
    durationSeconds: 9,
    language: 'zh-CN',
    referenceTimeline: [
      { start: 0, end: 2, speech: '\u5f00\u5934' },
      { start: 2, end: 5, speech: '\u65b9\u6cd5' },
      { start: 5, end: 8, speech: '\u603b\u7ed3' }
    ]
  });
  assert.equal(result.cues.length, 3);
  assert.deepEqual(result.cues.map((cue) => cue.current_text), [
    '\u7b2c\u4e00\u53e5\u8bb2\u91cd\u70b9\u3002',
    '\u7b2c\u4e8c\u53e5\u7ed9\u65b9\u6cd5\uff01',
    '\u7b2c\u4e09\u53e5\u505a\u603b\u7ed3\uff1f'
  ]);
  assert.deepEqual(result.cues.map((cue) => [cue.start_ms, cue.end_ms]), [[0, 2250], [2250, 5625], [5625, 9000]]);
  assert.ok(result.cues.every((cue, index, cues) => cue.end_ms > cue.start_ms && (index === 0 || cue.start_ms >= cues[index - 1].end_ms)));
});

test('digital-human subtitle lead advances cues without creating invalid timestamps', async () => {
  const result = await createTikTokAdaptiveSubtitle({
    text: '\u7b2c\u4e00\u53e5\u3002\u7b2c\u4e8c\u53e5\u3002',
    durationSeconds: 6,
    language: 'zh-CN',
    subtitleOffsetMs: -120
  });
  assert.equal(result.cues[0].start_ms, 0);
  assert.ok(result.cues.every((cue, index, cues) => cue.end_ms > cue.start_ms && cue.end_ms <= 6_000 && (index === 0 || cue.start_ms >= cues[index - 1].end_ms)));
});

test('measured words align sentence changes to speech instead of character proportions', async () => {
  const result = await createTikTokAdaptiveSubtitle({
    text: '\u7532\u4e59\u4e19\u4e01\u3002\u620a\u5df1\u5e9a\u8f9b\u3002',
    durationSeconds: 4,
    language: 'zh-CN',
    referenceTimeline: [{ start: 0, end: 2 }, { start: 2, end: 4 }],
    timedWords: [
      { text: '\u7532\u4e59\u4e19\u4e01', start_ms: 0, end_ms: 800 },
      { text: '\u620a', start_ms: 2_000, end_ms: 2_200 },
      { text: '\u5df1', start_ms: 2_200, end_ms: 2_400 },
      { text: '\u5e9a', start_ms: 2_400, end_ms: 2_600 },
      { text: '\u8f9b', start_ms: 2_600, end_ms: 2_800 },
    ],
  });

  assert.deepEqual(result.cues.map((cue) => [cue.start_ms, cue.end_ms]), [[0, 800], [2_000, 2_800]]);
  assert.ok(result.cues.every((cue) => cue.word_timed === true));
});

test('multiple sentences inside one measured word block receive usable cue durations', async () => {
  const result = await createTikTokAdaptiveSubtitle({
    text: '第一句话说明产品。第二句话给出报价。',
    durationSeconds: 4,
    language: 'zh-CN',
    timedWords: [{ text: '第一句话说明产品第二句话给出报价', start_ms: 200, end_ms: 3_800 }],
  });
  assert.equal(result.cues.length, 2);
  assert.ok(result.cues.every((cue) => cue.end_ms - cue.start_ms > 1_000));
  assert.deepEqual(result.cues.map((cue) => [cue.start_ms, cue.end_ms]), [[200, 2_000], [2_000, 3_800]]);
});

test('TiTok subtitle bridge keeps English word-timed display cues and ratio canvas', async () => {
  const result = await createTikTokAdaptiveSubtitle({
    text: 'Hello this is a subtitle timing test for TiTok.',
    durationSeconds: 4,
    language: 'en',
    ratio: '16:9',
  });

  assert.equal(result.canvas.width, 1920);
  assert.equal(result.canvas.height, 1080);
  assert.ok(result.cues.some((cue) => cue.word_timed === true));
  assert.ok(result.cues.at(-1).end_ms <= 4_000);
  assert.ok(result.cues.flatMap((cue) => cue.current_text.split('\n')).every((line) => subtitleLineWidth(line) <= 15));
  assert.doesNotMatch(result.ass, /Montserrat|Microsoft YaHei/);
});

test('subtitle lines use the visual width of 15 Chinese characters in every language', async () => {
  const exact = '一二三四五六七八九十甲乙丙丁戊';
  const overflow = `${exact}己`;
  assert.equal(Array.from(exact).length, 15);
  assert.deepEqual(wrapSubtitleLines(exact), [exact]);
  assert.deepEqual(wrapSubtitleLines(overflow), [exact, '己']);

  const english = wrapSubtitleLines('Supercalifragilisticexpialidocious stays readable');
  assert.ok(english.some((line) => Array.from(line).length > 15), JSON.stringify(english));
  assert.ok(english.every((line) => subtitleLineWidth(line) <= 15), JSON.stringify(english));
  const adaptive = await createTikTokAdaptiveSubtitle({ text: overflow, durationSeconds: 2, language: 'zh-CN', ratio: '9:16' });
  assert.deepEqual(adaptive.cues.map((cue) => cue.current_text), [`${exact}\n己`]);

  const srt = createTextSrt('Supercalifragilisticexpialidocious stays readable', 3);
  const subtitleLines = srt.split(/\r?\n/).filter((line) => line && !/^\d+$/.test(line) && !line.includes('-->'));
  assert.ok(subtitleLines.every((line) => subtitleLineWidth(line) <= 15), JSON.stringify(subtitleLines));
  assert.match(subtitleBurnFilter('fallback.srt', { width: 720, height: 1280 }), /FontName=Noto Sans SC,FontSize=39/);
});
