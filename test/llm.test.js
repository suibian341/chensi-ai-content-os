import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateStructured, responsesBody } from '../backend/providers/llm.js';

test('Ark Responses request carries the real input video', () => {
  const body = responsesBody({ model: 'doubao-seed-evolving' }, {
    system: 'test',
    input: { title: 'demo' },
    schema: { timeline: [] },
    video: { url: 'data:video/mp4;base64,AAAA', fps: 2 }
  });
  assert.equal(body.input[0].content[0].type, 'input_video');
  assert.equal(body.input[0].content[0].video_url, 'data:video/mp4;base64,AAAA');
  assert.equal(body.input[0].content[1].type, 'input_text');
  assert.equal(body.text.format.type, 'json_object');
});

test('text tasks use dedicated GPT while video tasks remain on Ark', async (t) => {
  const names = [
    'IP_AGENT_LLM_BASE_URL', 'IP_AGENT_LLM_API_KEY', 'IP_AGENT_LLM_MODEL',
    'IP_AGENT_TEXT_LLM_BASE_URL', 'IP_AGENT_TEXT_LLM_API_KEY', 'IP_AGENT_TEXT_LLM_MODEL'
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => names.forEach((name) => previous[name] === undefined ? delete process.env[name] : process.env[name] = previous[name]));

  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(raw) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ output_text: JSON.stringify({ value: 'ok' }) }));
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

  await generateStructured({ purpose: 'copywriting', system: 'text', input: {}, schema: { value: 'string' }, required: ['value'] });
  await generateStructured({
    purpose: 'benchmark', system: 'video', input: {}, schema: { value: 'string' }, required: ['value'],
    video: { url: 'data:video/mp4;base64,AAAA', fps: 2 }
  });

  assert.equal(requests[0].url, '/openai/v1/responses');
  assert.equal(requests[0].authorization, 'Bearer gpt-key');
  assert.equal(requests[0].body.model, 'gpt-5.6-sol');
  assert.equal(requests[0].body.input[0].content[0].type, 'input_text');
  assert.equal(requests[1].url, '/ark/v1/responses');
  assert.equal(requests[1].authorization, 'Bearer ark-key');
  assert.equal(requests[1].body.model, 'doubao-seed-evolving');
  assert.equal(requests[1].body.input[0].content[0].type, 'input_video');
});
