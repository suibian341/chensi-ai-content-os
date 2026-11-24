import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeWithCutApi } from '../backend/providers/cut.js';
import { commandAvailable } from '../backend/providers/config.js';
import { findSource, probeDuration, runCommand } from '../backend/providers/media.js';
import { saveAssetFile } from '../backend/lib/storage.js';
import { burnSubtitles, concatSegmentsWithTransitions, createTextAss } from '../backend/video-engine/common.js';

const hasMediaTools = commandAvailable('ffmpeg') && commandAvailable('ffprobe');

test('project media providers analyze a local file and select stored audio', { skip: !hasMediaTools }, async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'domestic-ip-media-'));
  const previousRoot = process.env.IP_AGENT_STORAGE_ROOT;
  process.env.IP_AGENT_STORAGE_ROOT = path.join(temp, 'storage');
  t.after(async () => {
    previousRoot === undefined ? delete process.env.IP_AGENT_STORAGE_ROOT : process.env.IP_AGENT_STORAGE_ROOT = previousRoot;
    await fs.rm(temp, { recursive: true, force: true });
  });

  const source = path.join(temp, 'source.mp4');
  await runCommand('ffmpeg', [
    '-hide_banner', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=1.2',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-shortest',
    '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', '-y', source
  ], { timeoutMs: 30_000 });

  const cut = await analyzeWithCutApi({ filePath: source, keyword: '测试口播', ratio: '9:16' });
  assert.equal(cut.available, true);
  assert.equal(cut.data.mode, 'project_ffmpeg_silencedetect');
  assert.ok(cut.data.duration > 0);

  const firstAudio = await saveAssetFile({ projectId: 'p_real', assetId: 'audio_first', name: 'first.mp3', data: Buffer.from('first').toString('base64') });
  const selectedAudio = await saveAssetFile({ projectId: 'p_real', assetId: 'audio_selected', name: 'selected.mp3', data: Buffer.from('selected').toString('base64') });
  const chosen = await findSource({
    assetId: 'audio_selected',
    assets: [
      { id: 'audio_first', name: 'first.mp3', mimeType: 'audio/mpeg', ...firstAudio },
      { id: 'audio_selected', name: 'selected.mp3', mimeType: 'audio/mpeg', ...selectedAudio }
    ],
    mimePrefix: 'audio/',
    timeoutMs: 1_000
  });
  assert.equal(chosen.assetId, 'audio_selected');
  assert.equal(chosen.data.toString(), 'selected');
});

test('timeline transition renderer emits visible 240ms motion without shortening output', { skip: !hasMediaTools }, async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'domestic-ip-transition-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const black = path.join(temp, 'black.mp4');
  const red = path.join(temp, 'red.mp4');
  const output = path.join(temp, 'transition.mp4');
  for (const [filePath, color] of [[black, 'black'], [red, 'red']]) {
    await runCommand('ffmpeg', [
      '-hide_banner', '-f', 'lavfi', '-i', `color=c=${color}:s=320x240:r=30:d=1.2`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', filePath,
    ], { timeoutMs: 30_000 });
  }
  const mediaConfig = { ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', timeoutMs: 30_000 };
  await concatSegmentsWithTransitions([
    { filePath: black, durationSeconds: 1.2, transition: 'CUT', transitionDurationSeconds: 0 },
    { filePath: red, durationSeconds: 1.2, transition: 'SLIDE_LEFT', transitionDurationSeconds: 0.24 },
  ], output, temp, mediaConfig);
  assert.ok(Math.abs(await probeDuration(output, mediaConfig) - 2.4) <= 0.05);

  const samplePixel = async (timestamp, name) => {
    const imagePath = path.join(temp, `${name}.ppm`);
    await runCommand('ffmpeg', [
      '-hide_banner', '-i', output, '-ss', String(timestamp), '-frames:v', '1',
      '-vf', 'scale=1:1', '-f', 'image2', '-vcodec', 'ppm', '-y', imagePath,
    ], { timeoutMs: 30_000 });
    return [...(await fs.readFile(imagePath)).subarray(-3)];
  };
  const before = await samplePixel(0.8, 'before');
  const during = await samplePixel(1.08, 'during');
  const after = await samplePixel(1.4, 'after');
  assert.ok(before.every((channel) => channel < 30), `pre-transition frame should be black: ${before}`);
  assert.ok(during[0] > 40 && during[0] < 220, `transition frame should mix black and red: ${during}`);
  assert.ok(after[0] > 200 && after[1] < 30 && after[2] < 30, `post-transition frame should be red: ${after}`);
});

test('ASS burn preserves the embedded 88px subtitle style', { skip: !hasMediaTools }, async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'domestic-ip-subtitle-size-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'source.mp4');
  const subtitle = path.join(temp, 'subtitle.ass');
  const output = path.join(temp, 'output.mp4');
  const frame = path.join(temp, 'frame.gray');
  await runCommand('ffmpeg', [
    '-hide_banner', '-f', 'lavfi', '-i', 'color=c=black:s=540x960:r=30:d=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', source,
  ], { timeoutMs: 30_000 });
  await fs.writeFile(subtitle, [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Large,Microsoft YaHei,88,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,4,0,2,48,48,400,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:00.00,0:00:01.00,Large,,0,0,0,,SUBTITLE SIZE',
    '',
  ].join('\n'), 'utf8');
  const mediaConfig = { ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', timeoutMs: 30_000 };
  await burnSubtitles(source, subtitle, output, mediaConfig);
  await runCommand('ffmpeg', [
    '-hide_banner', '-ss', '0.5', '-i', output, '-frames:v', '1',
    '-vf', 'format=gray', '-f', 'rawvideo', '-pix_fmt', 'gray', '-y', frame,
  ], { timeoutMs: 30_000 });
  const pixels = await fs.readFile(frame);
  const activeRows = [];
  for (let y = 0; y < 960; y += 1) {
    if (pixels.subarray(y * 540, (y + 1) * 540).some((value) => value > 80)) activeRows.push(y);
  }
  assert.ok(activeRows.length >= 25, `88px ASS subtitle rendered too small: ${activeRows.length}px high`);
});

test('digital-human fallback ASS stays inside the lower safe area', () => {
  const ass = createTextAss('来吃新疆菜火锅，如果一坐下就问我老板什么最招牌', 4, { ratio: '9:16' });
  assert.match(ass, /PlayResX: 1080/);
  assert.match(ass, /PlayResY: 1920/);
  assert.match(ass, /Style: Unified Subtitle,Noto Sans SC,60,[^\n]+,2,65,65,384,1/);
  assert.match(ass, /Dialogue: 0,0:00:00\.00,[^\n]+来吃新疆菜火锅/);
  assert.doesNotMatch(ass, /Alignment=8|\\an8/);
});
