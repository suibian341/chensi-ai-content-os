import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { assessCompliance, assessOriginality, generateCopy, generatePositioning, replaceComplianceTerms } from '../backend/providers/content.js';

const project = {
  name: '测试项目',
  industry: '家居',
  purpose: '获客',
  profile: { identity: '家居主理人', products: '定制家具', customers: '装修业主', painPoints: '预算不透明' },
  positioning: null
};

function withoutLlm(t) {
  const names = ['IP_AGENT_LLM_BASE_URL', 'IP_AGENT_LLM_API_KEY', 'IP_AGENT_LLM_MODEL', 'VOLCENGINE_ARK_BASE_URL', 'VOLCENGINE_ARK_API_KEY', 'VOLCENGINE_ARK_MODEL'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  names.forEach((name) => { delete process.env[name]; });
  t.after(() => names.forEach((name) => previous[name] === undefined ? delete process.env[name] : process.env[name] = previous[name]));
}

test('content provider is unavailable without a configured model and creates no fallback', async (t) => {
  withoutLlm(t);
  await assert.rejects(() => generatePositioning(project), (error) => error.code === 'LLM_NOT_CONFIGURED' && error.status === 503);
  await assert.rejects(() => generateCopy(project, null), (error) => error.code === 'LLM_NOT_CONFIGURED' && error.status === 503);
});

test('configured OpenAI-compatible provider is used and parsed', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ persona: '真实主理人', promise: '把选择讲清楚', contentAngles: ['案例'], searchTerms: ['定制家具'], targetAccounts: ['行业账号'] }) } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const previous = { base: process.env.IP_AGENT_LLM_BASE_URL, model: process.env.IP_AGENT_LLM_MODEL };
  process.env.IP_AGENT_LLM_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.IP_AGENT_LLM_MODEL = 'test-model';
  t.after(() => {
    previous.base === undefined ? delete process.env.IP_AGENT_LLM_BASE_URL : process.env.IP_AGENT_LLM_BASE_URL = previous.base;
    previous.model === undefined ? delete process.env.IP_AGENT_LLM_MODEL : process.env.IP_AGENT_LLM_MODEL = previous.model;
  });

  const result = await generatePositioning(project);
  assert.equal(result.meta.provider, 'openai-compatible');
  assert.equal(Object.hasOwn(result.meta, 'fallback'), false);
  assert.equal(result.data.persona, '真实主理人');
});

test('qa copy mode requests an alternating script without fallback', async (t) => {
  let requestBody;
  const server = http.createServer(async (req, res) => {
    requestBody = JSON.parse(await new Promise((resolve) => { let value = ''; req.on('data', (chunk) => { value += chunk; }); req.on('end', () => resolve(value)); }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ mode: 'qa', coverTitle: '真实标题', publishTitle: '真实发布标题', script: '标准稿', qaScript: ['Q：用户问题', 'A：基于资料的回答'], tags: ['真实标签'], shots: ['真实分镜'], avatarDirection: '自然表达', assetSuggestions: ['真实素材'] }) } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const previous = { base: process.env.IP_AGENT_LLM_BASE_URL, model: process.env.IP_AGENT_LLM_MODEL };
  process.env.IP_AGENT_LLM_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.IP_AGENT_LLM_MODEL = 'test-model';
  t.after(() => {
    previous.base === undefined ? delete process.env.IP_AGENT_LLM_BASE_URL : process.env.IP_AGENT_LLM_BASE_URL = previous.base;
    previous.model === undefined ? delete process.env.IP_AGENT_LLM_MODEL : process.env.IP_AGENT_LLM_MODEL = previous.model;
  });

  const result = await generateCopy(project, null, { mode: 'qa' });
  assert.equal(result.data.qaScript[0], 'Q：用户问题');
  assert.match(String(requestBody.messages?.[0]?.content || ''), /问答式/);
});

test('copy generation sends selected real benchmark analyses and records their references', async (t) => {
  let requestBody;
  const server = http.createServer(async (req, res) => {
    requestBody = JSON.parse(await new Promise((resolve) => { let value = ''; req.on('data', (chunk) => { value += chunk; }); req.on('end', () => resolve(value)); }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ mode: 'standard', coverTitle: '原创封面', publishTitle: '原创发布', script: '基于真实拆解方法重新组织的原创口播稿。', qaScript: [], tags: ['原创'], shots: ['真实分镜'], avatarDirection: '自然表达', assetSuggestions: ['现场素材'] }) } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const previous = { base: process.env.IP_AGENT_LLM_BASE_URL, model: process.env.IP_AGENT_LLM_MODEL };
  process.env.IP_AGENT_LLM_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.IP_AGENT_LLM_MODEL = 'test-model';
  t.after(() => {
    previous.base === undefined ? delete process.env.IP_AGENT_LLM_BASE_URL : process.env.IP_AGENT_LLM_BASE_URL = previous.base;
    previous.model === undefined ? delete process.env.IP_AGENT_LLM_MODEL : process.env.IP_AGENT_LLM_MODEL = previous.model;
  });

  const reference = {
    id: 'benchmark-real-1', status: 'analyzed', analysisVersion: 'multimodal-v1', title: '真实拆解视频', sourceUrl: 'https://www.douyin.com/video/1',
    analysis: { topic: '预算误区', hook: '先问一个问题', structure: '问题-解释-建议', keyLines: ['先看清楚'], timeline: [{ start: 0, end: 3, visual: '人物出镜', speech: '先问问题' }], evidence: ['0-3 秒提出问题'] }
  };
  const result = await generateCopy(project, reference, { benchmarkReferences: [reference] });
  const prompt = String(requestBody.messages?.[1]?.content || '');
  assert.match(prompt, /benchmarkReferences/);
  assert.match(prompt, /真实拆解视频/);
  assert.deepEqual(result.data.referenceBenchmarks, [{ id: 'benchmark-real-1', title: '真实拆解视频', sourceUrl: 'https://www.douyin.com/video/1' }]);
});

test('compliance rules flag absolute claims', () => {
  const result = assessCompliance('这是全网最好的方案，保证永久有效');
  assert.equal(result.riskLevel, 'review');
  assert.ok(result.hits.length >= 2);
});

test('compliance rules ignore procedural ordinals but retain real promotional claims', () => {
  const result = assessCompliance('第一步先核对资料，再说明我们不是行业第一。');
  assert.equal(result.ruleVersion, 'context-v2');
  assert.equal(result.ignoredHits.some((item) => item.term === '第一' && item.context.includes('第一步')), true);
  assert.equal(result.hits.some((item) => item.term === '第一' && item.context.includes('行业第一')), true);
  assert.equal(result.manualReviewRequired, true);
});

test('compliance replacement updates only flagged terms across displayed copy fields', () => {
  const result = replaceComplianceTerms({
    coverTitle: '第一步先核对资料',
    publishTitle: '行业第一的方案',
    script: '这是最好的方案，保证永久有效。',
    tags: ['更适合', '零风险'],
    shots: ['展示最强的卖点'],
    avatarDirection: '保持专业表达',
    assetSuggestions: ['用真实案例说明']
  });
  assert.equal(result.copy.coverTitle, '第一步先核对资料');
  assert.equal(result.copy.publishTitle, '行业优先的方案');
  assert.equal(result.copy.script, '这是更适合的方案，力求在适用期内有效。');
  assert.deepEqual(result.copy.tags, ['更适合', '需评估风险']);
  assert.deepEqual(result.copy.shots, ['展示更值得关注的卖点']);
  assert.equal(result.replaced.length, 6);
  assert.equal(result.copy.compliance.riskLevel, 'pass');
});

test('custom compliance rules return positions and actionable suggestions', () => {
  const result = assessCompliance('这个方案当天见效，但仍需按实际情况执行。', {
    rules: [{ id: 'custom', category: '效果时限', terms: ['当天见效'], suggestion: '说明依据和适用条件', enabled: true }]
  });
  assert.equal(result.checkedRuleCount, 1);
  assert.equal(result.hits[0].start, 4);
  assert.equal(result.hits[0].suggestion, '说明依据和适用条件');
});

test('local originality check compares against saved copy history', () => {
  const current = { publishTitle: '装修预算怎么做', script: '装修预算不要只看总价，先把柜体、五金和安装分别列清楚。' };
  const history = [
    { id: 'copy-1', title: '历史文案', content: { publishTitle: '装修预算怎么做', script: '装修预算不要只看总价，先把柜体、五金和安装分别列清楚。' } },
    { id: 'copy-2', title: '其他文案', content: { script: '今天介绍木材含水率。' } }
  ];
  const result = assessOriginality(current, history);
  assert.equal(result.checkedCount, 2);
  assert.equal(result.riskLevel, 'review');
  assert.equal(result.matches[0].copyId, 'copy-1');
  assert.ok(result.maxSimilarity > 0.8);
});

test('local originality threshold is configurable', () => {
  const current = { script: '这是一段有少量重合但并不完全相同的测试文案。' };
  const history = [{ id: 'copy-1', content: { script: '这是一段有少量重合的历史文案。' } }];
  const strict = assessOriginality(current, history, { threshold: 0.1, repeatedPhraseMinLength: 100 });
  const relaxed = assessOriginality(current, history, { threshold: 0.99, repeatedPhraseMinLength: 100 });
  assert.equal(strict.riskLevel, 'review');
  assert.equal(relaxed.riskLevel, 'pass');
});
