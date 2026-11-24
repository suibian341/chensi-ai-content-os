const aliases = {
  排插: ['排插', '插排', '插座'],
  插排: ['排插', '插排', '插座'],
  美女: ['美女', '女性', '女人', '女生'],
  男子: ['男子', '男人', '男性', '男士'],
  儿童: ['儿童', '孩子', '小孩', '男孩', '女孩'],
  高级感: ['高级感', '高级', '高端', '质感', '商务'],
  走路: ['走路', '行走', '步行', '迈步'],
  竖屏: ['竖屏', '竖版', '9:16'],
  横屏: ['横屏', '横版', '16:9']
};

const genericTerms = new Set(['找', '搜索', '查找', '素材', '视频', '图片', '音频', '几个', '一些', '需要', '我要', '帮我', '推荐', '返回']);

function norm(value) {
  return String(value ?? '').trim();
}

function filenameStem(value) {
  return norm(value).replace(/\.[^./\\]+$/, '');
}

function normalize(value) {
  return norm(value).toLowerCase().replace(/[\s,，、;；。.!！?？:："'“”‘’()[\]{}<>《》/_-]+/g, '');
}

function list(value) {
  if (Array.isArray(value)) return value.map(norm).filter(Boolean);
  return norm(value).split(/[,，、;；\n\s]+/).map(norm).filter(Boolean);
}

function unique(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = normalize(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function hit(value, term) {
  const text = normalize(value);
  return (aliases[term] || [term]).some((variant) => text.includes(normalize(variant)));
}

function stableUrlKey(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.toLowerCase()}${parsed.pathname}`.replace(/\/+$/, '');
  } catch {
    return norm(url).split(/[?#]/)[0].toLowerCase();
  }
}

export function createQueryPlan(query, { kind = '', limit = 20 } = {}) {
  const text = norm(query);
  const durationMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:秒|s(?:ec(?:ond)?s?)?\b)/i);
  const countMatch = text.match(/(?:找|要|给我|返回|推荐)?\s*(\d+)\s*(?:个|条|段|支|则)/);
  const semanticQuery = text
    .replace(/^(请|麻烦)?(帮我)?(找|搜索|查找|推荐)/, '')
    .replace(/(?:找|要|给我|返回|推荐)?\s*\d+\s*(?:个|条|段|支|则)/g, '')
    .replace(/\d+(?:\.\d+)?\s*(?:秒|s(?:ec(?:ond)?s?)?\b)/gi, '')
    .replace(/最佳|最好|最优|质量最高|评分最高|最推荐/g, '')
    .replace(/(?:素材|视频|图片|音频)$/g, '')
    .replace(/^的+|的+$/g, '')
    .trim();
  const fragments = semanticQuery.split(/[,，、;；\s]+/).filter((term) => term.length >= 2 && !genericTerms.has(term));
  const aliasTerms = Object.keys(aliases).filter((term) => semanticQuery.includes(term));
  const cjkBigrams = fragments.flatMap((fragment) => {
    if (!/^[\u3400-\u9fff]+$/.test(fragment) || fragment.length < 4) return [];
    return Array.from({ length: fragment.length - 1 }, (_, index) => fragment.slice(index, index + 2));
  });
  const terms = unique([...aliasTerms, ...fragments, ...cjkBigrams]).slice(0, 8);
  return {
    semantic_query: semanticQuery || text,
    recall_terms: terms,
    material_type: kind === '全部类型' ? '' : kind,
    target_duration_seconds: durationMatch ? Number(durationMatch[1]) : null,
    prefer_best: /最佳|最好|最优|质量最高|评分最高|最推荐/.test(text),
    limit: Math.max(1, Math.min(50, countMatch ? Number(countMatch[1]) : Number(limit) || 20))
  };
}

function durationFrom(asset) {
  const direct = Number(asset.durationSeconds ?? asset.duration_seconds ?? asset.duration);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const match = norm(asset.description).match(/(?:时长|持续时间)\s*(?:约|为|是|[：:])?\s*(\d+(?:\.\d+)?)\s*(?:秒|s)/i);
  return match ? Number(match[1]) : null;
}

export function searchAssets(assets, query, options = {}) {
  const plan = options.plan || createQueryPlan(query, options);
  const terms = unique([...list(plan.recall_terms), ...list(plan.must_terms), ...list(plan.subject_terms)]);
  const negative = unique(list(plan.negative_terms));
  const wantedKind = norm(plan.material_type);
  const wantedRatio = norm(plan.ratio);
  const targetDuration = Number(plan.target_duration_seconds) || null;

  const ranked = (Array.isArray(assets) ? assets : []).map((asset, index) => {
    if (wantedKind && !hit(`${asset.kind} ${asset.mimeType}`, wantedKind)) return null;
    if (wantedRatio && normalize(asset.ratio) !== normalize(wantedRatio)) return null;
    const filenameText = `${norm(asset.name)} ${filenameStem(asset.name)}`.trim();
    const fields = [
      { value: filenameText, weight: 1 },
      { value: `${asset.autoEditCategory || ''} ${asset.category || ''}`, weight: 0.86 },
      { value: asset.subjects, weight: 0.82 },
      { value: asset.tags, weight: 0.76 },
      { value: asset.description, weight: 0.68 },
      { value: `${asset.kind} ${asset.mimeType}`, weight: 0.5 }
    ];
    const allText = fields.map((field) => field.value).join(' ');
    if (negative.some((term) => hit(allText, term))) return null;
    const termScores = terms.map((term) => fields.reduce((best, field) => Math.max(best, hit(field.value, term) ? field.weight : 0), 0));
    const matchedFilenameTerms = terms.filter((term) => hit(filenameText, term));
    const lexical = terms.length ? termScores.reduce((sum, value) => sum + value, 0) / terms.length : 0.5;
    const filenameMatch = terms.length ? matchedFilenameTerms.length / terms.length : 0;
    const metadata = [asset.name, asset.autoEditCategory || asset.category || asset.kind, asset.description, asset.tags, asset.mimeType, asset.storageKey || asset.url]
      .reduce((score, value) => score + (value ? 1 : 0), 0) / 6;
    const duration = durationFrom(asset);
    const difference = targetDuration && duration ? Math.abs(targetDuration - duration) : null;
    const durationFit = difference === null ? 0.5 : Math.max(0, 1 - difference / Math.max(targetDuration, 1));
    const highlight = Math.max(0, Math.min(100, Number(asset.highlightScore ?? asset.highlight_score ?? 50))) / 100;
    const score = (lexical * 0.54 + filenameMatch * 0.14 + metadata * 0.12 + highlight * 0.12 + durationFit * 0.08) * 100;
    return {
      ...asset,
      relevanceScore: Math.round(score * 100) / 100,
      matchedTerms: terms.filter((term, termIndex) => termScores[termIndex] > 0),
      matchedFilenameTerms,
      durationDifference: difference === null ? null : Math.round(difference * 100) / 100,
      _index: index,
      _key: asset.sha256 || asset.id || stableUrlKey(asset.url || asset.accessUrl || '')
    };
  }).filter(Boolean);

  ranked.sort((a, b) => b.relevanceScore - a.relevanceScore || a._index - b._index);
  const seen = new Set();
  const results = [];
  for (const item of ranked) {
    if (seen.has(item._key)) continue;
    seen.add(item._key);
    const { _index, _key, ...result } = item;
    if (terms.length && (!result.matchedTerms.length || result.relevanceScore < 12)) continue;
    results.push({ ...result, recommendationRank: results.length + 1 });
    if (results.length >= plan.limit) break;
  }
  return { plan, results };
}
