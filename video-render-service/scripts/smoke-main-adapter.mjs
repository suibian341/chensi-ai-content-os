import path from 'node:path';
import { promises as fs } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const serviceUrl = String(process.env.VIDEO_RENDER_SMOKE_URL || '').trim();
const serviceKey = String(process.env.VIDEO_RENDER_SMOKE_API_KEY || '').trim();
const mainRoot = path.resolve(process.env.VIDEO_RENDER_MAIN_ROOT || path.join(import.meta.dirname, '..', '..', 'chensi-ai-content-os'));
const requestedTemplates = String(process.env.VIDEO_RENDER_SMOKE_TEMPLATES || 'vlog,talking-head,industry-viral')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

if (!serviceUrl || !serviceKey) throw new Error('VIDEO_RENDER_SMOKE_URL and VIDEO_RENDER_SMOKE_API_KEY are required');

process.env.IP_AGENT_SKIP_PROJECT_ENV = '1';
process.env.IP_AGENT_VIDEO_RENDER_SERVICE_URL = serviceUrl;
process.env.IP_AGENT_VIDEO_RENDER_SERVICE_API_KEY = serviceKey;
process.env.IP_AGENT_VIDEO_RENDER_SERVICE_TIMEOUT_MS ||= '2700000';
process.env.IP_AGENT_VIDEO_RENDER_SERVICE_POLL_INTERVAL_MS ||= '500';

const store = JSON.parse(await fs.readFile(path.join(mainRoot, 'runtime-data', 'store.json'), 'utf8'));
const sourceProject = store.projects.find((item) => item.name === '12312' || item.id === 'p_mtlbnv8w5obd3');
if (!sourceProject) throw new Error('Project 12312 is unavailable');

const byId = new Map(sourceProject.assets.map((asset) => [asset.id, asset]));
const speechAssetId = 'a_mtm922fqqtw7c';
const digitalHumanAssetId = 'a_mtlcaebc19tl6';
const brollIds = [
  'a_mtlcivg3v22ya',
  'a_mtlciz2v3rd7y',
  'a_mtlciyi1kz86j',
  'a_mtlcizddnjapr',
];
const required = [speechAssetId, digitalHumanAssetId, ...brollIds];
const missing = required.filter((id) => !byId.has(id));
if (missing.length) throw new Error(`Smoke-test assets are missing: ${missing.join(', ')}`);

const adapterUrl = pathToFileURL(path.join(mainRoot, 'backend', 'providers', 'remote-video.js')).href;
const { renderRemoteVideo } = await import(adapterUrl);
const smokeId = Date.now().toString(36);

function probeDuration(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', filePath,
    ], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve(Number(stdout.trim())) : reject(new Error(stderr || 'ffprobe failed')));
  });
}

function projectWithAssets(ids) {
  return {
    ...sourceProject,
    assets: ids.map((id) => byId.get(id)),
    outputs: sourceProject.outputs || [],
  };
}

const digitalOutput = (sourceProject.outputs || []).find((item) => item.id === byId.get(digitalHumanAssetId).sourceOutputId)
  || (sourceProject.outputs || []).find((item) => item.template === 'digital-human');
const transcriptWords = (digitalOutput?.subtitleCues || []).map((cue) => ({
  word: cue.current_text || cue.text || '',
  start: Number(cue.start_ms || 0) / 1000,
  end: Number(cue.end_ms || 0) / 1000,
})).filter((item) => item.word && item.end > item.start);

const cases = {
  vlog: {
    project: projectWithAssets([digitalHumanAssetId, ...brollIds]),
    input: {
      template: 'vlog',
      videoAssetIds: [digitalHumanAssetId],
      title: 'private-service-vlog-smoke',
      ratio: '9:16',
      subtitleText: digitalOutput?.subtitleText || '',
      transcriptWords,
      subtitleEmphasis: true,
      materialStartSeconds: 6.5,
      sourceTailSeconds: 6.5,
      matchSeed: `private-smoke-${smokeId}`,
    },
  },
  'talking-head': {
    project: projectWithAssets([speechAssetId]),
    input: {
      template: 'talking-head',
      videoAssetIds: [speechAssetId],
      title: 'private-service-talking-head-smoke',
      ratio: '9:16',
      language: 'zh',
      gapThreshold: 0.1,
      gapPadding: 0.02,
    },
  },
  'industry-viral': {
    project: projectWithAssets([speechAssetId]),
    input: {
      template: 'industry-viral',
      videoAssetIds: [speechAssetId],
      title: 'private-service-industry-smoke',
      ratio: '9:16',
      language: 'zh',
      industry: 'manufacturing',
      scoreThreshold: 0.7,
      maxHighlights: 5,
    },
  },
};

const report = [];
for (const template of requestedTemplates) {
  const current = cases[template];
  if (!current) throw new Error(`Unsupported smoke template: ${template}`);
  const progress = [];
  const result = await renderRemoteVideo(
    { id: `smoke_${template.replace(/[^a-z]/g, '_')}_${smokeId}`, userId: 'private-render-smoke-user' },
    current.input,
    current.project,
    {
      onExternalTaskId: async (jobId) => progress.push({ jobId }),
      onProgress: async (value, stage) => {
        progress.push({ value, stage });
        process.stdout.write(`[${template}] ${String(value).padStart(3)}% ${stage}\n`);
      },
    },
  );
  const durationSeconds = await probeDuration(result.output.filePath);
  const subtitleReady = result.output.subtitleStorageKey
    ? Boolean((await fs.stat(path.resolve(mainRoot, 'backend', 'storage', 'assets', ...result.output.subtitleStorageKey.split('/')))).size)
    : false;
  if (!(durationSeconds > 0) || !(result.output.sizeBytes > 0)) throw new Error(`${template} returned an empty video`);
  if (template === 'vlog' && !result.output.transitions?.some((item) => Number(item.duration) > 0)) {
    throw new Error('Vlog smoke output did not report a real transition');
  }
  if (!subtitleReady) throw new Error(`${template} did not return a subtitle file`);
  report.push({
    template,
    provider: result.provider,
    externalTaskId: result.externalTaskId,
    filePath: result.output.filePath,
    subtitleStorageKey: result.output.subtitleStorageKey,
    sizeBytes: result.output.sizeBytes,
    durationSeconds,
    segmentCount: result.output.segmentCount,
    transitionCount: (result.output.transitions || []).filter((item) => Number(item.duration) > 0).length,
    progressEvents: progress.filter((item) => item.value !== undefined).length,
  });
}

await fs.mkdir(path.join(import.meta.dirname, '..', 'runtime-data'), { recursive: true });
const reportPath = path.join(import.meta.dirname, '..', 'runtime-data', 'smoke-report.json');
await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({ ok: true, reportPath, report }, null, 2));
