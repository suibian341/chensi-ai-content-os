/**
 * Word timings for the narration: looked up only, never computed here.
 *
 * Measured, and the reason this module is deliberately passive:
 *
 *   - the render service transcribes the main video in 36 s using 8 vCPU;
 *   - this host has 2 vCPU and 1.87 GB and must keep serving the API and the web UI;
 *   - running the same recognition here took 74.5 s once and then failed outright
 *     (`VIDEO_TRANSCRIPTION_FAILED`), so it is not a dependable place to do it.
 *
 * So nothing here starts a recognition. When word timings already exist — because some
 * earlier step produced them, or a caller supplied them — they are reused and the
 * render service skips its own transcription. When they do not, the request simply
 * carries none and the render service does what it has always done.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { signedReadUrl } from '../lib/storage.js';

const MAX_ENTRIES = 500;

/** Ledger location: the application's own data directory, writable by the service. */
function cacheFile() {
  const configured = String(process.env.IP_AGENT_TRANSCRIPT_CACHE_PATH || '').trim();
  if (configured) return path.resolve(configured);
  const dataRoot = String(process.env.IP_AGENT_DATA_DIR || '').trim();
  return path.join(dataRoot ? path.resolve(dataRoot) : path.join(os.tmpdir(), 'chensi-runtime'), 'transcript-cache.json');
}

async function loadLedger() {
  try {
    const parsed = JSON.parse(await fs.readFile(cacheFile(), 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.entries ? parsed : { entries: {} };
  } catch {
    return { entries: {} };
  }
}

async function saveLedger(ledger) {
  const file = cacheFile();
  const entries = Object.entries(ledger.entries || {});
  const bounded = entries.length > MAX_ENTRIES
    ? Object.fromEntries(entries.sort((a, b) => (b[1].usedAt || 0) - (a[1].usedAt || 0)).slice(0, MAX_ENTRIES))
    : Object.fromEntries(entries);
  await fs.mkdir(path.dirname(file), { recursive: true }).catch(() => {});
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify({ entries: bounded }), 'utf8');
  await fs.rename(temporary, file);
}

/**
 * Candidate identities for a specific version of the media.
 *
 * Several shapes are offered because the identifying fields are not always present
 * or spelled the same way (an asset may carry `etag`, `sha256`, `contentHash`, or
 * none of them, and a caller may pass the stored metadata instead of the asset).
 * A lookup matches if any candidate is present, which keeps a recorded transcript
 * useful across those differences rather than silently missing.
 */
function identityCandidates(asset, meta = {}) {
  const id = String(asset?.id || '');
  const size = String(meta.sizeBytes ?? asset?.sizeBytes ?? '');
  const etag = String(meta.etag ?? asset?.etag ?? '');
  const digest = String(asset?.sha256 || asset?.contentHash || '');
  const variants = [
    [id, size, etag, digest],
    [id, digest],
    [id, size, digest],
    [id, size, etag],
  ];
  const seen = new Set();
  const keys = [];
  for (const parts of variants) {
    if (!parts[0]) continue;
    const key = createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/** The primary candidate, used when recording. */
function identityOf(asset, meta) {
  return identityCandidates(asset, meta)[0] || null;
}

function usableWords(words) {
  return Array.isArray(words) && words.length > 0
    && words.every((word) => word && Number.isFinite(Number(word.start)) && Number.isFinite(Number(word.end)));
}

/**
 * Existing word timings for a video, or null.
 *
 * Sources, in order: the request's own `transcriptWords`, a transcript already
 * recorded for this exact media version, or a narration script carried by the asset
 * that the caller may pass along as text. Never performs recognition.
 *
 * @returns {Promise<{words: Array, text: string, source: string}|null>}
 */
export async function lookupTranscriptWords(asset, input = {}) {
  if (usableWords(input?.transcriptWords)) {
    return { words: input.transcriptWords, text: String(input.transcriptText || ''), source: 'request' };
  }
  if (!asset?.id) return null;

  const ledger = await loadLedger();
  for (const key of identityCandidates(asset, { sizeBytes: asset.sizeBytes, etag: asset.etag })) {
    const recorded = ledger.entries?.[key];
    if (recorded && usableWords(recorded.words)) {
      recorded.usedAt = Date.now();
      await saveLedger(ledger).catch(() => {});
      return { words: recorded.words, text: String(recorded.text || ''), source: 'ledger' };
    }
  }
  return null;
}

/** Remember word timings produced elsewhere, so later plans can reuse them. */
export async function rememberTranscriptWords(asset, words, text = '') {
  if (!asset?.id || !usableWords(words)) return false;
  const identity = identityOf(asset, { sizeBytes: asset.sizeBytes, etag: asset.etag });
  if (!identity) return false;
  const ledger = await loadLedger();
  ledger.entries[identity] = {
    words,
    text: String(text || '').slice(0, 20_000),
    assetId: String(asset.id),
    name: String(asset.name || '').slice(0, 200),
    usedAt: Date.now(),
  };
  await saveLedger(ledger).catch(() => {});
  return true;
}

/** Where the ledger lives, for diagnostics. */
export function transcriptCachePath() {
  return cacheFile();
}

/** Parse `Dialogue:` lines of an ASS file into timed segments. */
function parseAssCues(assText) {
  const cues = [];
  for (const line of String(assText || '').split('\n')) {
    const match = /^Dialogue:\s*\d+,([^,]+),([^,]+),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),(.*)$/.exec(line);
    if (!match) continue;
    const toSeconds = (value) => {
      const parts = /^(\d+):(\d+):(\d+)\.(\d+)$/.exec(String(value).trim());
      return parts
        ? Number(parts[1]) * 3600 + Number(parts[2]) * 60 + Number(parts[3]) + Number(parts[4]) / 100
        : null;
    };
    const start = toSeconds(match[1]);
    const end = toSeconds(match[2]);
    const text = String(match[9] || '').replace(/\\N/g, '').replace(/\{[^}]*\}/g, '').trim();
    if (start === null || end === null || end <= start || !text) continue;
    cues.push({ start, end, text });
  }
  return cues;
}

/**
 * Word timings derived from a subtitle file that already exists for the narration.
 *
 * A digital-human render stores its subtitle alongside the video, aligned to the
 * speech at generation time, so the narration's timing is already known. Reading it
 * back is what removes the render service's 36 s recognition from the critical path.
 *
 * Each cue becomes one timed token covering the cue's own span; the planner only uses
 * these to place and segment the speech, and a cue boundary is a sentence boundary,
 * which is exactly the granularity it works at.
 *
 * @returns {Promise<{words: Array, text: string, source: string}|null>}
 */
export async function transcriptFromSubtitle(subtitleStorageKey) {
  const key = String(subtitleStorageKey || '').trim();
  if (!key || !/\.(ass|ssa|srt)$/i.test(key)) return null;
  try {
    const url = signedReadUrl({ storageKey: key }, { preferOss: true });
    if (!url) return null;
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) return null;
    const body = await response.text();

    const cues = /\.(ass|ssa)$/i.test(key) ? parseAssCues(body) : parseSrtCues(body);
    if (!cues.length) return null;
    const text = cues.map((cue) => cue.text).join('');
    if (!text.trim()) return null;
    return {
      words: cues.map((cue) => ({ word: cue.text, text: cue.text, start: cue.start, end: cue.end })),
      text,
      source: 'subtitle',
    };
  } catch {
    return null;
  }
}

/** Parse SRT blocks into timed segments (the fallback subtitle format). */
function parseSrtCues(srtText) {
  const cues = [];
  const toSeconds = (value) => {
    const parts = /^(\d+):(\d+):(\d+)[,.](\d+)$/.exec(String(value).trim());
    return parts
      ? Number(parts[1]) * 3600 + Number(parts[2]) * 60 + Number(parts[3]) + Number(parts[4]) / 1000
      : null;
  };
  for (const block of String(srtText || '').split(/\n{2,}/)) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    const timeLine = lines.findIndex((line) => line.includes('-->'));
    if (timeLine < 0) continue;
    const [rawStart, rawEnd] = lines[timeLine].split('-->').map((part) => part.trim().split(/\s+/)[0]);
    const start = toSeconds(rawStart);
    const end = toSeconds(rawEnd);
    const text = lines.slice(timeLine + 1).join('');
    if (start === null || end === null || end <= start || !text) continue;
    cues.push({ start, end, text });
  }
  return cues;
}

/**
 * The best narration timing available without recognising anything: a subtitle that
 * already exists for this narration, otherwise the script text on its own.
 *
 * @param {object} asset         the main video asset
 * @param {object} project       the project, whose outputs may reference the subtitle
 * @param {object} input         the request, which may carry either already
 * @returns {Promise<{words: Array, text: string, source: string}|null>}
 */
export async function narrationTimingFor(asset, project, input = {}) {
  const fromRequest = await lookupTranscriptWords(asset, input);
  if (fromRequest) return fromRequest;

  const assetId = String(asset?.id || '');
  const outputs = Array.isArray(project?.outputs) ? project.outputs : [];
  // Rank the candidates deliberately:
  //   1. an output that *produced* this video (its subtitle describes this speech);
  //   2. an output that merely consumed it (e.g. an earlier vlog), whose subtitle
  //      covers that render — usable, but a product of this very pipeline rather
  //      than of the narration.
  // Within a rank, more cues means a finer timing.
  const produced = (output) => String(output?.generatedAssetId || output?.assetId || '') === assetId;
  const consumed = (output) => String(output?.sourceAssetId || '') === assetId;
  const candidates = outputs
    .filter((output) => produced(output) || consumed(output))
    .sort((a, b) => (Number(produced(b)) - Number(produced(a)))
      || ((b?.subtitleCueCount || 0) - (a?.subtitleCueCount || 0)));

  for (const output of candidates) {
    const fromSubtitle = await transcriptFromSubtitle(output?.subtitleStorageKey);
    if (fromSubtitle) return fromSubtitle;
  }
  const scriptText = candidates
    .map((output) => String(output?.speechScript || output?.sourceScript || output?.subtitleText || '').trim())
    .find(Boolean);
  if (scriptText) return { words: [], text: scriptText, source: 'script' };
  return null;
}
