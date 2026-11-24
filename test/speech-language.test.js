import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { prepareSpeechScript } from '../backend/providers/speech-language.js';

test('Mandarin speech keeps the source text without requiring an LLM', async () => {
  const result = await prepareSpeechScript({ script: '保留这段真实口播。', language: 'zh-CN', languageLabel: '普通话' });
  assert.equal(result.sourceText, '保留这段真实口播。');
  assert.equal(result.speechText, result.sourceText);
  assert.equal(result.transformed, false);
  assert.equal(result.translationProvider, null);
});

test('English speech uses the configured model and returns a production script', async (t) => {
  let requestBody;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ text: 'Keep every real product fact.' }) } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const previous = { base: process.env.IP_AGENT_LLM_BASE_URL, model: process.env.IP_AGENT_LLM_MODEL };
  process.env.IP_AGENT_LLM_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
  process.env.IP_AGENT_LLM_MODEL = 'translation-test-model';
  t.after(() => {
    previous.base === undefined ? delete process.env.IP_AGENT_LLM_BASE_URL : process.env.IP_AGENT_LLM_BASE_URL = previous.base;
    previous.model === undefined ? delete process.env.IP_AGENT_LLM_MODEL : process.env.IP_AGENT_LLM_MODEL = previous.model;
  });

  const result = await prepareSpeechScript({ script: '保留每一条真实产品信息。', language: 'en-US', languageLabel: '英语' });
  assert.equal(result.speechText, 'Keep every real product fact.');
  assert.equal(result.transformed, true);
  assert.equal(result.transformMode, 'translate');
  assert.equal(result.translationModel, 'translation-test-model');
  assert.match(JSON.stringify(requestBody), /natural, concise American English/);
});
