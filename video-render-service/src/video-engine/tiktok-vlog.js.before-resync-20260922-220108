import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ProviderError } from '../lib/http.js';
import { searchAssets } from '../lib/semantic-search.js';
import { findSource, probeDuration } from '../providers/media.js';
import {
  burnSubtitles,
  concatSegmentsWithTransitions,
  createTextSrt,
  ensureNativeMedia,
  normalizeSegment,
  outputFileInfo,
  prepareVideoOutput,
  replaceAudioTrack,
  saveSubtitleFile,
} from './common.js';
import { createTikTokAdaptiveSubtitle, saveAdaptiveSubtitleFile } from './tiktok-subtitles.js';
import { transcribeWords } from './whisper.js';

export const AUTO_EDIT_POLICY = 'auto-edit-semantic-shots-v4';
export const AUTO_EDIT_TRANSITION_DURATION_SECONDS = 0.24;
export const AUTO_EDIT_MAX_SHOT_SECONDS = 2.4;
export const AUTO_EDIT_MIN_SHOT_SECONDS = 1.2;
export const AUTO_EDIT_TRANSITION_TYPES = [
  'SLIDE_LEFT',
  'SLIDE_RIGHT',
  'SLIDE_UP',
  'SLIDE_DOWN',
  'WIPE_DOWN',
  'WIPE_UP',
  'WIPE_RIGHT',
];

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function rounded(value) {
  return Math.round(finiteNumber(value) * 1000) / 1000;
}

function stableNumber(value) {
  return Number.parseInt(createHash('sha256').update(String(value)).digest('hex').slice(0, 8), 16);
}

// Auto-edit resolves every candidate b-roll asset before it can build a plan.
// Doing that with an unbounded Promise.all meant one ffprobe process and one open
// video file per asset: a project with 208 assets spawned 207 probes at once,
// exhausted memory on an 8 vCPU / 16 GB host, and blocked until MEDIA_TIMEOUT.
// These caps keep the fan-out proportional to the machine instead of to the
// size of the asset library.
export const CANDIDATE_READ_CONCURRENCY = 4;
export const CANDIDATE_PROBE_CONCURRENCY = 8;

async function mapWithConcurrency(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const output = new Array(list.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(Math.trunc(Number(limit)) || 1, list.length || 1));
  const runners = Array.from({ length: size }, async () => {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await worker(list[index], index);
    }
  });
  await Promise.all(runners);
  return output;
}

function assetDuration(asset) {
  return finiteNumber(asset?.durationSeconds ?? asset?.duration_seconds ?? asset?.duration, 0);
}

function normalizedSelectionText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/(?:副本|复制|copy|素材)[-_\s]*(?:\d+)?/gi, '')
    .replace(/[\s,，、;；。.!！?？:："'“”‘’()[\]{}<>《》/_-]+/g, '');
}

function normalizedSimilarityText(value) {
  return normalizedSelectionText(String(value || '')
    .replace(/\.[a-z0-9]{2,6}$/i, '')
    .replace(/(?:副本|复制|copy|素材)[-_\s]*(?:\d+)?$/gi, '')
    .replace(/[-_\s]+\d{1,5}$/i, ''));
}

const AUTO_EDIT_SEMANTIC_NOISE = new Set([
  '一个', '一些', '这个', '那个', '可以', '我们', '你们', '他们', '进行', '通过', '根据',
  '选择', '合适', '支持', '方向', '建议', '获取', '展示', '视频', '素材', '画面', '镜头',
  '场景', '特写', '整体', '细节',
]);
const AUTO_EDIT_GENERIC_CATEGORIES = new Set(['场景', '其他', '其它', '未分类', '自动识别', '视频', '素材']);

function semanticTerms(value) {
  const terms = new Set();
  const source = String(value || '').toLowerCase().replace(/\.[a-z0-9]{2,6}$/i, ' ');
  for (const run of source.match(/[\u3400-\u9fff]+|[a-z][a-z0-9]{1,}/gi) || []) {
    if (/^[\u3400-\u9fff]+$/.test(run)) {
      if (run.length === 1 && !AUTO_EDIT_SEMANTIC_NOISE.has(run)) terms.add(run);
      for (let index = 0; index < run.length - 1; index += 1) {
        const term = run.slice(index, index + 2);
        if (!AUTO_EDIT_SEMANTIC_NOISE.has(term)) terms.add(term);
      }
    } else if (!/^[a-f0-9]{12,}$/i.test(run)) {
      terms.add(run);
    }
  }
  return terms;
}

function isOpaqueAssetName(value) {
  const stem = String(value || '').trim().replace(/\.[a-z0-9]{2,6}$/i, '').replace(/[-_\s]/g, '');
  return !stem || /^[a-f0-9]{12,}$/i.test(stem) || /^(?:video|clip|asset|file)?\d+$/i.test(stem);
}

function assetSemanticTerms(asset) {
  const category = autoEditCategory(asset);
  const values = [
    isOpaqueAssetName(asset?.name) ? '' : asset?.name,
    AUTO_EDIT_GENERIC_CATEGORIES.has(category) ? '' : category,
    AUTO_EDIT_GENERIC_CATEGORIES.has(String(asset?.kind || '').trim()) ? '' : asset?.kind,
    ...(Array.isArray(asset?.tags) ? asset.tags : []),
    asset?.description,
  ];
  return semanticTerms(values.filter(Boolean).join(' '));
}

function semanticMatchTerms(asset, query) {
  const queryTerms = semanticTerms(query);
  if (!queryTerms.size) return [];
  const candidateTerms = assetSemanticTerms(asset);
  return [...queryTerms].filter((term) => candidateTerms.has(term));
}

function hasDescriptiveMetadata(asset) {
  if (isOpaqueAssetName(asset?.name)) return false;
  const category = autoEditCategory(asset);
  return !AUTO_EDIT_GENERIC_CATEGORIES.has(category) && assetSemanticTerms(asset).size > 0;
}

function autoEditCategory(asset) {
  const explicit = String(asset?.autoEditCategory || asset?.category || '').trim();
  if (explicit && explicit !== '自动识别') return explicit;
  const text = `${asset?.name || ''} ${Array.isArray(asset?.tags) ? asset.tags.join(' ') : ''} ${asset?.description || ''}`.toLowerCase();
  if (/(案例|客户|项目|交付|testimonial|case)/i.test(text)) return '案例';
  if (/(人物|人像|员工|客户出镜|模特|主持|person|portrait)/i.test(text)) return '人物';
  if (/(教程|步骤|教学|怎么|如何|安装|tutorial|guide)/i.test(text)) return '教程';
  if (/(效果|对比|前后|成果|测试结果|result|before|after)/i.test(text)) return '效果';
  if (/(工厂|生产|制造|加工|装配|包装|质检|车间|流程|process|factory)/i.test(text)) return '过程';
  if (/(口播|访谈|讲解|演讲|采访|talk|speech)/i.test(text)) return '口播';
  if (/(生活|家庭|办公室|旅行|户外|使用场景|lifestyle|home|office)/i.test(text)) return '生活';
  if (/(产品|细节|特写|外观|功能|接口|插头|排插|插座|设备|product|detail)/i.test(text)) return '产品';
  return String(asset?.kind || '场景').trim() || '场景';
}

function contentFingerprint(asset) {
  const visualFingerprint = String(asset?.visualFingerprint || asset?.perceptualHash || '').trim().toLowerCase();
  if (visualFingerprint) return `visual:${visualFingerprint}`;
  const digest = String(asset?.sha256 || asset?.contentHash || '').trim().toLowerCase();
  if (digest) return `digest:${digest}`;
  const normalizedName = normalizedSelectionText(asset?.name);
  return normalizedName ? `name:${normalizedName}` : `asset:${asset?.id || ''}`;
}

function similarityKey(asset) {
  const visualFingerprint = String(asset?.visualFingerprint || asset?.perceptualHash || '').trim().toLowerCase();
  if (visualFingerprint) return `visual:${visualFingerprint}`;
  const text = [autoEditCategory(asset), asset?.name, ...(Array.isArray(asset?.tags) ? asset.tags : []), asset?.description]
    .map(normalizedSimilarityText)
    .filter(Boolean)
    .join(':');
  return text || contentFingerprint(asset);
}

function uniqueSelectionCandidates(assets) {
  const selected = new Map();
  for (const asset of assets) {
    const key = contentFingerprint(asset);
    const current = selected.get(key);
    if (!current || finiteNumber(asset.highlightScore, 0) > finiteNumber(current.highlightScore, 0)) selected.set(key, asset);
  }
  return [...selected.values()];
}

function categoryGroups(assets) {
  const groups = new Map();
  for (const asset of assets) {
    const label = autoEditCategory(asset);
    const key = normalizedSelectionText(label) || '未分类';
    if (!groups.has(key)) groups.set(key, { key, label, assets: [] });
    groups.get(key).assets.push(asset);
  }
  return [...groups.values()];
}

function rankCategoryGroups(groups, query, seed, index) {
  const categoryAssets = groups.map((group) => ({
    id: group.key,
    name: group.label,
    kind: group.label,
    tags: group.assets.flatMap((asset) => Array.isArray(asset.tags) ? asset.tags : []).slice(0, 40),
    description: group.assets.map((asset) => `${asset.name || ''} ${asset.description || ''}`).join(' ').slice(0, 2_000),
  }));
  const ranked = searchAssets(categoryAssets, query, { limit: categoryAssets.length }).results;
  const rankedKeys = new Set(ranked.map((item) => item.id));
  const byKey = new Map(groups.map((group) => [group.key, group]));
  const fallback = groups
    .filter((group) => !rankedKeys.has(group.key))
    .sort((left, right) => stableNumber(`${seed}:${index}:category:${left.key}`) - stableNumber(`${seed}:${index}:category:${right.key}`));
  return {
    rankedKeys,
    ordered: [...ranked.map((item) => ({ ...byKey.get(item.id), relevanceScore: item.relevanceScore })), ...fallback],
  };
}

function intervalOverlapSeconds(start, end, intervals) {
  return intervals.reduce((total, interval) => total + Math.max(0, Math.min(end, interval.end) - Math.max(start, interval.start)), 0);
}

function nonOverlappingAssetStart({ available, duration, intervals, seed }) {
  const maxStart = Math.max(0, available - Math.min(duration, available));
  if (maxStart <= 0.001) return intervals.length ? null : 0;
  const padding = Math.min(0.25, duration * 0.08);
  const stride = Math.max(0.1, duration + padding);
  const starts = [];
  for (let cursor = 0; cursor <= maxStart + 0.001; cursor += stride) starts.push(Math.min(maxStart, cursor));
  if (!starts.some((item) => Math.abs(item - maxStart) < 0.001)) starts.push(maxStart);
  const ordered = [...new Set(starts.map(rounded))].sort((left, right) => (
    stableNumber(`${seed}:window:${left}`) - stableNumber(`${seed}:window:${right}`)
  ));
  const clear = ordered.find((start) => intervalOverlapSeconds(start - padding, start + duration + padding, intervals) <= 0.001);
  if (clear !== undefined) return clear;
  return null;
}

export function isGeneratedOutputAsset(asset) {
  const sourceType = String(asset?.sourceType || '').toLowerCase();
  const storageKey = String(asset?.storageKey || '').replace(/\\/g, '/').toLowerCase();
  return Boolean(
    asset?.sourceOutputId
    || sourceType.includes('generated')
    || sourceType.includes('output')
    || storageKey.includes('/generated/')
    || /auto-edit/i.test(String(asset?.name || ''))
  );
}

export function isAutoEditOutputAsset(asset, outputs = []) {
  if (!asset) return false;
  const linkedOutput = (Array.isArray(outputs) ? outputs : [])
    .find((output) => String(output?.id || '') === String(asset?.sourceOutputId || ''));
  return linkedOutput?.template === 'vlog'
    || /(?:^|[-_\s])auto[-_\s]?edit(?:\.|[-_\s]|$)/i.test(String(asset?.name || ''))
    || (Array.isArray(asset?.tags) && asset.tags.some((tag) => /自动剪辑|auto[-_\s]?edit/i.test(String(tag))));
}

function transitionType(seed, index) {
  const offset = stableNumber(`${seed}:transition-order`) % AUTO_EDIT_TRANSITION_TYPES.length;
  return AUTO_EDIT_TRANSITION_TYPES[(offset + index) % AUTO_EDIT_TRANSITION_TYPES.length];
}

function effectiveTransitionDuration(outgoingDuration, incomingDuration) {
  const duration = Math.min(
    AUTO_EDIT_TRANSITION_DURATION_SECONDS,
    Math.max(0, finiteNumber(outgoingDuration)) / 3,
    Math.max(0, finiteNumber(incomingDuration)) / 3,
  );
  const bounded = rounded(duration);
  return bounded * 30 >= 2 ? bounded : 0;
}

function splitSearchTextForShots(value, count) {
  const text = String(value || '').trim();
  const targetCount = Math.max(1, Math.trunc(finiteNumber(count, 1)));
  if (!text || targetCount === 1) return [text];
  const rawTokens = text.match(/[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*|\d+(?:\.\d+)?|[\u3400-\u9fff]|[^\s]/gi) || [...text];
  const tokens = [];
  for (const token of rawTokens) {
    if (/^[,，。；;!?！？、：:]$/.test(token) && tokens.length) tokens[tokens.length - 1] += token;
    else tokens.push(token);
  }
  if (tokens.length <= 1) return Array.from({ length: targetCount }, () => text);

  const parts = [];
  let offset = 0;
  for (let index = 0; index < targetCount; index += 1) {
    const remainingTokens = tokens.length - offset;
    const remainingParts = targetCount - index;
    const take = Math.max(1, Math.round(remainingTokens / remainingParts));
    parts.push(tokens.slice(offset, offset + take).join('').trim() || text);
    offset += take;
  }
  return parts;
}

function splitScript(text) {
  const value = String(text || '').replace(/\r/g, '').trim();
  if (!value) return [];
  const sentences = value.match(/[^。！？；!?;\n]+[。！？；!?;]?/g)
    ?.map((item) => item.trim()).filter(Boolean) || [];
  return sentences.flatMap((sentence) => {
    if (sentence.length <= 30) return [sentence];
    const clauses = sentence.split(/(?<=[，,、])\s*/).map((item) => item.trim()).filter(Boolean);
    return clauses.length > 1 ? clauses : (sentence.match(/[\s\S]{1,26}/g) || [sentence]);
  });
}

function normalizeTimedWords(words, durationSeconds) {
  return (Array.isArray(words) ? words : []).map((item) => {
    const text = String(item?.word ?? item?.text ?? '').trim();
    const start = finiteNumber(item?.start ?? (finiteNumber(item?.start_ms) / 1000), -1);
    const end = finiteNumber(item?.end ?? (finiteNumber(item?.end_ms) / 1000), -1);
    if (!text || start < 0 || end <= start || start >= durationSeconds) return null;
    return { text, start: rounded(start), end: rounded(Math.min(durationSeconds, end)) };
  }).filter(Boolean).sort((left, right) => left.start - right.start || left.end - right.end);
}

export function autoEditWindow(durationSeconds, options = {}) {
  const duration = Math.min(600, Math.max(0, finiteNumber(durationSeconds)));
  if (duration <= 0) throw new ProviderError('VIDEO_DURATION_INVALID', '主视频没有可识别的有效时长', { status: 400 });
  let materialStartSeconds = Math.max(0, finiteNumber(options.materialStartSeconds, 5));
  let sourceTailSeconds = Math.max(0, finiteNumber(options.sourceTailSeconds, 0));

  // Very short source videos cannot accommodate the desktop default of 5s.
  // Preserve a useful edit window instead of producing an empty render.
  if (materialStartSeconds + sourceTailSeconds >= duration) {
    sourceTailSeconds = Math.min(sourceTailSeconds, duration * 0.1);
    materialStartSeconds = Math.min(materialStartSeconds, duration * 0.2);
  }
  const materialEndSeconds = Math.max(materialStartSeconds, duration - sourceTailSeconds);
  if (materialEndSeconds - materialStartSeconds < 0.05) {
    throw new ProviderError('VIDEO_EDIT_WINDOW_INVALID', '素材开始时间和结尾保留时间没有留下可剪辑区间', { status: 400 });
  }
  return {
    durationSeconds: rounded(duration),
    materialStartSeconds: rounded(materialStartSeconds),
    sourceTailSeconds: rounded(sourceTailSeconds),
    materialEndSeconds: rounded(materialEndSeconds),
    materialDurationSeconds: rounded(materialEndSeconds - materialStartSeconds),
  };
}

export function scriptTimeline({
  durationSeconds,
  materialStartSeconds = 0,
  sourceTailSeconds = 0,
  text = '',
  words = [],
} = {}) {
  const window = autoEditWindow(durationSeconds, { materialStartSeconds, sourceTailSeconds });
  const timedWords = normalizeTimedWords(words, window.durationSeconds)
    .filter((item) => item.end > window.materialStartSeconds && item.start < window.materialEndSeconds);
  const semanticGroups = [];
  let group = null;
  for (const word of timedWords) {
    if (!group) group = { start: word.start, end: word.end, words: [] };
    group.words.push(word.text);
    group.end = word.end;
    const length = group.words.join('').length;
    const elapsed = group.end - group.start;
    const sentenceEnd = /[。！？；!?;]$/.test(word.text);
    if ((sentenceEnd && elapsed >= 0.35) || elapsed >= 4.2 || length >= 28) {
      semanticGroups.push(group);
      group = null;
    }
  }
  if (group) semanticGroups.push(group);

  const fallbackParts = splitScript(text);
  if (!semanticGroups.length) {
    const parts = fallbackParts.length
      ? fallbackParts
      : Array.from({ length: Math.max(1, Math.ceil(window.materialDurationSeconds / 3.5)) }, (_, index) => `画面段落 ${index + 1}`);
    const weights = parts.map((part) => Math.max(1, String(part).replace(/\s/g, '').length));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    let cursor = window.materialStartSeconds;
    return parts.map((part, index) => {
      const end = index === parts.length - 1
        ? window.materialEndSeconds
        : cursor + (window.materialDurationSeconds * weights[index] / totalWeight);
      const item = {
        id: `segment-${index + 1}`,
        text: part,
        start: rounded(cursor),
        end: rounded(end),
        duration: rounded(end - cursor),
      };
      cursor = end;
      return item;
    });
  }

  const timeline = [];
  let cursor = window.materialStartSeconds;
  for (let index = 0; index < semanticGroups.length; index += 1) {
    const semantic = semanticGroups[index];
    const end = index === semanticGroups.length - 1
      ? window.materialEndSeconds
      : Math.min(window.materialEndSeconds, Math.max(cursor + 0.12, semantic.end));
    if (end <= cursor) continue;
    timeline.push({
      id: `segment-${timeline.length + 1}`,
      text: semantic.words.join(''),
      start: rounded(cursor),
      end: rounded(end),
      duration: rounded(end - cursor),
    });
    cursor = end;
  }
  if (cursor < window.materialEndSeconds && timeline.length) {
    timeline.at(-1).end = window.materialEndSeconds;
    timeline.at(-1).duration = rounded(window.materialEndSeconds - timeline.at(-1).start);
  }
  return timeline;
}

export function autoEditShotTimeline(timeline = [], assets = [], options = {}) {
  const assetList = Array.isArray(assets) ? assets : [];
  const minimum = Math.max(0.2, finiteNumber(options.minimumShotSeconds, AUTO_EDIT_MIN_SHOT_SECONDS));
  const longestAsset = Math.max(0, ...assetList.map(assetDuration));
  const maximum = Math.max(0.05, Math.min(
    finiteNumber(options.maximumShotSeconds, AUTO_EDIT_MAX_SHOT_SECONDS),
    longestAsset || AUTO_EDIT_MAX_SHOT_SECONDS,
  ));
  const compacted = [];
  for (const source of Array.isArray(timeline) ? timeline : []) {
    const start = finiteNumber(source?.start, -1);
    const end = finiteNumber(source?.end, -1);
    if (start < 0 || end <= start) continue;
    const current = { ...source, start, end, duration: rounded(end - start), text: String(source?.text || '').trim() };
    if (current.duration < minimum && compacted.length) {
      const previous = compacted.at(-1);
      previous.end = current.end;
      previous.duration = rounded(previous.end - previous.start);
      previous.text = `${previous.text}${current.text}`.trim();
    } else {
      compacted.push(current);
    }
  }
  if (compacted.length > 1 && compacted[0].duration < minimum) {
    const first = compacted.shift();
    compacted[0].start = first.start;
    compacted[0].duration = rounded(compacted[0].end - first.start);
    compacted[0].text = `${first.text}${compacted[0].text}`.trim();
  }

  return compacted.flatMap((segment) => {
    const duration = segment.end - segment.start;
    const relevantDurations = assetList
      .filter((asset) => semanticMatchTerms(asset, segment.text).length)
      .map(assetDuration)
      .filter((value) => value > 0);
    const count = Math.max(1, Math.ceil(duration / maximum));
    const evenDuration = duration / count;
    let shotDurations = Array.from({ length: count }, () => evenDuration);
    const preferredShortShot = relevantDurations.filter((value) => value >= minimum).sort((left, right) => left - right)[0];
    if (preferredShortShot && preferredShortShot < evenDuration - 0.05) {
      const remaining = duration - preferredShortShot;
      const remainingCount = Math.max(1, Math.ceil(remaining / maximum));
      const remainingDuration = remaining / remainingCount;
      if (remainingDuration >= minimum) {
        shotDurations = [preferredShortShot, ...Array.from({ length: remainingCount }, () => remainingDuration)];
      }
    }
    const shotSearchTexts = splitSearchTextForShots(segment.text, shotDurations.length);
    let cursor = segment.start;
    return shotDurations.map((shotDuration, index) => {
      const start = cursor;
      const end = index === shotDurations.length - 1 ? segment.end : cursor + shotDuration;
      cursor = end;
      return {
        ...segment,
        id: `${segment.id || 'segment'}-shot-${index + 1}`,
        semanticSegmentId: segment.id || null,
        shotIndex: index,
        searchText: shotSearchTexts[index] || segment.text,
        start: rounded(start),
        end: rounded(end),
        duration: rounded(end - start),
      };
    });
  });
}

export function buildAutoEditPlan({
  durationSeconds,
  materialStartSeconds = 0,
  sourceTailSeconds = 0,
  timeline = [],
  assets = [],
  seed = 'chensi-auto-edit',
  historyPlans = [],
} = {}) {
  const window = autoEditWindow(durationSeconds, { materialStartSeconds, sourceTailSeconds });
  const candidates = uniqueSelectionCandidates((Array.isArray(assets) ? assets : []).filter((asset) => (
    asset?.id && assetDuration(asset) > 0 && !isGeneratedOutputAsset(asset)
  )));
  if (!candidates.length) return [];
  const sourceTimeline = Array.isArray(timeline) && timeline.length
    ? timeline
    : scriptTimeline({ ...window, text: '', words: [] });
  const contextQuery = sourceTimeline.map((segment) => String(segment?.text || '').trim()).filter(Boolean).join(' ');
  const contentUsage = new Map();
  const categoryUsage = new Map();
  const usedSimilarityKeys = new Set();
  const usedWindows = new Map();
  const historicalContentUsage = new Map();
  const historicalCategoryUsage = new Map();
  const assetById = new Map(candidates.map((asset) => [String(asset.id), asset]));
  for (const historical of Array.isArray(historyPlans) ? historyPlans.flat() : []) {
    const asset = assetById.get(String(historical?.assetId || ''));
    if (!asset) continue;
    const fingerprint = contentFingerprint(asset);
    const categoryKey = normalizedSelectionText(historical?.assetCategory || autoEditCategory(asset)) || '未分类';
    historicalContentUsage.set(fingerprint, finiteNumber(historicalContentUsage.get(fingerprint), 0) + 1);
    historicalCategoryUsage.set(categoryKey, finiteNumber(historicalCategoryUsage.get(categoryKey), 0) + 1);
  }
  let previousFingerprint = null;
  let previousSimilarityKey = null;
  let previousCategoryKey = null;
  const contextMatches = new Map(candidates.map((asset) => [String(asset.id), semanticMatchTerms(asset, contextQuery)]));
  const contextSearch = new Map(searchAssets(candidates, contextQuery, { limit: candidates.length }).results.map((asset) => [String(asset.id), asset]));
  const plan = [];
  const scoreMatch = (asset, matchedTerms, searchResult) => ({
    asset,
    matchedTerms,
    matchedFilenameTerms: searchResult?.matchedFilenameTerms || [],
    semanticScore: Math.max(
      finiteNumber(searchResult?.relevanceScore, 0),
      Math.min(100, matchedTerms.length * 18),
    ),
  });

  for (let index = 0; index < sourceTimeline.length; index += 1) {
    const segment = sourceTimeline[index];
    const sourceText = String(segment.text || '').trim();
    const query = String(segment.searchText || sourceText).trim();
    const duration = Math.max(0.05, finiteNumber(segment.end) - finiteNumber(segment.start));
    const ranked = new Map(searchAssets(candidates, query, { limit: candidates.length }).results.map((asset) => [String(asset.id), asset]));
    const eligible = candidates.filter((asset) => {
      if (assetDuration(asset) + 0.001 < duration) return false;
      const intervals = usedWindows.get(contentFingerprint(asset)) || [];
      return nonOverlappingAssetStart({
        available: assetDuration(asset),
        duration,
        intervals,
        seed: `${seed}:${index}:${contentFingerprint(asset)}`,
      }) !== null;
    });
    if (!eligible.length) {
      throw new ProviderError(
        'VIDEO_AUTO_MATCH_MATERIAL_INSUFFICIENT',
        '可用素材不足以生成不重复镜头，请补充更长或更多已分类视频素材',
        { status: 400 },
      );
    }

    const categoryKeyFor = (asset) => normalizedSelectionText(autoEditCategory(asset)) || '未分类';
    const unusedCategoryCandidates = eligible.filter((asset) => (
      !categoryUsage.has(categoryKeyFor(asset))
      && (contextMatches.get(String(asset.id)) || []).length
    ));
    const preferredCategoryCandidates = unusedCategoryCandidates.length
      ? unusedCategoryCandidates
      : eligible.filter((asset) => categoryKeyFor(asset) !== previousCategoryKey);
    const preferredCategoryIds = new Set(preferredCategoryCandidates.map((asset) => String(asset.id)));

    let selectionOrigin = 'direct-semantic-match';
    let scored = eligible.map((asset) => {
      const matchedTerms = semanticMatchTerms(asset, query);
      return scoreMatch(asset, matchedTerms, ranked.get(String(asset.id)));
    }).filter((item) => item.matchedTerms.length);
    if (scored.length) {
      const nonAdjacentDirect = scored.filter((item) => categoryKeyFor(item.asset) !== previousCategoryKey);
      if (nonAdjacentDirect.length) {
        scored = nonAdjacentDirect;
      } else {
        const diverseContext = preferredCategoryCandidates.map((asset) => {
          const matchedTerms = contextMatches.get(String(asset.id)) || [];
          return scoreMatch(asset, matchedTerms, contextSearch.get(String(asset.id)));
        }).filter((item) => item.matchedTerms.length);
        if (diverseContext.length) {
          selectionOrigin = 'context-diversity-match';
          scored = diverseContext;
        }
      }
    }

    if (!scored.length) {
      selectionOrigin = 'context-semantic-match';
      scored = eligible.map((asset) => {
        const matchedTerms = contextMatches.get(String(asset.id)) || [];
        return scoreMatch(asset, matchedTerms, contextSearch.get(String(asset.id)));
      }).filter((item) => item.matchedTerms.length);
      const preferredContext = scored.filter((item) => preferredCategoryIds.has(String(item.asset.id)));
      if (preferredContext.length) scored = preferredContext;
    }

    if (!scored.length) {
      selectionOrigin = 'classified-fallback';
      scored = eligible.filter(hasDescriptiveMetadata).map((asset) => scoreMatch(asset, [], null));
      const preferredFallback = scored.filter((item) => preferredCategoryIds.has(String(item.asset.id)));
      if (preferredFallback.length) scored = preferredFallback;
    }
    if (!scored.length) {
      throw new ProviderError(
        'VIDEO_AUTO_MATCH_RELEVANCE_LOW',
        '素材缺少可用于匹配的名称或分类，请先在素材库补充分类后再生成',
        { status: 400 },
      );
    }

    if (selectionOrigin !== 'classified-fallback') {
      const strongest = Math.max(...scored.map((item) => item.matchedTerms.length));
      const minimumTerms = selectionOrigin === 'direct-semantic-match' ? strongest : Math.max(1, strongest - 1);
      const relevant = scored.filter((item) => item.matchedTerms.length >= minimumTerms);
      if (relevant.length) scored = relevant;
    }
    const belowHistoryLimit = scored.filter((item) => (
      finiteNumber(historicalContentUsage.get(contentFingerprint(item.asset)), 0) < 2
    ));
    if (belowHistoryLimit.length) scored = belowHistoryLimit;
    const unusedContent = scored.filter((item) => !contentUsage.has(contentFingerprint(item.asset)));
    if (unusedContent.length) scored = unusedContent;
    const nonAdjacent = scored.filter((item) => contentFingerprint(item.asset) !== previousFingerprint);
    if (nonAdjacent.length) scored = nonAdjacent;
    const differentVisualGroup = scored.filter((item) => similarityKey(item.asset) !== previousSimilarityKey);
    if (differentVisualGroup.length) scored = differentVisualGroup;
    const differentCategory = scored.filter((item) => (
      (normalizedSelectionText(autoEditCategory(item.asset)) || '未分类') !== previousCategoryKey
    ));
    if (differentCategory.length) scored = differentCategory;
    const unusedCategories = scored.filter((item) => {
      const categoryKey = normalizedSelectionText(autoEditCategory(item.asset)) || '未分类';
      return !categoryUsage.has(categoryKey);
    });
    if (unusedCategories.length) scored = unusedCategories;
    const distinctVisuals = scored.filter((item) => !usedSimilarityKeys.has(similarityKey(item.asset)));
    if (distinctVisuals.length) scored = distinctVisuals;

    const selectedRecord = [...scored].sort((left, right) => (
      right.matchedFilenameTerms.length - left.matchedFilenameTerms.length
      || right.matchedTerms.length - left.matchedTerms.length
      || finiteNumber(right.semanticScore, 0) - finiteNumber(left.semanticScore, 0)
      || finiteNumber(historicalContentUsage.get(contentFingerprint(left.asset)), 0)
        - finiteNumber(historicalContentUsage.get(contentFingerprint(right.asset)), 0)
      || stableNumber(`${seed}:${index}:asset:${left.asset.id}`) - stableNumber(`${seed}:${index}:asset:${right.asset.id}`)
    ))[0];
    const selected = selectedRecord.asset;
    const available = assetDuration(selected);
    const fingerprint = contentFingerprint(selected);
    const intervals = usedWindows.get(fingerprint) || [];
    const assetStart = nonOverlappingAssetStart({
      available,
      duration,
      intervals,
      seed: `${seed}:${index}:${fingerprint}`,
    });
    if (assetStart === null) {
      throw new ProviderError('VIDEO_AUTO_MATCH_WINDOW_CONFLICT', '素材没有剩余的不重复时间段，请补充视频素材', { status: 400 });
    }
    intervals.push({ start: assetStart, end: Math.min(available, assetStart + duration) });
    usedWindows.set(fingerprint, intervals);
    contentUsage.set(fingerprint, finiteNumber(contentUsage.get(fingerprint), 0) + 1);
    const categoryLabel = autoEditCategory(selected);
    const categoryKey = normalizedSelectionText(categoryLabel) || '未分类';
    categoryUsage.set(categoryKey, finiteNumber(categoryUsage.get(categoryKey), 0) + 1);
    usedSimilarityKeys.add(similarityKey(selected));
    const outgoingDuration = index === 0
      ? finiteNumber(segment.start)
      : finiteNumber(sourceTimeline[index - 1].end) - finiteNumber(sourceTimeline[index - 1].start);
    const transitionDurationSeconds = fingerprint === previousFingerprint
      ? 0
      : effectiveTransitionDuration(outgoingDuration, duration);
    previousFingerprint = fingerprint;
    previousSimilarityKey = similarityKey(selected);
    previousCategoryKey = categoryKey;
    plan.push({
      index,
      segmentId: segment.id || `segment-${index + 1}`,
      semanticSegmentId: segment.semanticSegmentId || segment.id || null,
      shotIndex: finiteNumber(segment.shotIndex, 0),
      text: sourceText || query,
      searchText: query,
      assetId: selected.id,
      assetName: selected.name || selected.id,
      timelineStartSeconds: rounded(segment.start),
      timelineEndSeconds: rounded(segment.end),
      durationSeconds: rounded(duration),
      assetStartSeconds: rounded(assetStart),
      assetEndSeconds: rounded(assetStart + duration),
      loop: false,
      muteAudio: true,
      transition: transitionDurationSeconds ? transitionType(seed, index) : 'CUT',
      transitionDurationSeconds,
      semanticScore: rounded(selectedRecord.semanticScore),
      matchedTerms: selectedRecord.matchedTerms,
      matchedFilenameTerms: selectedRecord.matchedFilenameTerms,
      assetCategory: categoryLabel,
      categoryScore: rounded(selectedRecord.semanticScore),
      contentReuseCount: contentUsage.get(fingerprint),
      historicalReuseCount: finiteNumber(historicalContentUsage.get(fingerprint), 0),
      categoryUseCount: categoryUsage.get(categoryKey),
      selectionOrigin,
    });
  }
  return plan;
}

export async function renderVlog(task, input, project, { onProgress = async () => {} } = {}) {
  const config = ensureNativeMedia();
  const ids = [...new Set([
    ...(Array.isArray(input.videoAssetIds) ? input.videoAssetIds : []),
    input.videoAssetId,
  ].filter(Boolean).map(String))];
  if (ids.length > 1) {
    throw new ProviderError('VIDEO_MAIN_ASSET_COUNT_INVALID', 'AI 自动剪辑只需选择一条主视频，其他视频会从素材库自动匹配', { status: 400 });
  }
  const mainSource = ids.length
    ? await findSource({ assetId: ids[0], assets: project.assets, mimePrefix: 'video/', timeoutMs: config.timeoutMs })
    : await findSource({ explicit: input.videoSample, assets: project.assets, mimePrefix: 'video/', timeoutMs: config.timeoutMs });
  if (!mainSource?.filePath) throw new ProviderError('VIDEO_ASSET_REQUIRED', '请先选择一条数字人主视频', { status: 400 });
  const mainAsset = (project.assets || []).find((asset) => String(asset.id) === String(mainSource.assetId));
  if (isAutoEditOutputAsset(mainAsset, project.outputs)) {
    throw new ProviderError(
      'VIDEO_AUTO_EDIT_RECURSIVE_SOURCE',
      '自动剪辑成片不能再次作为主视频，请选择原始视频或数字人口播成片',
      { status: 400 },
    );
  }
  await onProgress(12, '主视频已读取');

  const candidateAssets = (project.assets || []).filter((asset) => (
    asset.id !== mainSource.assetId
    && asset.storageKey
    && String(asset.mimeType || '').startsWith('video/')
    && !isGeneratedOutputAsset(asset)
  ));
  if (!candidateAssets.length) {
    throw new ProviderError('VIDEO_BROLL_REQUIRED', '素材库还没有可自动匹配的辅助视频，请至少再上传一条视频素材', { status: 400 });
  }
  const candidateSources = await mapWithConcurrency(candidateAssets, CANDIDATE_READ_CONCURRENCY, (asset) => (
    findSource({ assetId: asset.id, assets: project.assets, mimePrefix: 'video/', timeoutMs: config.timeoutMs })
  ));
  const [mainDuration, candidateDurations] = await Promise.all([
    probeDuration(mainSource.filePath, config),
    mapWithConcurrency(candidateSources, CANDIDATE_PROBE_CONCURRENCY, (source) => (
      probeDuration(source.filePath, config)
    )),
  ]);
  await onProgress(24, '候选素材已读取');
  const window = autoEditWindow(mainDuration, {
    materialStartSeconds: input.materialStartSeconds,
    sourceTailSeconds: input.sourceTailSeconds,
  });

  let transcription = Array.isArray(input.transcriptWords)
    ? { words: input.transcriptWords, text: input.transcriptText || '' }
    : null;
  if (!transcription) {
    try {
      transcription = await transcribeWords(mainSource.filePath, {
        language: String(input.language || '').split(/[-_]/)[0] || undefined,
      });
    } catch {
      // A supplied script still provides deterministic semantic timing when
      // the optional local speech recognizer is unavailable.
    }
  }
  const timedWords = Array.isArray(transcription?.words) ? transcription.words : [];
  const transcriptText = String(transcription?.text || timedWords.map((item) => item.word || item.text || '').join('')).trim();
  const semanticText = transcriptText || String(input.subtitleText || '').trim();
  const timeline = scriptTimeline({ ...window, text: semanticText, words: timedWords });
  await onProgress(36, '口播时间线已识别');
  const candidatesWithDuration = candidateAssets.map((asset, index) => ({
    ...asset,
    durationSeconds: candidateDurations[index],
  }));
  const shotTimeline = autoEditShotTimeline(timeline, candidatesWithDuration);
  const plan = buildAutoEditPlan({
    ...window,
    timeline: shotTimeline,
    assets: candidatesWithDuration,
    seed: input.matchSeed || task.id,
    historyPlans: (project.outputs || [])
      .filter((output) => output.template === 'vlog' && Array.isArray(output.autoMatchPlan))
      .slice(0, 8)
      .map((output) => output.autoMatchPlan),
  });
  if (!plan.length) throw new ProviderError('VIDEO_AUTO_MATCH_EMPTY', '没有生成可用的自动素材匹配时间线', { status: 400 });
  await onProgress(42, '素材匹配方案已生成');

  const sourceById = new Map(candidateSources.map((source) => [source.assetId, source]));
  const narration = input.audioAssetId
    ? await findSource({ assetId: input.audioAssetId, assets: project.assets, mimePrefix: 'audio/', timeoutMs: config.timeoutMs })
    : null;
  if (input.audioAssetId && !narration?.filePath) {
    throw new ProviderError('VIDEO_AUDIO_INVALID', '所选配音素材没有可处理的本地文件', { status: 400 });
  }
  if (narration) await onProgress(44, '配音素材已读取');

  const prepared = await prepareVideoOutput({ project, task, title: input.title, suffix: 'auto-edit' });
  const workDir = await fs.mkdtemp(path.join(path.dirname(prepared.filePath), `auto-edit-${task.id}-`));
  let subtitleFile = null;
  let subtitleError = null;
  let subtitleMeta = null;
  let subtitleFormat = null;
  try {
    const segments = [];
    const renderStepCount = plan.length + (window.materialStartSeconds > 0 ? 1 : 0) + (window.sourceTailSeconds > 0 ? 1 : 0);
    let renderedSteps = 0;
    const reportRenderedStep = async () => {
      renderedSteps += 1;
      await onProgress(44 + Math.round((renderedSteps / renderStepCount) * 20), `已处理画面 ${renderedSteps}/${renderStepCount}`);
    };
    // Cosmetic sharpening (eq/unsharp/cas) follows the caller's `hdFilter` flag,
    // which the workspace UI drives with `checked !== false` — i.e. it defaults ON
    // and the operator unticks it to go faster. Only an explicit `false` disables
    // it, so an omitted flag keeps the historical behaviour.
    const enhance = input.hdFilter !== false;
    const ratio = input.ratio || '9:16';
    if (window.materialStartSeconds > 0) {
      const introPath = path.join(workDir, 'segment-000-intro.mp4');
      await normalizeSegment({
        source: mainSource.filePath,
        destination: introPath,
        duration: window.materialStartSeconds,
        ratio,
        config,
        crop: false,
        enhance,
        muteAudio: true,
      });
      segments.push({
        filePath: introPath,
        durationSeconds: window.materialStartSeconds,
        transition: 'CUT',
        transitionDurationSeconds: 0,
      });
      await reportRenderedStep();
    }
    for (let index = 0; index < plan.length; index += 1) {
      const item = plan[index];
      const source = sourceById.get(item.assetId);
      const output = path.join(workDir, `segment-${String(index + 1).padStart(3, '0')}-broll.mp4`);
      await normalizeSegment({
        source: source.filePath,
        destination: output,
        start: item.assetStartSeconds,
        duration: item.durationSeconds,
        ratio,
        config,
        crop: true,
        enhance,
        muteAudio: true,
        loop: item.loop,
      });
      segments.push({
        filePath: output,
        durationSeconds: item.durationSeconds,
        transition: item.transition,
        transitionDurationSeconds: item.transitionDurationSeconds,
      });
      await reportRenderedStep();
    }
    if (window.sourceTailSeconds > 0) {
      const tailPath = path.join(workDir, 'segment-999-tail.mp4');
      await normalizeSegment({
        source: mainSource.filePath,
        destination: tailPath,
        start: window.materialEndSeconds,
        duration: window.sourceTailSeconds,
        ratio,
        config,
        crop: false,
        enhance,
        muteAudio: true,
      });
      const tailTransitionDuration = effectiveTransitionDuration(
        plan.at(-1)?.durationSeconds,
        window.sourceTailSeconds,
      );
      segments.push({
        filePath: tailPath,
        durationSeconds: window.sourceTailSeconds,
        transition: tailTransitionDuration ? transitionType(input.matchSeed || task.id, plan.length) : 'CUT',
        transitionDurationSeconds: tailTransitionDuration,
      });
      await reportRenderedStep();
    }

    const visualPath = path.join(workDir, 'auto-edit-visual.mp4');
    await concatSegmentsWithTransitions(segments, visualPath, workDir, config);
    await onProgress(72, '画面与转场已合成');
    const mixedPath = path.join(workDir, 'auto-edit-audio.mp4');
    await replaceAudioTrack(visualPath, narration?.filePath || mainSource.filePath, mixedPath, window.durationSeconds, config);
    await onProgress(78, '音轨已合成');

    const subtitleText = String(input.subtitleText || transcriptText || '').trim();
    if (input.subtitleEmphasis !== false && (subtitleText || timedWords.length)) {
      try {
        subtitleMeta = await createTikTokAdaptiveSubtitle({
          audioPath: narration?.filePath || mainSource.filePath,
          text: subtitleText,
          durationSeconds: window.durationSeconds,
          language: input.language,
          ratio,
          timedWords: narration ? null : timedWords,
        });
        subtitleFile = await saveAdaptiveSubtitleFile({
          project,
          task,
          title: input.title || 'AI 自动剪辑',
          content: subtitleMeta.ass,
        });
        subtitleFormat = 'ass';
      } catch (error) {
        if (error?.code === 'RENDER_CANCELED') throw error;
        subtitleError = error.message || '字幕生成失败';
        if (subtitleText) {
          subtitleFile = await saveSubtitleFile({
            project,
            task,
            title: input.title || 'AI 自动剪辑',
            content: createTextSrt(subtitleText, window.durationSeconds),
          });
          subtitleFormat = subtitleFile ? 'srt' : null;
        }
      }
    }
    await onProgress(84, input.subtitleEmphasis === false ? '字幕设置已确认' : subtitleFile ? '字幕文件已生成' : '字幕处理已完成');
    if (subtitleFile) await burnSubtitles(mixedPath, subtitleFile.filePath, prepared.filePath, config);
    else await fs.copyFile(mixedPath, prepared.filePath);
    await onProgress(88, subtitleFile ? '字幕已合成到视频' : '成片文件已生成');

    const info = await outputFileInfo(prepared.filePath);
    await onProgress(90, '成片文件已校验');
    const autoMatchedAssetIds = [...new Set(plan.map((item) => item.assetId))];
    return {
      provider: 'native-tiktok-auto-edit',
      model: null,
      externalTaskId: null,
      output: {
        ...prepared,
        sizeBytes: info.stat.size,
        durationSeconds: info.durationSeconds,
        ratio,
        sourceAssetId: mainSource.assetId || null,
        sourceAssetIds: [mainSource.assetId, ...autoMatchedAssetIds].filter(Boolean),
        segmentCount: plan.length,
        audioSourceAssetId: narration?.assetId || mainSource.assetId || null,
        subtitleStorageKey: subtitleFile?.storageKey || null,
        subtitleFilename: subtitleFile?.filename || null,
        subtitleText: String(input.subtitleText || transcriptText || '').trim(),
        subtitleFormat,
        subtitleTiming: subtitleMeta?.transcribed ? 'audio-word-timestamps' : subtitleFile ? 'script-duration-aligned' : null,
        subtitleCues: Array.isArray(subtitleMeta?.cues) ? subtitleMeta.cues : null,
        subtitleCueCount: Number(subtitleMeta?.cue_count || subtitleMeta?.cues?.length || 0) || null,
        subtitleBurned: Boolean(subtitleFile),
        subtitleError,
        template: 'vlog',
        templateLabel: 'AI 自动剪辑',
        algorithm: '主视频时间线语义素材匹配',
        transitionPolicy: AUTO_EDIT_POLICY,
        transitions: plan.map((item) => ({
          type: item.transition,
          duration: item.transitionDurationSeconds,
        })),
        materialStartSeconds: window.materialStartSeconds,
        sourceTailSeconds: window.sourceTailSeconds,
        autoMatchedAssetIds,
        autoMatchPlan: plan,
        transcriptionMode: timedWords.length ? 'audio-word-timestamps' : semanticText ? 'script-fallback' : 'stable-beat-fallback',
        pipelineStages: ['主视频语音识别', '字幕语义分段', '素材语义匹配', '素材动态转场', '连续画面覆盖', '主音轨保留', ...(subtitleFile ? [subtitleFormat === 'ass' ? '重点词字幕' : '自动字幕'] : []), ...(enhance ? ['高清处理'] : [])],
        hdFilter: enhance,
        visualCoverageMode: 'FULL_BROLL_AFTER_START',
        editSummary: `跟随主视频 ${window.durationSeconds}s · 自动匹配 ${plan.length} 段素材 · 240ms 动态转场 · ${window.materialStartSeconds}s 后连续覆盖`,
      },
    };
  } catch (error) {
    await fs.rm(prepared.filePath, { force: true }).catch(() => {});
    if (subtitleFile) await fs.rm(subtitleFile.filePath, { force: true }).catch(() => {});
    throw error;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
