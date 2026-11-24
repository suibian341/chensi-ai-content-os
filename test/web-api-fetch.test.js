import test from 'node:test';
import assert from 'node:assert/strict';

test('production browser API requests stay on the public origin', async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {
    CHENSI_API_BASE_URL: '',
    location: {
      origin: 'https://chensiai.cn',
      protocol: 'https:',
      hostname: 'chensiai.cn'
    },
    localStorage: { removeItem() {} }
  };
  try {
    const { API_BASE_URL, apiUrl } = await import(`../web/public/config.js?production-origin-test=${Date.now()}`);
    assert.equal(API_BASE_URL, 'https://chensiai.cn');
    assert.equal(apiUrl('/api/health'), 'https://chensiai.cn/api/health');
  } finally {
    globalThis.window = previousWindow;
  }
});

test('browser API requests abort at the configured deadline', async () => {
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  globalThis.window = {
    CHENSI_API_BASE_URL: '',
    location: { protocol: 'http:', hostname: 'localhost' },
    localStorage: { removeItem() {} }
  };
  globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  });
  try {
    const { apiFetch } = await import(`../web/public/config.js?timeout-test=${Date.now()}`);
    await assert.rejects(
      apiFetch('/api/slow', { timeoutMs: 10 }),
      (error) => error.code === 'REQUEST_TIMEOUT' && error.retryable === true
    );
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.window = previousWindow;
  }
});
