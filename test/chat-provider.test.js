import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateChatReply } from '../backend/providers/chat.js';

function preserveEnvironment(t, names) {
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => names.forEach((name) => previous[name] === undefined ? delete process.env[name] : process.env[name] = previous[name]));
}

test('chat inherits the existing API key while allowing a lower-cost model', async (t) => {
  const names = ['IP_AGENT_LLM_BASE_URL', 'IP_AGENT_LLM_API_KEY', 'IP_AGENT_CHAT_BASE_URL', 'IP_AGENT_CHAT_API_KEY', 'IP_AGENT_CHAT_MODEL'];
  preserveEnvironment(t, names);
  let received;
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    received = { url: req.url, authorization: req.headers.authorization, body: JSON.parse(raw) };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '结合当前项目，建议先完成客户画像。' } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  process.env.IP_AGENT_LLM_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.IP_AGENT_LLM_API_KEY = 'existing-volcengine-key';
  delete process.env.IP_AGENT_CHAT_BASE_URL;
  delete process.env.IP_AGENT_CHAT_API_KEY;
  process.env.IP_AGENT_CHAT_MODEL = 'doubao-seed-1-6-flash-250715';

  const result = await generateChatReply({
    system: '你是项目顾问。项目：测试餐饮。',
    messages: [{ role: 'user', content: '上一轮问题' }, { role: 'assistant', content: '上一轮回答' }],
    message: '我下一步做什么？'
  });

  assert.equal(received.url, '/v1/chat/completions');
  assert.equal(received.authorization, 'Bearer existing-volcengine-key');
  assert.equal(received.body.model, 'doubao-seed-1-6-flash-250715');
  assert.match(received.body.messages[0].content, /项目顾问/);
  assert.equal(result.data.content, '结合当前项目，建议先完成客户画像。');
  assert.equal(result.meta.model, 'doubao-seed-1-6-flash-250715');
});

test('chat supports Ark Responses endpoints', async (t) => {
  const names = ['IP_AGENT_LLM_BASE_URL', 'IP_AGENT_LLM_API_KEY', 'IP_AGENT_CHAT_BASE_URL', 'IP_AGENT_CHAT_API_KEY', 'IP_AGENT_CHAT_MODEL'];
  preserveEnvironment(t, names);
  let received;
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    received = { url: req.url, body: JSON.parse(raw) };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ output: [{ content: [{ type: 'output_text', text: '这是项目上下文回答。' }] }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  process.env.IP_AGENT_CHAT_BASE_URL = `http://127.0.0.1:${address.port}/api/v3/responses`;
  process.env.IP_AGENT_CHAT_API_KEY = 'chat-key';
  process.env.IP_AGENT_CHAT_MODEL = 'test-ark-model';

  const result = await generateChatReply({ system: '系统预设', messages: [], message: '你好' });

  assert.equal(received.url, '/api/v3/responses');
  assert.equal(received.body.store, false);
  assert.equal(received.body.max_output_tokens, 2048);
  assert.deepEqual(received.body.reasoning, { effort: 'minimal' });
  assert.match(received.body.input[0].content[0].text, /系统预设/);
  assert.equal(result.data.content, '这是项目上下文回答。');
  assert.equal(result.meta.provider, 'volcengine-ark-responses');
});

test('chat follows the dedicated GPT text model when no chat override is set', async (t) => {
  const names = [
    'IP_AGENT_LLM_BASE_URL', 'IP_AGENT_LLM_API_KEY', 'IP_AGENT_LLM_MODEL',
    'IP_AGENT_TEXT_LLM_BASE_URL', 'IP_AGENT_TEXT_LLM_API_KEY', 'IP_AGENT_TEXT_LLM_MODEL',
    'IP_AGENT_CHAT_BASE_URL', 'IP_AGENT_CHAT_API_KEY', 'IP_AGENT_CHAT_MODEL'
  ];
  preserveEnvironment(t, names);
  let received;
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    received = { url: req.url, authorization: req.headers.authorization, body: JSON.parse(raw) };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ output_text: 'GPT text reply' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  process.env.IP_AGENT_LLM_BASE_URL = `http://127.0.0.1:${address.port}/ark/v1/responses`;
  process.env.IP_AGENT_LLM_API_KEY = 'ark-key';
  process.env.IP_AGENT_LLM_MODEL = 'doubao-seed-evolving';
  process.env.IP_AGENT_TEXT_LLM_BASE_URL = `http://127.0.0.1:${address.port}/openai/v1`;
  process.env.IP_AGENT_TEXT_LLM_API_KEY = 'gpt-key';
  process.env.IP_AGENT_TEXT_LLM_MODEL = 'gpt-5.6-sol';
  delete process.env.IP_AGENT_CHAT_BASE_URL;
  delete process.env.IP_AGENT_CHAT_API_KEY;
  delete process.env.IP_AGENT_CHAT_MODEL;

  const result = await generateChatReply({ system: 'project assistant', messages: [], message: 'give one suggestion' });

  assert.equal(received.url, '/openai/v1/responses');
  assert.equal(received.authorization, 'Bearer gpt-key');
  assert.equal(received.body.model, 'gpt-5.6-sol');
  assert.equal(result.data.content, 'GPT text reply');
  assert.equal(result.meta.provider, 'openai-responses');
});

test('chat maps an unavailable model to an actionable configuration error', async (t) => {
  const names = ['IP_AGENT_LLM_BASE_URL', 'IP_AGENT_LLM_API_KEY', 'IP_AGENT_CHAT_BASE_URL', 'IP_AGENT_CHAT_API_KEY', 'IP_AGENT_CHAT_MODEL'];
  preserveEnvironment(t, names);
  const server = http.createServer(async (_req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'InvalidEndpointOrModel.NotFound', message: 'The model does not exist' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  process.env.IP_AGENT_CHAT_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.IP_AGENT_CHAT_API_KEY = 'chat-key';
  process.env.IP_AGENT_CHAT_MODEL = 'missing-model';

  await assert.rejects(
    () => generateChatReply({ system: '系统预设', messages: [], message: '你好' }),
    (error) => error.code === 'CHAT_MODEL_UNAVAILABLE' && error.status === 503 && /missing-model/.test(error.message)
  );
});
