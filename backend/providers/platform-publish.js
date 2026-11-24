import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ProviderError } from '../lib/http.js';
import { readAssetFile } from '../lib/storage.js';
import { getProviderConfig } from './config.js';

export const publishingPlatforms = [
  { id: 'douyin', name: '抖音', supportsDraft: true, supportsSchedule: true },
  { id: 'tencent', name: '视频号', supportsDraft: true, supportsSchedule: true },
  { id: 'xiaohongshu', name: '小红书', supportsDraft: true, supportsSchedule: true },
  { id: 'kuaishou', name: '快手', supportsDraft: true, supportsSchedule: true },
  { id: 'bilibili', name: 'B站', supportsDraft: false, supportsSchedule: false },
  { id: 'baijiahao', name: '百家号', supportsDraft: false, supportsSchedule: false }
];

const resultPrefix = '__CHENSI_PUBLISH_RESULT__';
const eventPrefix = '__CHENSI_PUBLISH_EVENT__';
const connectionTasks = new Map();
const connectionVersions = new Map();
const activeConnectionStatuses = new Set(['preparing', 'waiting_scan', 'waiting_verification', 'waiting_interaction', 'waiting_confirm']);
const terminalConnectionStatuses = new Set(['connected', 'expired', 'failed', 'cancelled']);
const connectionTaskRetentionMs = 15 * 60_000;
const platformById = new Map(publishingPlatforms.map((item) => [item.id, item]));
const platformByName = new Map(publishingPlatforms.map((item) => [item.name, item]));
const persistentProfileDirectories = new Map([
  ['douyin', 'douyin_publish']
]);

function connectionScopeKey(userId, platformId) {
  return `${String(userId || 'local-user')}:${String(platformId || '')}`;
}

function currentConnectionVersion(userId, platformId) {
  return connectionVersions.get(connectionScopeKey(userId, platformId)) || 0;
}

function revokeConnectionScope(userId, platformId) {
  const key = connectionScopeKey(userId, platformId);
  const next = (connectionVersions.get(key) || 0) + 1;
  connectionVersions.set(key, next);
  return next;
}

export function resolvePublishingPlatform(value) {
  const normalized = String(value || '').trim();
  return platformById.get(normalized) || platformByName.get(normalized) || null;
}

function config() {
  return getProviderConfig().publishing;
}

function sessionScope(userId) {
  return createHash('sha256').update(String(userId || 'local-user')).digest('hex').slice(0, 24);
}

async function clearScopedBrowserProfile(userId, platformId) {
  const profileDirectory = persistentProfileDirectories.get(platformId);
  if (!profileDirectory) return false;
  const profileRoot = path.resolve(config().sessionRoot, sessionScope(userId), 'browser-profiles');
  const target = path.resolve(profileRoot, profileDirectory);
  const relative = path.relative(profileRoot, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw bridgeFailure('PUBLISH_PROFILE_PATH_INVALID', '平台浏览器登录目录无效，未执行清理');
  }
  try {
    await fs.rm(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
    return true;
  } catch (error) {
    throw bridgeFailure('PUBLISH_PROFILE_CLEAR_FAILED', '平台账号已退出，但服务端浏览器登录状态清理失败，请重试退出', error instanceof Error ? error.message : String(error), true);
  }
}

function bridgeFailure(code, message, details = null, retryable = false) {
  return new ProviderError(code, message, { status: 503, retryable, details });
}

async function runEmbeddedPublisher(action, payload = {}, options = {}) {
  const current = config();
  if (!current.enabled) {
    throw bridgeFailure('PUBLISH_RUNTIME_UNAVAILABLE', '内置平台发布模块不可用，请检查 Python 命令和发布模块文件');
  }
  const scope = sessionScope(options.userId);
  const sessionRoot = path.join(current.sessionRoot, scope);
  const profileRoot = path.join(sessionRoot, 'browser-profiles');
  await fs.mkdir(sessionRoot, { recursive: true });
  const input = JSON.stringify({ action, ...payload });
  const timeoutMs = Math.max(1_000, Number(options.timeoutMs || current.timeoutMs));

  return new Promise((resolve, reject) => {
    const child = spawn(current.pythonCommand, [current.bridgePath], {
      cwd: path.dirname(current.bridgePath),
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        IP_AGENT_PUBLISH_HEADLESS: options.headless === false ? '0' : '1',
        IP_AGENT_PUBLISH_SESSION_ROOT: sessionRoot,
        IP_AGENT_PUBLISH_BROWSER_PROFILE_ROOT: profileRoot,
        IP_AGENT_PUBLISH_CONTROL_DIR: options.controlDir || ''
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let eventBuffer = '';
    let finished = false;
    options.onSpawn?.(child);
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill();
      reject(bridgeFailure('PUBLISH_RUNTIME_TIMEOUT', '内置平台发布操作超时，请检查浏览器页面是否仍在等待扫码、验证或人工确认', null, true));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-2_000_000);
      if (!options.onEvent) return;
      eventBuffer += chunk;
      let newline = eventBuffer.indexOf('\n');
      while (newline >= 0) {
        const line = eventBuffer.slice(0, newline).replace(/\r$/, '');
        eventBuffer = eventBuffer.slice(newline + 1);
        const marker = line.indexOf(eventPrefix);
        if (marker >= 0) {
          try {
            options.onEvent(JSON.parse(line.slice(marker + eventPrefix.length)));
          } catch {}
        }
        newline = eventBuffer.indexOf('\n');
      }
    });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-100_000); });
    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(bridgeFailure('PUBLISH_RUNTIME_START_FAILED', '无法启动内置平台发布模块，请检查 Python 是否可用', error.message));
    });
    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const marker = stdout.lastIndexOf(resultPrefix);
      if (marker < 0) {
        reject(bridgeFailure('PUBLISH_RUNTIME_INVALID_RESPONSE', '内置平台发布模块没有返回有效结果', { exitCode: code, stderr: stderr.slice(-2_000) }, true));
        return;
      }
      const line = stdout.slice(marker + resultPrefix.length).split(/\r?\n/, 1)[0].trim();
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(bridgeFailure('PUBLISH_RUNTIME_INVALID_RESPONSE', '内置平台发布模块返回了无法解析的结果', { exitCode: code, parseError: error.message }, true));
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function cleanConnectionTasks(now = Date.now()) {
  for (const [taskId, task] of connectionTasks) {
    if (!terminalConnectionStatuses.has(task.status)) continue;
    const completedAt = Date.parse(task.completedAt || task.updatedAt || task.createdAt);
    if (Number.isFinite(completedAt) && now - completedAt > connectionTaskRetentionMs) connectionTasks.delete(taskId);
  }
}

function publicConnectionTask(task) {
  if (!task) return null;
  return {
    id: task.id,
    platform: task.platform.name,
    platformId: task.platform.id,
    status: task.status,
    message: task.message,
    qrCode: task.qrCode || null,
    qrCodeUpdatedAt: task.qrCodeUpdatedAt || null,
    verification: task.verification || null,
    remoteBrowser: task.remoteBrowser ? { ...task.remoteBrowser } : null,
    retryable: Boolean(task.retryable),
    errorCode: task.errorCode || null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    expiresAt: task.expiresAt,
    completedAt: task.completedAt || null
  };
}

function updateConnectionTask(task, values) {
  Object.assign(task, values, { updatedAt: new Date().toISOString() });
  if (terminalConnectionStatuses.has(task.status) && !task.completedAt) task.completedAt = task.updatedAt;
  return task;
}

function normalizedQrCode(value) {
  const image = String(value || '');
  if (image.length > 2_000_000) return '';
  return /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image) ? image : '';
}

function normalizeVerificationMethods(value) {
  if (!Array.isArray(value)) return [];
  const known = new Map([
    ['sms', '手机验证码'],
    ['face', '手机刷脸验证']
  ]);
  const seen = new Set();
  return value.flatMap((item) => {
    const id = String(item?.id || item || '').trim().toLowerCase();
    if (!known.has(id) || seen.has(id)) return [];
    seen.add(id);
    return [{ id, label: known.get(id) }];
  });
}

function normalizeVerificationEvent(event, previous = null) {
  const methods = normalizeVerificationMethods(event?.methods);
  const availableMethods = methods.length ? methods : normalizeVerificationMethods(previous?.methods);
  const requestedMethod = String(event?.selectedMethod || previous?.selectedMethod || '').toLowerCase();
  const selectedMethod = availableMethods.some((item) => item.id === requestedMethod)
    ? requestedMethod
    : (availableMethods.find((item) => item.id === 'sms')?.id || availableMethods[0]?.id || '');
  const stage = ['method_required', 'code_required', 'submitting', 'face_required'].includes(event?.stage)
    ? event.stage
    : 'method_required';
  return {
    methods: availableMethods,
    selectedMethod,
    stage,
    requiresCode: selectedMethod === 'sms' && stage !== 'submitting',
    canResend: selectedMethod === 'sms' && event?.canResend !== false,
    phoneHint: String(event?.phoneHint || previous?.phoneHint || '').slice(0, 80)
  };
}

function normalizeBrowserFrameEvent(event, previous = null) {
  const imageDataUrl = normalizedQrCode(event?.imageDataUrl);
  if (!imageDataUrl || !imageDataUrl.startsWith('data:image/jpeg;base64,')) return null;
  return {
    requested: true,
    active: true,
    frameDataUrl: imageDataUrl,
    frameUpdatedAt: new Date().toISOString(),
    width: Math.min(4096, Math.max(320, Math.trunc(Number(event?.width) || Number(previous?.width) || 1280))),
    height: Math.min(4096, Math.max(240, Math.trunc(Number(event?.height) || Number(previous?.height) || 720))),
    title: String(event?.title || previous?.title || '').slice(0, 160),
    url: String(event?.url || previous?.url || '').slice(0, 500),
    sequence: Math.max(0, Math.trunc(Number(event?.sequence) || 0))
  };
}

async function writeConnectionCommand(task, command, channel = 'verification') {
  if (!task?.controlDir) throw new ProviderError('PUBLISH_INTERACTION_UNAVAILABLE', '当前授权任务不支持网页内操作', { status: 409 });
  await fs.mkdir(task.controlDir, { recursive: true });
  const prefix = channel === 'browser' ? 'browser-command' : 'verification-command';
  const file = path.join(task.controlDir, `${prefix}-${Date.now()}-${randomUUID()}.json`);
  await fs.writeFile(file, JSON.stringify({ ...command, createdAt: new Date().toISOString() }), { encoding: 'utf8', flag: 'wx' });
}

async function requestInteractiveBrowser(task) {
  if (task.remoteBrowser?.requested) return;
  task.remoteBrowser = { requested: true, active: false };
  try {
    await writeConnectionCommand(task, { action: 'open_browser' }, 'browser');
  } catch {
    task.remoteBrowser = null;
  }
}

export async function startPublishingConnectionTask(value, options = {}) {
  const platform = resolvePublishingPlatform(value);
  if (!platform) throw new ProviderError('PUBLISH_PLATFORM_UNSUPPORTED', '不支持的发布平台', { status: 400 });
  const userId = String(options.userId || 'local-user');
  cleanConnectionTasks();
  const active = [...connectionTasks.values()].find((task) => (
    task.userId === userId && task.platform.id === platform.id && activeConnectionStatuses.has(task.status)
  ));
  if (active) return publicConnectionTask(active);

  const now = new Date();
  const timeoutMs = Math.max(30_000, Number(options.timeoutMs || config().loginTimeoutMs));
  const scope = sessionScope(userId);
  const controlDir = path.join(config().sessionRoot, scope, 'authorization-control', randomUUID());
  await fs.mkdir(controlDir, { recursive: true });
  const task = {
    id: randomUUID(),
    userId,
    platform,
    status: 'preparing',
    message: `正在准备${platform.name}授权二维码`,
    qrCode: null,
    verification: null,
    remoteBrowser: null,
    retryable: false,
    child: null,
    controlDir,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + timeoutMs).toISOString(),
    completedAt: null
  };
  task.connectionVersion = currentConnectionVersion(userId, platform.id);
  connectionTasks.set(task.id, task);

  void runEmbeddedPublisher('connect', { platform: platform.id }, {
    userId,
    timeoutMs,
    // Douyin needs a headed renderer for some risk-control challenges; its
    // window is kept off-screen by the uploader. Other QR flows stay headless.
    headless: platform.id === 'douyin' ? config().loginHeadless : true,
    controlDir,
    onSpawn: (child) => {
      task.child = child;
      if (task.status === 'cancelled') child.kill();
    },
    onEvent: (event) => {
      if (!activeConnectionStatuses.has(task.status)) return;
      if (event?.type === 'browser_frame') {
        const remoteBrowser = normalizeBrowserFrameEvent(event, task.remoteBrowser);
        if (!remoteBrowser) return;
        updateConnectionTask(task, {
          status: 'waiting_interaction',
          message: '请在完整登录页面中继续操作，登录完成后会自动保存授权状态',
          remoteBrowser,
          qrCode: null
        });
        return;
      }
      if (event?.type === 'verification') {
        const verification = normalizeVerificationEvent(event, task.verification);
        updateConnectionTask(task, {
          status: verification.stage === 'submitting' ? 'waiting_confirm' : 'waiting_verification',
          message: String(event.message || (verification.selectedMethod === 'sms'
            ? '请输入发送到绑定手机的验证码'
            : '请使用抖音手机端完成刷脸验证')),
          verification,
          qrCode: verification.selectedMethod === 'face' ? task.qrCode : null
        });
        void requestInteractiveBrowser(task);
        return;
      }
      if (event?.type !== 'qrcode') return;
      const qrCode = normalizedQrCode(event.imageDataUrl || event.qrcode?.image_data_url);
      if (!qrCode) return;
      const isVerificationQr = event.purpose === 'identity_face';
      updateConnectionTask(task, {
        status: isVerificationQr ? 'waiting_verification' : 'waiting_scan',
        message: isVerificationQr ? '请使用抖音手机端扫码并完成刷脸验证' : `请使用${platform.name}手机端扫码，并在手机上确认授权`,
        qrCode,
        qrCodeUpdatedAt: new Date().toISOString(),
        ...(isVerificationQr ? {
          verification: normalizeVerificationEvent({
            methods: task.verification?.methods || [{ id: 'face' }],
            selectedMethod: 'face',
            stage: 'face_required',
            canResend: false
          }, task.verification)
        } : {})
      });
    }
  }).then(async (payload) => {
    if (task.status === 'cancelled' || task.connectionVersion !== currentConnectionVersion(task.userId, task.platform.id)) return;
    payloadFailure(payload, `${platform.name}登录失败`, 'PUBLISH_LOGIN_FAILED');
    if (task.status === 'cancelled' || task.connectionVersion !== currentConnectionVersion(task.userId, task.platform.id)) return;
    updateConnectionTask(task, {
      status: 'connected',
      message: String(payload?.message || `${platform.name}扫码授权成功`),
      qrCode: null,
      verification: null,
      remoteBrowser: null,
      retryable: false,
      errorCode: null
    });
    try {
      await options.onConnected?.(publicConnectionTask(task));
    } catch (error) {
      task.persistenceError = error instanceof Error ? error.message : String(error);
    }
  }).catch((error) => {
    if (task.status === 'cancelled') return;
    const expired = error?.code === 'PUBLISH_RUNTIME_TIMEOUT' || /超时|过期/.test(String(error?.message || ''));
    updateConnectionTask(task, {
      status: expired ? 'expired' : 'failed',
      message: expired ? '授权二维码已过期，请重新获取' : String(error?.message || `${platform.name}授权失败`),
      qrCode: null,
      verification: null,
      remoteBrowser: null,
      retryable: true,
      errorCode: error?.code || 'PUBLISH_LOGIN_FAILED'
    });
  }).finally(() => {
    task.child = null;
    fs.rm(controlDir, { recursive: true, force: true }).catch(() => {});
  });

  return publicConnectionTask(task);
}

export async function submitPublishingConnectionVerification(taskId, input = {}, options = {}) {
  const task = connectionTasks.get(String(taskId || ''));
  if (!task || task.userId !== String(options.userId || 'local-user')) return null;
  if (!activeConnectionStatuses.has(task.status) || task.platform.id !== 'douyin') {
    throw new ProviderError('PUBLISH_VERIFICATION_NOT_WAITING', '当前授权任务不在身份验证阶段', { status: 409 });
  }
  const availableMethods = normalizeVerificationMethods(task.verification?.methods);
  const action = String(input.action || (input.code ? 'submit_code' : 'select_method')).trim();
  if (action === 'submit_code') {
    const code = String(input.code || '').replace(/\s+/g, '');
    if (!/^\d{4,8}$/.test(code)) throw new ProviderError('PUBLISH_VERIFICATION_CODE_INVALID', '请输入 4 至 8 位数字验证码', { status: 400 });
    await writeConnectionCommand(task, { action, code });
    updateConnectionTask(task, {
      status: 'waiting_confirm',
      message: '验证码已提交，正在等待平台确认',
      verification: { ...task.verification, selectedMethod: 'sms', stage: 'submitting', requiresCode: false }
    });
    return publicConnectionTask(task);
  }
  if (action === 'resend_code') {
    if (!availableMethods.some((item) => item.id === 'sms')) throw new ProviderError('PUBLISH_VERIFICATION_METHOD_UNAVAILABLE', '当前没有可用的手机验证码方式', { status: 409 });
    await writeConnectionCommand(task, { action });
    updateConnectionTask(task, { message: '正在重新发送手机验证码' });
    return publicConnectionTask(task);
  }
  const method = String(input.method || '').trim().toLowerCase();
  if (!availableMethods.some((item) => item.id === method)) {
    throw new ProviderError('PUBLISH_VERIFICATION_METHOD_UNAVAILABLE', '平台当前未提供该验证方式', { status: 409 });
  }
  await writeConnectionCommand(task, { action: 'select_method', method });
  updateConnectionTask(task, {
    status: 'waiting_verification',
    message: method === 'sms' ? '正在切换到手机验证码' : '正在切换到手机刷脸验证',
    qrCode: null,
    verification: {
      ...task.verification,
      selectedMethod: method,
      stage: method === 'sms' ? 'code_required' : 'face_required',
      requiresCode: method === 'sms'
    }
  });
  return publicConnectionTask(task);
}

export async function submitPublishingConnectionInteraction(taskId, input = {}, options = {}) {
  const task = connectionTasks.get(String(taskId || ''));
  if (!task || task.userId !== String(options.userId || 'local-user')) return null;
  if (!activeConnectionStatuses.has(task.status)) {
    throw new ProviderError('PUBLISH_INTERACTION_NOT_WAITING', '当前授权任务已经结束，请重新发起授权', { status: 409 });
  }
  const action = String(input.action || '').trim().toLowerCase();
  const command = { action };
  if (action === 'open_browser') {
    task.remoteBrowser = { ...(task.remoteBrowser || {}), requested: true, active: Boolean(task.remoteBrowser?.active) };
  } else if (action === 'click') {
    command.x = Math.min(4096, Math.max(0, Number(input.x) || 0));
    command.y = Math.min(4096, Math.max(0, Number(input.y) || 0));
  } else if (action === 'drag') {
    for (const key of ['startX', 'startY', 'endX', 'endY']) {
      command[key] = Math.min(4096, Math.max(0, Number(input[key]) || 0));
    }
  } else if (action === 'type_text') {
    command.text = String(input.text || '').slice(0, 512);
    if (!command.text) throw new ProviderError('PUBLISH_INTERACTION_TEXT_REQUIRED', '请输入要发送到登录页面的内容', { status: 400 });
  } else if (action === 'press_key') {
    const allowedKeys = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
    command.key = String(input.key || '');
    if (!allowedKeys.has(command.key)) throw new ProviderError('PUBLISH_INTERACTION_KEY_INVALID', '不支持的按键操作', { status: 400 });
  } else if (action === 'scroll') {
    command.deltaY = Math.min(1600, Math.max(-1600, Number(input.deltaY) || 0));
  } else if (!['reload', 'go_back'].includes(action)) {
    throw new ProviderError('PUBLISH_INTERACTION_ACTION_INVALID', '不支持的登录页面操作', { status: 400 });
  }
  await writeConnectionCommand(task, command, 'browser');
  updateConnectionTask(task, {
    status: 'waiting_interaction',
    message: action === 'open_browser' ? '正在打开完整登录页面' : '操作已发送，正在同步页面'
  });
  return publicConnectionTask(task);
}

export function publishingConnectionTask(taskId, options = {}) {
  cleanConnectionTasks();
  const task = connectionTasks.get(String(taskId || ''));
  if (!task || task.userId !== String(options.userId || 'local-user')) return null;
  return publicConnectionTask(task);
}

export function cancelPublishingConnectionTask(taskId, options = {}) {
  const task = connectionTasks.get(String(taskId || ''));
  if (!task || task.userId !== String(options.userId || 'local-user')) return null;
  cancelConnectionTask(task);
  return publicConnectionTask(task);
}

function cancelConnectionTask(task, message = '已取消本次扫码授权') {
  if (!task || terminalConnectionStatuses.has(task.status)) return false;
  updateConnectionTask(task, {
    status: 'cancelled',
    message,
    qrCode: null,
    verification: null,
    remoteBrowser: null,
    retryable: true,
    errorCode: null
  });
  task.child?.kill();
  return true;
}

export function cancelPublishingConnectionTasksForPlatform(value, options = {}) {
  const platform = resolvePublishingPlatform(value);
  if (!platform) return [];
  const userId = String(options.userId || 'local-user');
  revokeConnectionScope(userId, platform.id);
  cleanConnectionTasks();
  return [...connectionTasks.values()]
    .filter((task) => task.userId === userId && task.platform.id === platform.id && !['expired', 'failed', 'cancelled'].includes(task.status))
    .filter((task) => {
      if (task.status !== 'connected') return cancelConnectionTask(task, '平台已退出，本次扫码授权已取消');
      updateConnectionTask(task, {
        status: 'cancelled',
        message: '平台登录状态已清除',
        qrCode: null,
        verification: null,
        remoteBrowser: null,
        retryable: true,
        errorCode: null
      });
      return true;
    })
    .map(publicConnectionTask);
}

export function cancelPublishingConnectionTasksForUser(options = {}) {
  const userId = String(options.userId || 'local-user');
  cleanConnectionTasks();
  return [...connectionTasks.values()]
    .filter((task) => task.userId === userId && activeConnectionStatuses.has(task.status))
    .filter((task) => cancelConnectionTask(task, '账号已退出，本次扫码授权已取消'))
    .map(publicConnectionTask);
}

function payloadFailure(payload, fallback, code) {
  if (payload?.success !== false) return;
  throw new ProviderError(code, String(payload.error || payload.message || fallback), {
    retryable: /超时|页面|验证|网络|重试/.test(String(payload.error || payload.message || '')),
    details: { errorType: payload.error_type || null }
  });
}

function loggedIn(value) {
  if (typeof value?.logged_in === 'boolean') return value.logged_in;
  if (typeof value?.loggedIn === 'boolean') return value.loggedIn;
  return value?.success === true;
}

export async function publishingStatus(options = {}) {
  const payload = await runEmbeddedPublisher('status', {}, {
    userId: options.userId,
    timeoutMs: options.timeoutMs || config().timeoutMs
  });
  payloadFailure(payload, '读取内置平台登录状态失败', 'PUBLISH_STATUS_FAILED');
  const raw = payload?.platforms_status || {};
  const browserReady = payload?.available !== false && payload?.dependencies?.playwright !== false;
  return publishingPlatforms.map((platform) => {
    const current = raw[platform.id] || {};
    const dependencyReady = browserReady && (platform.id !== 'bilibili' || payload?.dependencies?.biliup !== false);
    const missingDependency = !browserReady ? '浏览器自动化组件' : 'B站发布组件';
    return {
      ...platform,
      loggedIn: dependencyReady && loggedIn(current),
      available: dependencyReady,
      message: dependencyReady
        ? String(current.message || current.error || (loggedIn(current) ? '已登录' : '未登录'))
        : `缺少${missingDependency}，请安装内置发布模块依赖`
    };
  });
}

export async function connectPublishingPlatform(value, options = {}) {
  const platform = resolvePublishingPlatform(value);
  if (!platform) throw new ProviderError('PUBLISH_PLATFORM_UNSUPPORTED', '不支持的发布平台', { status: 400 });
  const payload = await runEmbeddedPublisher('connect', { platform: platform.id }, {
    userId: options.userId,
    timeoutMs: config().loginTimeoutMs
  });
  payloadFailure(payload, `${platform.name}登录失败`, 'PUBLISH_LOGIN_FAILED');
  return { ...platform, loggedIn: true, message: String(payload?.message || '扫码登录成功') };
}

export async function checkPublishingPlatform(value, options = {}) {
  const platform = resolvePublishingPlatform(value);
  if (!platform) throw new ProviderError('PUBLISH_PLATFORM_UNSUPPORTED', '不支持的发布平台', { status: 400 });
  const payload = await runEmbeddedPublisher('check', { platform: platform.id }, {
    userId: options.userId,
    timeoutMs: Math.max(config().timeoutMs, 60_000)
  });
  return {
    ...platform,
    loggedIn: loggedIn(payload),
    message: String(payload?.message || payload?.error || (loggedIn(payload) ? '已登录' : '登录态无效'))
  };
}

export async function clearPublishingPlatform(value, options = {}) {
  const platform = resolvePublishingPlatform(value);
  if (!platform) throw new ProviderError('PUBLISH_PLATFORM_UNSUPPORTED', '不支持的发布平台', { status: 400 });
  const userId = String(options.userId || 'local-user');
  cancelPublishingConnectionTasksForPlatform(platform.id, { userId });
  const payload = await runEmbeddedPublisher('clear', { platform: platform.id }, {
    userId,
    timeoutMs: config().timeoutMs
  });
  payloadFailure(payload, `${platform.name}登录态清除失败`, 'PUBLISH_LOGOUT_FAILED');
  const profileCleared = await clearScopedBrowserProfile(userId, platform.id);
  return {
    ...platform,
    loggedIn: false,
    profileCleared,
    message: profileCleared ? `${platform.name}已退出，服务端登录状态已清除` : String(payload?.message || '登录态已清除')
  };
}

function normalizePublishDate(value, platforms) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) throw new ProviderError('PUBLISH_DATE_INVALID', '定时发布时间无效', { status: 400 });
  if (timestamp <= Date.now() + 2 * 60 * 60 * 1_000) {
    throw new ProviderError('PUBLISH_DATE_TOO_SOON', '定时发布时间必须晚于当前时间 2 小时以上', { status: 400 });
  }
  const unsupported = platforms.filter((item) => !item.supportsSchedule);
  if (unsupported.length) {
    throw new ProviderError('PUBLISH_SCHEDULE_UNSUPPORTED', `${unsupported.map((item) => item.name).join('、')}不支持定时发布`, { status: 400 });
  }
  return new Date(timestamp).toISOString();
}

async function downloadTemporaryVideo(url) {
  if (!/^https?:\/\//i.test(String(url || ''))) {
    throw new ProviderError('PUBLISH_VIDEO_LOCAL_REQUIRED', '所选成片没有可供内置发布模块上传的本地文件', { status: 409 });
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chensi-platform-publish-'));
  const filename = path.join(directory, 'publish-video.mp4');
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(config().downloadTimeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!response.body) throw new Error('empty file');
    const maxBytes = config().maxVideoBytes;
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > maxBytes) throw new ProviderError('PUBLISH_VIDEO_TOO_LARGE', '成片超过内置发布模块允许的文件大小', { status: 413 });
    let received = 0;
    const limiter = new Transform({
      transform(chunk, encoding, callback) {
        received += chunk.length;
        if (received > maxBytes) callback(new ProviderError('PUBLISH_VIDEO_TOO_LARGE', '成片超过内置发布模块允许的文件大小', { status: 413 }));
        else callback(null, chunk);
      }
    });
    await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(filename, { flags: 'wx' }));
    if (!received) throw new Error('empty file');
    return { filePath: filename, cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('PUBLISH_VIDEO_DOWNLOAD_FAILED', '远程成片下载失败，无法交给内置发布模块', {
      retryable: true,
      details: error instanceof Error ? error.message : String(error)
    });
  }
}

async function publishingVideoFile(output) {
  if (output?.storageKey) {
    return readAssetFile(output, { includeData: false });
  }
  return downloadTemporaryVideo(output?.url || output?.accessUrl);
}

function resultStatus(result) {
  if (result?.success === true) return 'success';
  const message = String(result?.error || result?.message || '发布失败');
  if (/验证码|二次验证|人工|确认|扫码|风控/.test(message)) return 'waiting_user_action';
  return 'failed';
}

function normalizeResults(payload, platforms) {
  const raw = payload?.results || {};
  return platforms.map((platform) => {
    const current = raw[platform.id] || raw[platform.name] || (platforms.length === 1 ? payload : null) || {};
    const status = resultStatus(current);
    return {
      platform: platform.name,
      platformId: platform.id,
      status,
      success: status === 'success',
      message: String(current.message || current.error || (status === 'success' ? '发布成功' : '发布失败'))
    };
  });
}

export async function publishVideoToPlatforms(input, project, options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : async () => {};
  const platforms = [...new Set(Array.isArray(input.platforms) ? input.platforms : [])]
    .map(resolvePublishingPlatform)
    .filter(Boolean);
  if (!platforms.length) throw new ProviderError('PUBLISH_PLATFORM_REQUIRED', '请至少选择一个发布平台', { status: 400 });
  const source = (project.outputs || []).find((item) => item.id === input.sourceOutputId && item.status === 'ready');
  if (!source) throw new ProviderError('PUBLISH_VIDEO_REQUIRED', '请选择一条已经真实生成的视频成片', { status: 400 });
  const title = String(input.title || project.copy?.publishTitle || source.title || '').trim();
  if (!title) throw new ProviderError('PUBLISH_TITLE_REQUIRED', '请填写发布标题', { status: 400 });
  const tags = Array.isArray(input.tags) ? input.tags.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 10) : [];
  const isDraft = input.mode === 'draft' || input.isDraft === true;
  if (isDraft) {
    const unsupported = platforms.filter((item) => !item.supportsDraft);
    if (unsupported.length) throw new ProviderError('PUBLISH_DRAFT_UNSUPPORTED', `${unsupported.map((item) => item.name).join('、')}不支持保存草稿`, { status: 400 });
  }
  const publishDate = input.mode === 'scheduled' ? normalizePublishDate(input.publishDate, platforms) : null;
  const cover = input.coverAssetId
    ? (project.assets || []).find((item) => item.id === input.coverAssetId && item.storageKey && String(item.mimeType || '').startsWith('image/'))
    : null;
  if (input.coverAssetId && !cover) throw new ProviderError('PUBLISH_COVER_INVALID', '所选封面不存在或不是本地图片素材', { status: 400 });
  await onProgress(14, '发布参数已校验');

  const status = await publishingStatus({ userId: options.userId });
  const unavailable = platforms.filter((platform) => status.find((item) => item.id === platform.id)?.available === false);
  if (unavailable.length) {
    throw new ProviderError('PUBLISH_PLATFORM_DEPENDENCY_MISSING', `${unavailable.map((item) => item.name).join('、')}缺少运行依赖`, { status: 503 });
  }
  const disconnected = platforms.filter((platform) => !status.find((item) => item.id === platform.id)?.loggedIn);
  if (disconnected.length) {
    throw new ProviderError('PUBLISH_LOGIN_REQUIRED', `请先完成${disconnected.map((item) => item.name).join('、')}扫码授权`, { status: 409 });
  }
  await onProgress(28, '平台授权已确认');

  const video = await publishingVideoFile(source);
  await onProgress(40, '发布视频已准备');
  let coverFile = null;
  try {
    coverFile = cover ? await readAssetFile(cover, { includeData: false }) : null;
    await onProgress(46, cover ? '视频与封面已准备' : '发布素材已准备');
    const payload = await runEmbeddedPublisher('publish', {
      platforms: platforms.map((item) => item.id),
      video_path: video.filePath,
      title,
      tags,
      cover_path: coverFile?.filePath || '',
      is_draft: isDraft,
      submit_wait: 3,
      ...(publishDate ? { publish_date: publishDate } : {})
    }, { userId: options.userId, timeoutMs: config().taskTimeoutMs });
    await onProgress(84, '平台发布操作已完成');
    const results = normalizeResults(payload, platforms);
    const successCount = results.filter((item) => item.status === 'success').length;
    const waitingCount = results.filter((item) => item.status === 'waiting_user_action').length;
    if (!successCount && !waitingCount) {
      throw new ProviderError('PUBLISH_ALL_FAILED', String(payload?.message || '所选平台均发布失败'), {
        retryable: true,
        details: { results }
      });
    }
    await onProgress(88, '发布结果已确认');
    return {
      provider: 'embedded-browser-automation',
      model: null,
      externalTaskId: null,
      output: {
        sourceOutputId: source.id,
        sourceTitle: source.title || '',
        title,
        tags,
        coverAssetId: cover?.id || null,
        mode: publishDate ? 'scheduled' : isDraft ? 'draft' : 'immediate',
        publishDate,
        status: successCount === results.length ? 'success' : successCount || waitingCount ? 'partial' : 'failed',
        successCount,
        waitingCount,
        failureCount: results.length - successCount - waitingCount,
        message: String(payload?.message || `成功发布 ${successCount}/${results.length} 个平台`),
        results
      }
    };
  } finally {
    await coverFile?.cleanup?.().catch(() => {});
    await video.cleanup();
  }
}
