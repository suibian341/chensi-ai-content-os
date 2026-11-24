import { generateStructured } from './llm.js';
import { ProviderError } from '../lib/http.js';

export const DEFAULT_COMPLIANCE_RULES = [
  { id: 'absolute_claims', category: '绝对化宣传', terms: ['最好', '最强', '最高', '最低', '最便宜', '第一', '唯一', '百分之百', '绝对'], suggestion: '改为有事实依据的范围、条件或相对表述', enabled: true },
  { id: 'effect_promises', category: '效果承诺', terms: ['保证', '包治', '根治', '稳赚', '零风险', '永久有效'], suggestion: '删除无法证明的效果承诺，并补充适用条件', enabled: true },
  { id: 'engagement_bait', category: '诱导互动', terms: ['私信领', '评论区扣', '点赞过万', '转发抽奖'], suggestion: '改为符合发布平台规则的正常互动引导', enabled: true }
];

export const DEFAULT_COMPLIANCE_REPLACEMENTS = Object.freeze({
  '最好': '更适合',
  '最强': '更值得关注',
  '最高': '较高',
  '最低': '较低',
  '最便宜': '更具性价比',
  '第一': '优先',
  '唯一': '特别',
  '百分之百': '尽可能',
  '绝对': '明确',
  '保证': '力求',
  '包治': '帮助改善',
  '根治': '缓解',
  '稳赚': '需评估收益',
  '零风险': '需评估风险',
  '永久有效': '在适用期内有效',
  '私信领': '私信了解',
  '评论区扣': '评论区留言',
  '点赞过万': '欢迎点赞',
  '转发抽奖': '参与活动'
});

const COMPLIANCE_RULE_VERSION = 'context-v2';

function contextualExemption(source, term, start, end, ruleId) {
  if (ruleId !== 'absolute_claims') return '';
  const after = source.slice(end, end + 12);
  const contextSuffixes = {
    '第一': /^(步|次|阶段|部分|章节|章|条|项|点|轮|期|页|集|人称|季度|天|周|月|年)/,
    '唯一': /^(标识|编号|键|上级|ID|Id|id|索引|约束)/,
    '最高': /^(人民法院|人民检察院|气温|温度|海拔|时速|限额|上限)/,
    '最低': /^(气温|温度|工资|限额|下限|起订量)/,
    '绝对': /^(值|路径|误差|坐标)/
  };
  if (contextSuffixes[term]?.test(after)) return '上下文表明这是顺序、专有名词或客观字段，并非宣传性断言';
  if (term === '最好' && /^(先|再|不要|避免|考虑|检查)/.test(after)) return '上下文表明这是操作建议，并非“最佳”宣传断言';
  return '';
}

function normalizedComplianceRules(rules) {
  const source = Array.isArray(rules) && rules.length ? rules : DEFAULT_COMPLIANCE_RULES;
  return source.filter((rule) => rule?.enabled !== false).map((rule, index) => ({
    id: String(rule?.id || `rule_${index + 1}`),
    category: String(rule?.category || '自定义风险词').trim() || '自定义风险词',
    terms: [...new Set((Array.isArray(rule?.terms) ? rule.terms : []).map((term) => String(term).trim()).filter(Boolean))],
    suggestion: String(rule?.suggestion || '请根据平台规则人工复核并修改').trim()
  })).filter((rule) => rule.terms.length);
}

export function assessCompliance(text, options = {}) {
  const source = String(text || '');
  const rules = normalizedComplianceRules(options.rules);
  const hits = [];
  const ignoredHits = [];
  for (const rule of rules) {
    for (const term of rule.terms) {
      let start = source.indexOf(term);
      while (start >= 0) {
        const end = start + term.length;
        const exemptionReason = contextualExemption(source, term, start, end, rule.id);
        const hit = {
          ruleId: rule.id,
          category: rule.category,
          term,
          start,
          end,
          context: source.slice(Math.max(0, start - 12), Math.min(source.length, end + 12)),
          suggestion: rule.suggestion
        };
        if (exemptionReason) ignoredHits.push({ ...hit, exemptionReason });
        else hits.push(hit);
        start = source.indexOf(term, end);
      }
    }
  }
  hits.sort((a, b) => a.start - b.start || b.term.length - a.term.length);
  return {
    scope: 'configured-local-rules',
    ruleVersion: COMPLIANCE_RULE_VERSION,
    checkedRuleCount: rules.reduce((count, rule) => count + rule.terms.length, 0),
    riskLevel: hits.length ? 'review' : 'pass',
    manualReviewRequired: hits.length > 0,
    hits,
    ignoredHits
  };
}

function copyTextFields(copy = {}) {
  const fields = [];
  const addValue = (key) => {
    if (!copy[key]) return;
    fields.push({
      value: String(copy[key]),
      set(nextValue) { copy[key] = nextValue; }
    });
  };
  const addList = (key) => {
    if (!Array.isArray(copy[key])) return;
    copy[key].forEach((value, index) => {
      if (!value) return;
      fields.push({
        value: String(value),
        set(nextValue) { copy[key][index] = nextValue; }
      });
    });
  };

  addValue('coverTitle');
  addValue('publishTitle');
  addValue('script');
  addList('qaScript');
  addList('tags');
  addList('shots');
  addValue('avatarDirection');
  addList('assetSuggestions');
  return fields;
}

function copyText(copy = {}) {
  return copyTextFields(copy).map((field) => field.value).join('\n');
}

export function replaceComplianceTerms(copy, options = {}) {
  const target = structuredClone(copy || {});
  const replacementMap = { ...DEFAULT_COMPLIANCE_REPLACEMENTS, ...(options.replacements || {}) };
  const initial = assessCompliance(copyText(target), options);
  const fields = copyTextFields(target);
  let offset = 0;
  const replaced = [];
  const skipped = [];

  for (const field of fields) {
    const fieldStart = offset;
    const fieldEnd = fieldStart + field.value.length;
    const appliedRanges = [];
    const fieldHits = initial.hits
      .filter((hit) => hit.start >= fieldStart && hit.end <= fieldEnd)
      .sort((a, b) => b.start - a.start || b.end - a.end);
    let nextValue = field.value;

    for (const hit of fieldHits) {
      const replacement = String(replacementMap[hit.term] || '').trim();
      const start = hit.start - fieldStart;
      const end = hit.end - fieldStart;
      const overlaps = appliedRanges.some((range) => start < range.end && end > range.start);
      if (!replacement || overlaps) {
        skipped.push(hit);
        continue;
      }
      nextValue = `${nextValue.slice(0, start)}${replacement}${nextValue.slice(end)}`;
      appliedRanges.push({ start, end });
      replaced.push({ ...hit, replacement });
    }
    if (nextValue !== field.value) field.set(nextValue);
    offset = fieldEnd + 1;
  }

  target.compliance = assessCompliance(copyText(target), options);
  return { copy: target, replaced, skipped, compliance: target.compliance };
}

function normalizedText(value) {
  return String(value || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function shingles(value, size = 4) {
  const text = normalizedText(value);
  const result = new Set();
  for (let index = 0; index <= text.length - size; index += 1) result.add(text.slice(index, index + size));
  return result;
}

export function assessOriginality(copy, history = [], options = {}) {
  const threshold = Math.min(1, Math.max(0, Number(options.threshold ?? 0.65)));
  const repeatedPhraseMinLength = Math.min(100, Math.max(4, Math.trunc(Number(options.repeatedPhraseMinLength ?? 8))));
  const currentText = copyText(copy);
  const currentShingles = shingles(currentText);
  const matches = history.map((entry) => {
    const previousText = copyText(entry.content || entry);
    const previousShingles = shingles(previousText);
    let overlap = 0;
    for (const item of currentShingles) if (previousShingles.has(item)) overlap += 1;
    const denominator = currentShingles.size + previousShingles.size;
    return {
      copyId: entry.id || null,
      title: entry.title || entry.content?.publishTitle || entry.publishTitle || '历史文案',
      similarity: denominator ? Number((2 * overlap / denominator).toFixed(3)) : 0,
      previousText
    };
  }).sort((a, b) => b.similarity - a.similarity);
  const repeatedPhrases = [];
  const previousTexts = matches.map((item) => normalizedText(item.previousText));
  for (const sentence of currentText.split(/[。！？!?；;\n]+/).map((item) => item.trim()).filter(Boolean)) {
    const normalized = normalizedText(sentence);
    if (normalized.length >= repeatedPhraseMinLength && previousTexts.some((text) => text.includes(normalized))) repeatedPhrases.push(sentence);
  }
  return {
    scope: 'current-user-library',
    checkedCount: history.length,
    threshold,
    repeatedPhraseMinLength,
    maxSimilarity: matches[0]?.similarity || 0,
    riskLevel: (matches[0]?.similarity || 0) >= threshold || repeatedPhrases.length ? 'review' : 'pass',
    repeatedPhrases: [...new Set(repeatedPhrases)].slice(0, 10),
    matches: matches.slice(0, 5).map(({ previousText, ...item }) => item)
  };
}

export function generatePositioning(project) {
  return generateStructured({
    purpose: 'positioning',
    system: '你是国内短视频 IP 定位策略师。只能基于用户提交的真实资料生成定位表：用户身份、核心产品、目标客户、客户痛点、内容主张、差异化表达、可持续选题方向、平台搜索词和适合对标的账号类型。不得补造业绩、案例或身份，不得使用绝对化宣传。资料不足时在对应字段中明确指出需要补充的资料。平台搜索词要拆成适合抖音、小红书、视频号检索的短词，不要输出解释。',
    input: {
      project: { name: project.name, industry: project.industry, purpose: project.purpose },
      profile: project.profile || {}
    },
    schema: {
      persona: 'string',
      identity: 'string',
      coreProduct: 'string',
      targetCustomer: 'string',
      painPoints: ['string'],
      promise: 'string',
      differentiator: 'string',
      contentAngles: ['string'],
      searchTerms: ['string'],
      targetAccounts: ['string']
    },
    required: ['persona', 'promise', 'contentAngles', 'searchTerms', 'targetAccounts']
  });
}

function timelineEvidence(timeline, limit = 20) {
  const entries = (Array.isArray(timeline) ? timeline : []).filter((item) => {
    const start = Number(item?.start);
    const end = Number(item?.end);
    return Number.isFinite(start) && Number.isFinite(end) && end > start
      && [item?.visual, item?.speech, item?.role].some((value) => String(value || '').trim());
  });
  if (!entries.length) return [];
  const selected = entries.length <= limit
    ? entries
    : Array.from({ length: limit }, (_, index) => entries[Math.round(index * (entries.length - 1) / (limit - 1))]);
  return selected.map((item) => {
    const start = Math.round(Number(item.start) * 100) / 100;
    const end = Math.round(Number(item.end) * 100) / 100;
    const detail = [item.visual, item.speech].map((value) => String(value || '').trim()).filter(Boolean).join(' / ')
      || String(item.role || '').trim();
    return `[${start}-${end}s] ${detail}`;
  });
}

function shouldRetryBenchmarkProvider(error) {
  if (['PROVIDER_TIMEOUT', 'PROVIDER_UNREACHABLE'].includes(error?.code)) return true;
  return error?.code === 'PROVIDER_HTTP_ERROR'
    && (error?.retryable || /\b(?:please retry|try again)\b|稍后重试|重新尝试/i.test(String(error?.message || '')));
}

export function benchmarkSamplingFps(duration, requestedFps = 2) {
  const requested = Math.min(2, Math.max(0.25, Number(requestedFps) || 2));
  const seconds = Number(duration);
  if (!Number.isFinite(seconds) || seconds <= 0) return requested;
  if (seconds > 600) return Math.min(requested, 0.25);
  if (seconds > 300) return Math.min(requested, 0.5);
  if (seconds > 120) return Math.min(requested, 1);
  return requested;
}

async function generateBenchmarkStructured(request) {
  const baseFps = Number(request.video?.fps) || 2;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const currentRequest = request.video
      ? { ...request, video: { ...request.video, fps: Math.max(0.25, baseFps / (2 ** attempt)) } }
      : request;
    try {
      return await generateStructured(currentRequest);
    } catch (error) {
      const timeoutRetryExhausted = ['PROVIDER_TIMEOUT', 'PROVIDER_UNREACHABLE'].includes(error?.code) && attempt >= 1;
      if (!shouldRetryBenchmarkProvider(error) || attempt >= 2 || timeoutRetryExhausted) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 750 : 2_000));
    }
  }
  throw new ProviderError('BENCHMARK_ANALYSIS_FAILED', '视频拆解失败，请重新尝试');
}

export async function analyzeBenchmark(project, benchmark, cutAnalysis = null, video = null) {
  const hasVideo = Boolean(video?.url || video?.data?.length);
  const benchmarkVideo = hasVideo
    ? { ...video, fps: benchmarkSamplingFps(cutAnalysis?.duration, video?.fps) }
    : null;
  const result = await generateBenchmarkStructured({
    purpose: 'benchmark',
    system: hasVideo
      ? '你是短视频多模态拆解分析师。你已收到实际视频，必须完整观看并以可见画面、画面文字、人物动作和可辨识口播为证据，拆解选题、开头钩子、内容结构、关键表达、情绪触发、信任建立和转化逻辑。timeline 要从 0 秒开始连续覆盖到视频结束，在画面、话题或动作实际变化时分段，最多 80 段；长视频应合并内容相近的连续片段。每段 visual、speech、role 都必须简洁，单字段不超过 80 个汉字。speech 只记录真正听到或能从字幕确认的内容；无法确认原话时写内容概括，不得虚构台词、身份、品牌、播放量或互动数据。evidence 最多 20 条，每条必须引用具体时间段。不要输出“待补充真实证据”这类占位文字。所有字符串必须正确进行 JSON 转义。'
      : '你是短视频结构分析师。当前没有收到可读取的视频本体，不得根据文件名、时长或项目资料猜测视频内容。',
    input: {
      project: { industry: project.industry, purpose: project.purpose, profile: project.profile || {} },
      benchmark: { url: benchmark.url, platform: benchmark.platform, title: benchmark.title },
      mediaAnalysis: cutAnalysis ? {
        duration: cutAnalysis.duration,
        keepSegments: cutAnalysis.keep_segments,
        breathGaps: cutAnalysis.breath_gaps,
        sceneChanges: cutAnalysis.scene_changes,
        shots: cutAnalysis.shots,
        summary: cutAnalysis.summary
      } : null
    },
    schema: {
      topic: 'string',
      hook: 'string',
      structure: 'string',
      keyLines: ['string'],
      trigger: 'string',
      trust: 'string',
      conversion: 'string',
      coverTitle: 'string',
      publishTitle: 'string',
      tags: ['string'],
      transcriptSummary: 'string',
      timeline: [{
        start: 0,
        end: 0,
        visual: 'string',
        speech: 'string',
        role: 'string'
      }],
      evidence: ['string']
    },
    required: ['topic', 'hook', 'structure', 'trigger', 'conversion', 'timeline'],
    video: benchmarkVideo
  });
  if (hasVideo) {
    const returnedEvidence = Array.isArray(result.data.evidence)
      ? result.data.evidence.map((item) => String(item || '').trim()).filter(Boolean)
      : String(result.data.evidence || '').trim() ? [String(result.data.evidence).trim()] : [];
    result.data.evidence = returnedEvidence.length ? returnedEvidence : timelineEvidence(result.data.timeline);
    const serialized = JSON.stringify(result.data);
    if (serialized.includes('待补充真实证据') || serialized.includes('无法识别') || !result.data.timeline?.length || !result.data.evidence?.length) {
      throw new ProviderError('PROVIDER_EVIDENCE_MISSING', '模型没有返回可核验的时间轴和视频证据，请重新拆解', { retryable: true });
    }
  }
  return result;
}

export function analyzeAccount(project, input = {}) {
  const samples = (input.samples || []).map((item) => ({
    title: item.title,
    sourceUrl: item.sourceUrl || item.url,
    topic: item.analysis?.topic,
    hook: item.analysis?.hook,
    structure: item.analysis?.structure,
    keyLines: item.analysis?.keyLines,
    trigger: item.analysis?.trigger,
    trust: item.analysis?.trust,
    conversion: item.analysis?.conversion,
    coverTitle: item.analysis?.coverTitle,
    publishTitle: item.analysis?.publishTitle,
    tags: item.analysis?.tags,
    transcriptSummary: item.analysis?.transcriptSummary
  }));
  const publicPosts = (input.posts || []).slice(0, 20).map((item) => ({
    title: String(item.title || '').slice(0, 200),
    duration: Number(item.duration || 0) || null,
    diggCount: Number(item.diggCount || 0) || 0,
    commentCount: Number(item.commentCount || 0) || 0,
    shareCount: Number(item.shareCount || 0) || 0
  }));
  return generateStructured({
    purpose: 'account-analysis',
    system: '你是短视频账号策略分析师。只能聚合输入中明确提供的公开作品资料和已完成真实视频拆解的样本，不得声称读取了账号后台、粉丝量、播放量或未提供的视频。publicPosts 中的标题、时长和公开互动数据可以用于判断内容方向，但叙事结构、语言风格和视觉呈现必须优先以 samples 的真实拆解证据为准。请总结账号定位、受众、内容支柱、常用钩子、叙事结构、语言风格、视觉呈现、信任方式、转化方式和可复用公式。每个关键结论都要给出对应作品标题作为证据。样本不足时必须在 limitations 中说明。',
    input: {
      account: String(input.account || '').trim(),
      profile: input.profile || {},
      project: { name: project.name, industry: project.industry, purpose: project.purpose },
      publicPosts,
      samples
    },
    schema: {
      positioning: 'string',
      audience: 'string',
      contentPillars: ['string'],
      hookPatterns: ['string'],
      structurePatterns: ['string'],
      languageStyle: 'string',
      visualStyle: 'string',
      trustPatterns: ['string'],
      conversionPatterns: ['string'],
      reusableFormula: 'string',
      evidence: ['string'],
      limitations: ['string']
    },
    required: ['positioning', 'contentPillars', 'hookPatterns', 'structurePatterns', 'reusableFormula', 'evidence', 'limitations']
  });
}

export async function generateCopy(project, benchmark, options = {}) {
  const mode = options.mode === 'qa' ? 'qa' : 'standard';
  const draft = String(options.draft || '').trim().slice(0, 8_000);
  const benchmarkReferences = (Array.isArray(options.benchmarkReferences) ? options.benchmarkReferences : benchmark ? [benchmark] : [])
    .filter((item) => item && item.status === 'analyzed' && item.analysisVersion === 'multimodal-v1' && item.analysis)
    .slice(0, 5)
    .map((item) => ({
      id: item.id || null,
      title: String(item.title || item.analysis?.publishTitle || '真实拆解样本').slice(0, 120),
      sourceUrl: String(item.sourceUrl || item.url || '').slice(0, 500),
      analysis: item.analysis
    }));
  const primaryBenchmark = benchmarkReferences[0] || null;
  const styleReferences = (options.styleReferences || []).slice(0, 5).map((item) => ({
    title: String(item.title || item.content?.publishTitle || '历史文案').slice(0, 120),
    text: copyText(item.content || item).slice(0, 2_000)
  })).filter((item) => item.text);
  const result = await generateStructured({
    purpose: 'copywriting',
    system: `你是国内短视频原创文案策划。只能使用项目中明确提供的产品、客户、案例和定位信息。可借鉴对标视频的主题、钩子、叙事结构、关键表达节奏和转化方法，但不能复用连续原句。benchmarkReferences 是已完成真实视频拆解的证据集合：有多条时优先归纳其共同方法，不得把某一条视频的原话、事实或案例移植到新文案。历史文案只用于学习句长、语气和表达节奏，不得照抄。提供半成品时，应保留其中明确事实并续写成完整文案。优先把用户自己的素材写入分镜和素材建议。不得补造数据、客户案例、资质或效果承诺。资料不足时明确标注待补充内容。当前文案模式：${mode === 'qa' ? '问答式。必须输出 mode="qa"，qaScript 至少 2 行，严格按 Q：主持人问题、A：数字人回答交替排列；有足够内容时输出 4 行以上。script 可为空。不要把问答内容只放在 script。' : '标准口播。必须输出 mode="standard"，script 是一段可以直接连续朗读的单人口播稿；qaScript 必须为空数组，不要写主持人提问。'}`,
    input: {
      project: { name: project.name, industry: project.industry, purpose: project.purpose },
      profile: project.profile || {},
      positioning: project.positioning || {},
       benchmark: primaryBenchmark ? { title: primaryBenchmark.title, analysis: primaryBenchmark.analysis } : null,
       benchmarkReferences,
      halfFinishedDraft: draft || null,
      historicalStyleReferences: styleReferences,
      ownAssets: (project.assets || []).slice(0, 50).map((item) => ({ name: item.name, kind: item.kind, description: item.description, tags: item.tags }))
    },
    schema: {
      mode: 'string',
      coverTitle: 'string',
      publishTitle: 'string',
      script: 'string',
      qaScript: ['string'],
      tags: ['string'],
      shots: ['string'],
      avatarDirection: 'string',
      assetSuggestions: ['string']
    },
    required: ['coverTitle', 'publishTitle', 'script', 'tags', 'shots']
  });
  result.data.mode = mode;
  if (mode === 'qa' && (!Array.isArray(result.data.qaScript) || result.data.qaScript.length < 2)) {
    throw new ProviderError('COPY_MODE_SCHEMA_MISMATCH', '问答模式没有返回 Q/A 交替脚本，请重新生成', { retryable: true });
  }
  if (mode === 'standard' && !String(result.data.script || '').trim()) {
    throw new ProviderError('COPY_MODE_SCHEMA_MISMATCH', '标准口播模式没有返回纯口播稿，请重新生成', { retryable: true });
  }
  if (options.inheritBenchmarkTitle && primaryBenchmark?.analysis) {
    result.data.coverTitle = String(primaryBenchmark.analysis.coverTitle || result.data.coverTitle || '').trim();
    result.data.publishTitle = String(primaryBenchmark.analysis.publishTitle || primaryBenchmark.title || result.data.publishTitle || '').trim();
  }
  result.data.referenceBenchmarks = benchmarkReferences.map((item) => ({ id: item.id, title: item.title, sourceUrl: item.sourceUrl }));
  result.data.compliance = assessCompliance(copyText(result.data), options.copyCheckConfig || {});
  return result;
}
