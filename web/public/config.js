const configuredBase = String(window.CHENSI_API_BASE_URL || '').trim();
const currentOrigin = String(window.location.origin || `${window.location.protocol}//${window.location.hostname}`).replace(/\/$/, '');
const isLocalDevelopment = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
export const API_BASE_URL = configuredBase.replace(/\/$/, '') || (isLocalDevelopment
  ? `${window.location.protocol}//${window.location.hostname}:4280`
  : currentOrigin);

// One-time migration cleanup for browsers that used the earlier Bearer-token build.
try { window.localStorage.removeItem('chensi_access_token'); } catch {}

export function setAccessToken() {}

export function clearAccessToken() {
  try { window.localStorage.removeItem('chensi_access_token'); } catch {}
}

export function apiUrl(value) {
  const url = String(value || '');
  if (!url || /^(?:https?:|blob:|data:)/i.test(url)) return url;
  if (!url.startsWith('/api/')) return url;
  return `${API_BASE_URL}${url}`;
}

export function resolveApiUrls(value) {
  if (Array.isArray(value)) return value.map(resolveApiUrls);
  if (!value || typeof value !== 'object') return typeof value === 'string' ? apiUrl(value) : value;
  return Object.fromEntries(Object.entries(value).map(([key, current]) => [key, resolveApiUrls(current)]));
}

export function createIdempotencyKey(scope = 'web') {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${String(scope).replace(/[^a-zA-Z0-9._:-]/g, '-').slice(0, 32)}:${random}`;
}

export function createApiError(response, payload = {}) {
  const code = String(payload.code || 'REQUEST_FAILED');
  const requestId = String(payload.requestId || response.headers.get('x-request-id') || '');
  const retryable = payload.retryable === true;
  const baseMessage = String(payload.message || payload.error || '请求失败');
  let action = '';
  if (retryable) action = '可稍后重试。';
  else if (code === 'AUTH_REQUIRED' || code === 'ADMIN_REQUIRED') action = '请重新登录。';
  else if (/_NOT_CONFIGURED$|_NOT_ENABLED$|_MODEL_UNAVAILABLE$|SPEECH_LANGUAGE_DISABLED/.test(code)) action = '请联系管理员完成能力配置。';
  else if (/QUOTA|INSUFFICIENT_POINTS/.test(code)) action = '请联系负责人调整额度。';
  const message = [baseMessage, action, requestId ? `请求编号：${requestId}` : ''].filter(Boolean).join(' ');
  return Object.assign(new Error(message), { code, requestId, retryable, status: response.status, payload });
}

function controlIdentifierPart(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

export function ensureControlIdentities(root = document) {
  const selector = 'input, select, textarea';
  const controls = [
    ...(root.matches?.(selector) ? [root] : []),
    ...(root.querySelectorAll?.(selector) || [])
  ];
  controls.forEach((control) => {
    if (!control.id) {
      const scopeNode = control.closest('[data-team-member], [data-package-row], [data-admin-ticket], [data-custom-request], [data-copy-rule], [data-user-id], [data-organization-id]');
      const scope = scopeNode ? Object.values(scopeNode.dataset).find(Boolean) : '';
      const dataKey = Object.keys(control.dataset || {})[0] || '';
      const hint = [dataKey, scope, control.value || control.getAttribute('aria-label') || control.type || control.tagName].map(controlIdentifierPart).filter(Boolean).join('-') || control.tagName.toLowerCase();
      const base = `control-${hint}`;
      let candidate = base;
      let suffix = 2;
      while (document.getElementById(candidate) && document.getElementById(candidate) !== control) candidate = `${base}-${suffix++}`;
      control.id = candidate;
    }
    if (!control.name) control.name = control.id;
  });
}

export function apiFetch(pathname, options = {}) {
  const { timeoutMs: requestedTimeoutMs, signal: callerSignal, ...requestOptions } = options;
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const method = String(options.method || 'GET').toUpperCase();
  const requested = Number(requestedTimeoutMs);
  const timeoutMs = Number.isFinite(requested) && requested > 0
    ? requested
    : ['GET', 'HEAD', 'OPTIONS'].includes(method) ? 30_000 : 120_000;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !headers['Idempotency-Key']) {
    headers['Idempotency-Key'] = createIdempotencyKey(method.toLowerCase());
  }
  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) forwardAbort();
  else callerSignal?.addEventListener('abort', forwardAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return fetch(apiUrl(pathname), {
    ...requestOptions,
    credentials: 'include',
    headers,
    signal: controller.signal
  }).catch((error) => {
    if (!timedOut) throw error;
    throw Object.assign(new Error('请求超时，请稍后重试'), { name: 'TimeoutError', code: 'REQUEST_TIMEOUT', retryable: true });
  }).finally(() => {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', forwardAbort);
  });
}
