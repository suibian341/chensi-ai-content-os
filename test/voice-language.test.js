import test from 'node:test';
import assert from 'node:assert/strict';

test('维吾尔语无需克隆音色即可直接调用多语言文本合成', async (t) => {
  process.env.IP_AGENT_MULTILINGUAL_TTS_API_KEY = 'test-key';
  process.env.IP_AGENT_MULTILINGUAL_TTS_ENDPOINT = 'https://example.test/api/v3/tts/create';
  process.env.IP_AGENT_MULTILINGUAL_TTS_MODEL = 'seed-audio-1.0-multilingual';
  t.after(() => {
    delete process.env.IP_AGENT_MULTILINGUAL_TTS_API_KEY;
    delete process.env.IP_AGENT_MULTILINGUAL_TTS_ENDPOINT;
    delete process.env.IP_AGENT_MULTILINGUAL_TTS_MODEL;
  });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(String(url), 'https://example.test/api/v3/tts/create?api_key=test-key');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'seed-audio-1.0-multilingual');
    assert.equal(body.text_prompt, 'سالام');
    assert.equal(body.audio_config.format, 'mp3');
    assert.equal(body.audio_config.sample_rate, 24_000);
    return new Response(JSON.stringify({
      audio: Buffer.from('mock-mp3').toString('base64'),
      duration: 1.5
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  const { synthesizeVoice } = await import('../backend/providers/voice.js');
  const result = await synthesizeVoice({ text: 'سالام', language: 'ug-CN' }, {});
  assert.equal(result.data.toString(), 'mock-mp3');
  assert.equal(result.mimeType, 'audio/mpeg');
  assert.equal(result.language, 'ug-CN');
  assert.equal(result.model, 'seed-audio-1.0-multilingual');
});
