import { apiFetch, createApiError, setAccessToken } from './config.js';

const $ = (selector) => document.querySelector(selector);
let setupMode = false;

async function request(url, options = {}) {
  const response = await apiFetch(url, options);
  const payload = await response.json();
  if (!response.ok || payload.ok === false) throw createApiError(response, payload);
  return payload.data;
}

function setLoading(loading) {
  const button = $('#authButton');
  button.disabled = loading;
  button.classList.toggle('is-loading', loading);
  button.innerHTML = loading ? '<span>处理中</span><span class="loading-dots"><i></i><i></i><i></i></span>' : setupMode ? '创建管理员并进入' : '登录';
}

async function boot() {
  const status = await request('/api/auth/status');
  if (status.authenticated) return window.location.replace('/workspace.html');
  setupMode = status.requiresSetup;
  $$('.setup-only').forEach((item) => item.classList.toggle('hidden', !setupMode));
  $('#displayNameInput').required = setupMode;
  $('#authKicker').textContent = setupMode ? 'FIRST TIME SETUP' : 'ACCOUNT ACCESS';
  $('#authTitle').textContent = setupMode ? '初始化管理员' : '登录工作台';
  $('#authHint').textContent = setupMode ? '当前没有用户。请创建首个管理员账号，已有项目会自动归属该账号。' : '使用管理员创建的账号登录。';
  setLoading(false);
}

function $$(selector) { return [...document.querySelectorAll(selector)]; }

$('#authForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#authError').textContent = '';
  setLoading(true);
  try {
    const session = await request(setupMode ? '/api/auth/setup' : '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        account: $('#accountInput').value.trim(),
        password: $('#passwordInput').value,
        displayName: $('#displayNameInput').value.trim()
      })
    });
    setAccessToken(session.accessToken);
    window.location.replace(setupMode ? '/admin.html' : '/workspace.html');
  } catch (error) {
    $('#authError').textContent = error.message;
    setLoading(false);
    const formPanel = $('.auth-form-panel');
    if (formPanel) {
      formPanel.classList.add('field-error-shaking');
      formPanel.addEventListener('animationend', () => {
        formPanel.classList.remove('field-error-shaking');
      }, { once: true });
    }
  }
});

boot().catch((error) => { $('#authError').textContent = error.message; });
