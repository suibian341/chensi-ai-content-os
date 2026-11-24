import { apiFetch, apiUrl, clearAccessToken, createApiError, createIdempotencyKey, ensureControlIdentities, resolveApiUrls } from './config.js';
import { createPollingManager } from './polling.js';
import { joinJianyingPath, mergeJianyingIndexData, rewriteJianyingJson, safeJianyingFolderName } from './jianying-files.js';

const state = { user: null, projects: [], project: null, requestedProjectId: null, projectLoadToken: null, tasks: [], copies: [], chat: null, organization: null, tickets: [], connections: [], jianying: { directoryHandle: null, permission: 'prompt', activeExport: null }, backgroundMusic: [], userBackgroundMusic: [], backgroundMusicSource: 'system', backgroundMusicError: '', talkingPhotoStatus: null, catalog: { features: [], requirements: [], templates: [], platforms: [], providers: [], taskCosts: {}, projectConfig: {} }, copyMode: 'standard', editingCopyId: null, productionMode: 'clip', activeView: 'overview', assetPicker: { image: [], video: [] }, platformAuth: { task: null, platform: '', trigger: null } };
const polling = createPollingManager();
const pollStartedAt = (record, fallback = Date.now()) => {
  const value = Date.parse(record?.startedAt || record?.updatedAt || record?.createdAt || '');
  return Number.isFinite(value) ? value : fallback;
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const esc = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const publicFeatureText = (value = '') => String(value ?? '').trim();

function taskStatusText(task = {}) {
  const status = String(task.status || '').trim().toLowerCase();
  if (status === 'failed' || status === 'faild') {
    const failure = task.error?.message || (typeof task.error === 'string' ? task.error : '') || task.message || '任务失败';
    const message = publicFeatureText(failure).replace(/^(?:failed|faild)\s*[:：·-]?\s*/i, '') || '任务失败';
    const code = String(task.error?.code || task.errorCode || '').trim();
    return code && !message.includes(code) ? `${message}（${code}）` : message;
  }
  if (status === 'running' && task.progressStage) return publicFeatureText(task.progressStage);
  return ({ queued: '等待处理', running: '处理中', success: '已完成', cancelled: '已取消', canceled: '已取消' })[status]
    || publicFeatureText(task.status || '状态未知');
}

function taskCost(kind) {
  const costs = state.catalog?.taskCosts || {};
  const raw = kind === 'video'
    ? (costs.videoPerMinute ?? costs.video_per_minute ?? costs.videoMinute ?? costs.video_minute ?? costs.video ?? 0)
    : kind === 'asset_upload'
      ? (costs.assetUpload ?? costs.asset_upload ?? costs.upload ?? 0)
      : kind === 'background_music_upload'
        ? (costs.backgroundMusicUpload ?? costs.background_music_upload ?? 0)
        : costs[kind] ?? 0;
  return Math.max(0, Number(raw) || 0);
}

function renderTaskCosts(root = document) {
  const selector = '[data-task-cost-kind]';
  const controls = [
    ...(root.matches?.(selector) ? [root] : []),
    ...(root.querySelectorAll?.(selector) || [])
  ];
  controls.forEach((control) => {
    const unit = control.dataset.taskCostUnit || '次';
    const cost = taskCost(control.dataset.taskCostKind);
    control.dataset.taskCostLabel = `${cost} 算力/${unit}`;
    control.setAttribute('aria-description', `每${unit}成功操作消耗 ${cost} 算力，失败自动退回`);
  });
}

const controlIdentityObserver = new MutationObserver((records) => {
  for (const record of records) for (const node of record.addedNodes) if (node.nodeType === Node.ELEMENT_NODE) {
    ensureControlIdentities(node);
  }
});
controlIdentityObserver.observe(document.body, { childList: true, subtree: true });
ensureControlIdentities();

function markTerms(value, terms = []) {
  const text = String(value || '');
  const candidates = [...new Set(terms.map(String).filter((item) => item.length >= 2))].sort((a, b) => b.length - a.length);
  if (!candidates.length) return esc(text);
  let cursor = 0;
  let output = '';
  while (cursor < text.length) {
    let nextIndex = -1;
    let nextTerm = '';
    for (const term of candidates) {
      const index = text.indexOf(term, cursor);
      if (index >= 0 && (nextIndex < 0 || index < nextIndex || (index === nextIndex && term.length > nextTerm.length))) {
        nextIndex = index;
        nextTerm = term;
      }
    }
    if (nextIndex < 0) return output + esc(text.slice(cursor));
    output += `${esc(text.slice(cursor, nextIndex))}<mark>${esc(nextTerm)}</mark>`;
    cursor = nextIndex + nextTerm.length;
  }
  return output;
}

async function request(url, options = {}) {
  const response = await apiFetch(url, options);
  const payload = await response.json();
  if (response.status === 401 && !url.startsWith('/api/auth/')) {
    window.location.assign('/login.html');
    throw new Error('请先登录');
  }
  if (!response.ok || payload.ok === false) throw createApiError(response, payload);
  return resolveApiUrls(payload.data);
}

function toast(message) {
  const node = $('#toast');
  node.textContent = publicFeatureText(message);
  node.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove('show'), 2600);
}

const jianyingDirectoryDbName = 'chensi-jianying-directories';
const jianyingDirectoryStoreName = 'handles';
const jianyingIndexFilename = 'root_meta_info.json';

function supportsBrowserJianying() {
  return window.isSecureContext && typeof window.showDirectoryPicker === 'function' && 'indexedDB' in window;
}

function jianyingHandleKey() {
  return `user:${String(state.user?.id || 'anonymous')}:draft-root`;
}

function openJianyingDirectoryDb() {
  return new Promise((resolve, reject) => {
    const operation = indexedDB.open(jianyingDirectoryDbName, 1);
    operation.onupgradeneeded = () => {
      if (!operation.result.objectStoreNames.contains(jianyingDirectoryStoreName)) {
        operation.result.createObjectStore(jianyingDirectoryStoreName);
      }
    };
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error || new Error('无法保存剪映目录授权'));
  });
}

async function jianyingHandleStore(mode, work) {
  const database = await openJianyingDirectoryDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(jianyingDirectoryStoreName, mode);
      const result = work(transaction.objectStore(jianyingDirectoryStoreName));
      result.onsuccess = () => resolve(result.result);
      result.onerror = () => reject(result.error || new Error('剪映目录授权操作失败'));
    });
  } finally {
    database.close();
  }
}

function savedJianyingHandle() {
  return jianyingHandleStore('readonly', (store) => store.get(jianyingHandleKey()));
}

function saveJianyingHandle(handle) {
  return jianyingHandleStore('readwrite', (store) => store.put(handle, jianyingHandleKey()));
}

function deleteJianyingHandle() {
  return jianyingHandleStore('readwrite', (store) => store.delete(jianyingHandleKey()));
}

function renderJianyingRoot() {
  const status = $('#jianyingDirectoryStatus');
  const selectButton = $('#selectJianyingDirectoryButton');
  const forgetButton = $('#forgetJianyingDirectoryButton');
  const note = $('#jianyingBrowserNote');
  if (!status || !selectButton || !forgetButton || !note) return;
  if (!supportsBrowserJianying()) {
    status.textContent = '当前浏览器不支持网页写入文件夹';
    selectButton.textContent = '请使用 Chrome 或 Edge';
    selectButton.disabled = true;
    forgetButton.classList.add('hidden');
    note.textContent = '请使用最新版桌面 Chrome 或 Edge，并通过 HTTPS 打开辰思AI。';
    return;
  }
  selectButton.disabled = false;
  const handle = state.jianying.directoryHandle;
  if (!handle) {
    status.textContent = '尚未选择剪映草稿目录';
    selectButton.textContent = '选择剪映草稿目录';
    forgetButton.classList.add('hidden');
    return;
  }
  status.textContent = state.jianying.permission === 'granted'
    ? `已授权：${handle.name}`
    : `已记住：${handle.name}，导入时需要确认权限`;
  selectButton.textContent = '更换草稿目录';
  forgetButton.classList.remove('hidden');
}

async function restoreJianyingDirectory() {
  if (!supportsBrowserJianying() || !state.user?.id) return renderJianyingRoot();
  try {
    const handle = await savedJianyingHandle();
    state.jianying.directoryHandle = handle || null;
    state.jianying.permission = handle ? await handle.queryPermission({ mode: 'readwrite' }) : 'prompt';
  } catch {
    state.jianying.directoryHandle = null;
    state.jianying.permission = 'prompt';
  }
  renderJianyingRoot();
}

async function inspectJianyingDirectory(handle) {
  let indexHandle;
  try {
    indexHandle = await handle.getFileHandle(jianyingIndexFilename);
  } catch (error) {
    if (error?.name === 'NotFoundError') {
      throw new Error('所选目录没有剪映草稿索引。请先在剪映“设置 → 草稿位置”中选择一个普通文件夹，完全退出剪映后重新打开一次，再选择该目录。');
    }
    throw error;
  }
  const sourceFile = await indexHandle.getFile();
  const sourceText = await sourceFile.text();
  let index;
  try {
    index = JSON.parse(sourceText.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('所选目录的剪映草稿索引无法解析，请确认没有选到单个草稿子目录');
  }
  if (!Array.isArray(index.all_draft_store)) throw new Error('所选目录不是有效的剪映草稿根目录');
  const rootPath = String(index.root_path || index.all_draft_store.find((item) => item?.draft_root_path)?.draft_root_path || '').trim();
  if (!/^(?:[A-Za-z]:[\\/]|\/)/.test(rootPath)) {
    throw new Error('剪映草稿索引没有记录真实磁盘路径，请在剪映里重新设置一次草稿位置');
  }
  return { indexHandle, index, sourceText, rootPath: rootPath.replace(/\\/g, '/') };
}

async function ensureJianyingDirectory({ requestPermission = false, chooseWhenMissing = false } = {}) {
  if (!supportsBrowserJianying()) throw new Error('网页导入剪映需要最新版桌面 Chrome 或 Edge，并且必须使用 HTTPS');
  let handle = state.jianying.directoryHandle;
  let newlyChosen = false;
  if (!handle && chooseWhenMissing) {
    const pickerId = `chensi-jy-${String(state.user?.id || 'user').replace(/[^a-zA-Z0-9_-]/g, '').slice(-16)}`;
    handle = await window.showDirectoryPicker({ id: pickerId, mode: 'readwrite', startIn: 'documents' });
    newlyChosen = true;
  }
  if (!handle) throw new Error('请先选择剪映草稿目录');
  let permission = await handle.queryPermission({ mode: 'readwrite' });
  if (permission !== 'granted' && requestPermission) permission = await handle.requestPermission({ mode: 'readwrite' });
  state.jianying.permission = permission;
  renderJianyingRoot();
  if (permission !== 'granted') throw new Error('未获得草稿目录读写权限，请重新选择并允许访问');
  const inspected = await inspectJianyingDirectory(handle);
  if (newlyChosen) {
    await saveJianyingHandle(handle);
    state.jianying.directoryHandle = handle;
    renderJianyingRoot();
  }
  return { handle, ...inspected };
}

async function uniqueJianyingFolderName(rootHandle, requested) {
  const base = safeJianyingFolderName(requested);
  for (let index = 1; index <= 1000; index += 1) {
    const candidate = index === 1 ? base : `${base}-${index}`;
    try {
      await rootHandle.getDirectoryHandle(candidate);
    } catch (error) {
      if (error?.name === 'NotFoundError') return candidate;
      throw error;
    }
  }
  throw new Error('无法创建不重复的剪映草稿目录');
}

async function fileHandleAt(rootHandle, rel) {
  const parts = String(rel || '').split('/').filter((part) => part && part !== '.' && part !== '..');
  if (!parts.length) throw new Error('剪映草稿文件路径无效');
  let directory = rootHandle;
  for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create: true });
  return directory.getFileHandle(parts.at(-1), { create: true });
}

async function writeTextFile(fileHandle, value) {
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(value);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
}

async function fetchJianyingExportFile(exportId, rel, start, end) {
  const query = new URLSearchParams({ rel });
  const response = await apiFetch(`/api/account/jianying-web-exports/${encodeURIComponent(exportId)}/file?${query}`, {
    headers: { Range: `bytes=${start}-${end}` },
    timeoutMs: 120_000
  });
  if (response.status !== 206) {
    const payload = await response.json().catch(() => ({}));
    throw createApiError(response, payload);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function writeJianyingBinary(exportId, file, draftHandle, onBytes) {
  const target = await fileHandleAt(draftHandle, file.rel);
  let current = await target.getFile();
  let offset = current.size > file.size ? 0 : current.size;
  if (current.size > file.size) {
    const truncate = await target.createWritable();
    await truncate.truncate(0);
    await truncate.close();
  }
  onBytes(offset);
  const chunkSize = 8 * 1024 * 1024;
  while (offset < file.size) {
    const end = Math.min(file.size - 1, offset + chunkSize - 1);
    let bytes;
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        bytes = await fetchJianyingExportFile(exportId, file.rel, offset, end);
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!bytes) throw lastError || new Error('下载剪映草稿文件失败');
    const writable = await target.createWritable({ keepExistingData: true });
    try {
      await writable.seek(offset);
      await writable.write(bytes);
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {});
      throw error;
    }
    offset += bytes.byteLength;
    onBytes(bytes.byteLength);
  }
  current = await target.getFile();
  if (current.size !== file.size) throw new Error(`文件写入校验失败：${file.rel}`);
}

async function writeJianyingJson(exportId, file, draftHandle, replacements, onBytes) {
  if (file.size > 64 * 1024 * 1024) throw new Error(`剪映 JSON 文件过大，无法安全改写：${file.rel}`);
  const query = new URLSearchParams({ rel: file.rel });
  const response = await apiFetch(`/api/account/jianying-web-exports/${encodeURIComponent(exportId)}/file?${query}`, { timeoutMs: 120_000 });
  if (!response.ok) throw createApiError(response, await response.json().catch(() => ({})));
  const source = await response.text();
  let parsed;
  try { parsed = JSON.parse(source.replace(/^\uFEFF/, '')); }
  catch { throw new Error(`剪映 JSON 文件无法解析：${file.rel}`); }
  const target = await fileHandleAt(draftHandle, file.rel);
  await writeTextFile(target, JSON.stringify(rewriteJianyingJson(parsed, replacements)));
  onBytes(file.size);
}

function jianyingExportSessionKey(outputId) {
  return `chensi-jianying-export:${state.user?.id || ''}:${outputId}`;
}

async function loadOrCreateJianyingExport(outputId) {
  const key = jianyingExportSessionKey(outputId);
  let cached;
  try { cached = JSON.parse(sessionStorage.getItem(key) || 'null'); } catch {}
  if (cached?.id) {
    try {
      const current = await request(`/api/account/jianying-web-exports/${encodeURIComponent(cached.id)}/manifest`);
      if (!['failed', 'cancelled'].includes(current.status)) return { task: current, cache: cached, key };
    } catch {}
    sessionStorage.removeItem(key);
  }
  const task = await request(`/api/projects/${state.project.id}/jianying-web-exports`, {
    method: 'POST',
    body: JSON.stringify({ sourceOutputId: outputId })
  });
  cached = { id: task.id, folderName: '' };
  sessionStorage.setItem(key, JSON.stringify(cached));
  return { task, cache: cached, key };
}

async function waitForJianyingManifest(task, button) {
  let current = task;
  const deadline = Date.now() + 10 * 60_000;
  while (current.status === 'preparing' && Date.now() < deadline) {
    const label = button?.querySelector('.button-loading-label');
    if (label) label.textContent = current.stage || '生成草稿清单';
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    current = await request(`/api/account/jianying-web-exports/${encodeURIComponent(task.id)}/manifest`);
  }
  if (current.status === 'failed') throw Object.assign(new Error(current.error || '剪映草稿清单生成失败'), { code: current.errorCode });
  if (current.status !== 'ready' || !current.manifest) throw new Error('生成剪映草稿清单超时，请重试');
  return current.manifest;
}

async function mergeJianyingIndex(directory, manifest, folderName, replacements) {
  const actualDraftPath = replacements[0].to;
  const current = await inspectJianyingDirectory(directory.handle);
  const backupName = `root_meta_info.json.chensi-${Date.now()}.bak`;
  await writeTextFile(await directory.handle.getFileHandle(backupName, { create: true }), current.sourceText);
  const updated = mergeJianyingIndexData(current.index, manifest.indexEntry, {
    folderName,
    rootPath: directory.rootPath,
    draftPath: actualDraftPath,
    replacements
  });
  try {
    await writeTextFile(current.indexHandle, JSON.stringify(updated));
    const verified = JSON.parse((await (await current.indexHandle.getFile()).text()).replace(/^\uFEFF/, ''));
    const expectedId = String(updated.all_draft_store[0]?.draft_id || '').toUpperCase();
    if (!verified.all_draft_store?.some((item) => String(item?.draft_id || '').toUpperCase() === expectedId)) {
      throw new Error('写入剪映草稿索引后校验失败');
    }
  } catch (error) {
    await writeTextFile(current.indexHandle, current.sourceText).catch(() => {});
    throw error;
  }
}

async function importOutputToBrowserJianying(outputId, button) {
  const directory = await ensureJianyingDirectory({ requestPermission: true, chooseWhenMissing: true });
  const { task, cache, key } = await loadOrCreateJianyingExport(outputId);
  state.jianying.activeExport = task.id;
  try {
    const manifest = await waitForJianyingManifest(task, button);
    const folderName = cache.folderName || await uniqueJianyingFolderName(directory.handle, manifest.draftName);
    cache.folderName = folderName;
    sessionStorage.setItem(key, JSON.stringify(cache));
    const draftHandle = await directory.handle.getDirectoryHandle(folderName, { create: true });
    const actualDraftPath = joinJianyingPath(directory.rootPath, folderName);
    const replacements = [
      { from: manifest.sourcePaths.draft, to: actualDraftPath },
      { from: manifest.sourcePaths.root, to: directory.rootPath }
    ];
    let completedBytes = 0;
    const updateProgress = (added) => {
      completedBytes += Math.max(0, Number(added) || 0);
      setButtonProgress(button, manifest.totalBytes > 0 ? completedBytes * 100 / manifest.totalBytes : 100, '写入草稿');
    };
    for (const file of manifest.files) {
      if (file.rewritePaths) await writeJianyingJson(task.id, file, draftHandle, replacements, updateProgress);
      else await writeJianyingBinary(task.id, file, draftHandle, updateProgress);
    }
    await mergeJianyingIndex(directory, manifest, folderName, replacements);
    await request(`/api/account/jianying-web-exports/${encodeURIComponent(task.id)}/complete`, { method: 'POST', body: '{}' });
    sessionStorage.removeItem(key);
    toast('剪映草稿已写入。请完全退出剪映后重新打开。');
  } finally {
    state.jianying.activeExport = null;
  }
}

function setButtonLoading(button, loading, label = '生成中') {
  if (!button) return false;
  if (loading) {
    if (button.dataset.loading === 'true') return false;
    button.dataset.loading = 'true';
    button.dataset.idleHtml = button.innerHTML;
    button.dataset.loadingLabel = label;
    button.disabled = true;
    button.classList.add('is-loading');
    button.setAttribute('aria-busy', 'true');
    button.innerHTML = `<span class="button-loading-content"><span class="button-loading-label">${esc(label)}</span><span class="loading-dots" aria-hidden="true"><i></i><i></i><i></i></span></span><span class="button-loading-progress" role="progressbar" aria-label="${esc(label)}" aria-valuetext="正在处理"><i></i></span>`;
    return true;
  }
  if (button.dataset.loading !== 'true') return true;
  button.innerHTML = button.dataset.idleHtml || button.textContent;
  delete button.dataset.idleHtml;
  delete button.dataset.loading;
  delete button.dataset.loadingLabel;
  button.disabled = false;
  button.classList.remove('is-loading', 'is-determinate');
  button.style.removeProperty('--button-loading-progress');
  button.removeAttribute('aria-busy');
  return true;
}

function setButtonProgress(button, value = null, stage = '') {
  if (!button || button.dataset.loading !== 'true') return;
  const progress = button.querySelector('.button-loading-progress');
  const numeric = Number(value);
  if (!progress || !Number.isFinite(numeric) || numeric <= 0) {
    button.classList.remove('is-determinate');
    button.style.removeProperty('--button-loading-progress');
    progress?.removeAttribute('aria-valuenow');
    progress?.setAttribute('aria-valuetext', '正在处理');
    return;
  }
  const percent = Math.max(0, Math.min(100, Math.round(numeric)));
  const stageText = String(stage || '').trim();
  button.classList.add('is-determinate');
  button.style.setProperty('--button-loading-progress', String(percent / 100));
  progress.setAttribute('aria-valuenow', String(percent));
  progress.setAttribute('aria-valuetext', stageText ? `${stageText}，${percent}%` : `已完成 ${percent}%`);
  const label = button.querySelector('.button-loading-label');
  if (stageText && label) {
    label.textContent = `${stageText} · ${percent}%`;
    label.title = label.textContent;
  }
}

async function withButtonLoading(button, work, label = '生成中') {
  if (!setButtonLoading(button, true, label)) return;
  try {
    return await work();
  } finally {
    setButtonLoading(button, false);
  }
}

const taskButtonConfig = {
  avatar_create: ['#avatarCreateButton', '形象创建任务'],
  voice_clone: ['#voiceButton', '声音克隆任务'],
  digital_human: ['#digitalHumanButton', '数字人素材任务'],
  talking_photo: ['#talkingPhotoButton', '数字人口播任务'],
  image: ['#imageButton', '配图任务'],
  video: ['#renderButton', '视频成片任务'],
  publish: ['#publishPackageButton', '发布参数清单'],
  platform_publish: ['#platformPublishButton', '平台发布任务']
};

function taskButton(kind) {
  const selector = taskButtonConfig[kind]?.[0];
  return selector ? $(selector) : null;
}

function syncTaskButtons(tasks) {
  for (const [kind, [, message]] of Object.entries(taskButtonConfig)) {
    const button = taskButton(kind);
    const activeTasks = tasks.filter((task) => task.kind === kind && ['queued', 'running'].includes(task.status));
    if (kind === 'video' && activeTasks.length > 1) {
      const timerKey = `task-batch:${activeTasks.map((task) => task.id).sort().join(':')}`;
      setButtonLoading(button, true);
      if (!polling.has(timerKey)) monitorTaskBatch(activeTasks, message, button, [], state.project?.id);
      continue;
    }
    const active = activeTasks[0];
    if (active) {
      setButtonLoading(button, true);
      setButtonProgress(button, active.progress, active.progressStage);
      if (!polling.has(`task:${active.id}`)) pollTask(active, message, button, false);
    } else {
      setButtonLoading(button, false);
    }
  }
}

function monitorBenchmark(benchmark, button = $('#analyzeBenchmarkButton'), announce = true) {
  const projectId = state.project?.id;
  if (!benchmark?.id || !projectId) return setButtonLoading(button, false);
  const timerKey = `benchmark:${benchmark.id}`;
  setButtonLoading(button, true);
  setButtonProgress(button, null);
  if (announce) toast('拆解任务已创建，正在处理');
  polling.start(timerKey, {
    projectId,
    meta: { projectId, type: 'benchmark' },
    intervalMs: 1_500,
    timeoutMs: 35 * 60_000,
    startedAt: pollStartedAt(benchmark),
    maxFailures: 3,
    poll: async () => {
      const project = await request(`/api/projects/${projectId}`, { timeoutMs: 12_000 });
      if (state.requestedProjectId !== projectId || state.project?.id !== projectId) return true;
      const current = (project.benchmarks || []).find((item) => item.id === benchmark.id);
      if (!current || ['analyzed', 'failed'].includes(current.status)) {
        setButtonLoading(button, false);
        renderProject(project);
        if (current?.status === 'failed') await loadDouyinVideoStatus();
        toast(current?.status === 'analyzed' ? '对标视频拆解已完成' : `对标视频拆解失败：${current?.error || '请查看拆解记录'}`);
        return true;
      }
      return false;
    },
    onTimeout: () => {
      if (state.requestedProjectId !== projectId || state.project?.id !== projectId) return;
      setButtonLoading(button, false);
      toast('拆解等待已超时，后台任务不受影响，可在拆解记录中查看最终状态');
    },
    onError: () => {
      if (state.requestedProjectId !== projectId || state.project?.id !== projectId) return;
      setButtonLoading(button, false);
      toast('拆解状态连续获取失败，已停止等待，请刷新后查看');
    }
  });
}

function monitorAccountAnalysis(report, announce = true) {
  const projectId = state.project?.id;
  if (!report?.id || !projectId || report.status !== 'analyzing') return;
  const timerKey = `account-analysis:${report.id}`;
  if (polling.has(timerKey)) return;
  if (announce) toast('已读取真实公开作品，正在逐条拆解');
  polling.start(timerKey, {
    meta: { projectId, type: 'account-analysis' },
    intervalMs: 2_000,
    timeoutMs: 40 * 60_000,
    startedAt: pollStartedAt(report),
    maxFailures: 3,
    poll: async () => {
      const project = await request(`/api/projects/${projectId}`, { timeoutMs: 12_000 });
      if (state.requestedProjectId !== projectId || state.project?.id !== projectId) return true;
      const current = (project.accountAnalyses || []).find((item) => item.id === report.id);
      if (!current || ['completed', 'failed'].includes(current.status)) {
        renderProject(project);
        await refreshPointsContext().catch(() => {});
        if (current?.status === 'failed') await loadDouyinVideoStatus();
        toast(current?.status === 'completed' ? '抖音账号真实作品拆解已完成' : `账号拆解失败：${current?.error || '请查看拆解记录'}`);
        return true;
      }
      return false;
    },
    onTimeout: () => {
      if (state.requestedProjectId === projectId && state.project?.id === projectId) toast('账号拆解等待已超时，已停止前台等待，请稍后刷新查看');
    },
    onError: () => {
      if (state.requestedProjectId === projectId && state.project?.id === projectId) toast('账号拆解状态连续获取失败，已停止等待，请刷新后查看');
    }
  });
}

function syncBenchmarkButton(project) {
  const active = (project.benchmarks || []).find((item) => item.status === 'analyzing');
  if (active) monitorBenchmark(active, $('#analyzeBenchmarkButton'), false);
  else setButtonLoading($('#analyzeBenchmarkButton'), false);
}

function downloadJson(filename, value) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function renderSpeechLanguageOptions() {
  const languages = (state.catalog.projectConfig?.speechLanguages || []).filter((item) => item.enabled !== false);
  const select = $('#digitalRenderLanguageInput');
  if (select) {
    const previous = select.value;
    select.innerHTML = languages.map((item) => `<option value="${esc(item.id)}">${esc(item.label)}</option>`).join('');
    const selected = languages.find((item) => item.id === previous) || languages[0];
    if (selected) select.value = selected.id;
    select.disabled = !selected;
  }
  const message = languages.length ? '普通话直接口播；英语等语言会先转换文案。维吾尔语会自动转换文案并直接生成口播音频，无需上传驱动音频。' : '当前没有可用口播语言，请联系管理员。';
  if ($('#digitalLanguageHint')) $('#digitalLanguageHint').textContent = message;
}

function setValue(selector, value) { const node = $(selector); if (node) node.value = value || ''; }

const viewContexts = {
  overview: 'AI 内容创作工作台',
  strategy: 'IP 档案与创作定位',
  benchmark: '爆款复刻与账号拆解',
  copy: '自己创、爆款改写与合规检查',
  chat: '结合当前项目资料持续对话',
  library: '文案资产的创建、查看与维护',
  media: '数字人形象、声音与封面',
  assets: '图片、视频与音频素材',
  render: '视频风格与成片输出',
  publish: '多平台账号发布',
  account: '企业席位、算力与平台账号',
  support: '客服工单与卡密权益',
  templates: '功能建议的提交与进度跟进',
  history: '生成任务与结果追踪'
};

// Keep stable references so a tab switch only changes the two affected
// panels. Re-toggling every hidden view forces a full style/layout pass on a
// page that contains many media controls and long forms.
const navItems = $$('.nav-item');
const contentViews = $$('.content-view');
const contentViewById = new Map(contentViews.map((view) => [view.id, view]));
let activeNavItem = navItems.find((item) => item.classList.contains('active')) || null;
let activeContentView = contentViews.find((view) => !view.classList.contains('hidden')) || null;

function go(view) {
  const nextContentView = contentViewById.get(`${view}View`);
  if (!nextContentView) return;
  const nextNavItem = navItems.find((item) => item.dataset.view === view) || null;
  const viewChanged = activeContentView !== nextContentView;
  state.activeView = view;
  if (activeNavItem !== nextNavItem) {
    activeNavItem?.classList.remove('active');
    activeNavItem?.removeAttribute('aria-current');
    nextNavItem?.classList.add('active');
    nextNavItem?.setAttribute('aria-current', 'page');
    activeNavItem = nextNavItem;
  }
  if (viewChanged) {
    activeContentView?.classList.add('hidden');
    activeContentView?.classList.remove('view-enter');
    nextContentView.classList.remove('hidden', 'view-enter');
    activeContentView = nextContentView;
    requestAnimationFrame(() => {
      // The user may switch again before this frame; do not animate a stale
      // panel back into the paint path.
      if (activeContentView === nextContentView) nextContentView.classList.add('view-enter');
    });
  }
  const context = $('#pageContext');
  if (context) context.textContent = viewContexts[view] || '内容生产控制台';
  // Switching views should settle immediately. A long smooth scroll competes
  // with the tab lens animation and keeps every intermediate surface in the
  // paint path on long pages.
  if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: 'auto' });
  if (view === 'render') void refreshBackgroundMusicLibrary();
}

// Bind the guided entry point before the rest of the page controls are
// initialized. A later optional control must not make the primary workflow
// entry appear inert.
document.addEventListener('click', (event) => {
  const button = event.target?.closest?.('[data-guided-start]');
  if (!button) return;
  event.preventDefault();
  go('strategy');
}, true);

// Keep the primary entry point clickable even if another interaction layer
// consumes the bubbling click event. The capture listener above remains the
// fast path; this direct listener is a guarded fallback for real pointer use.
$('#guidedStartButton')?.addEventListener('click', (event) => {
  event.preventDefault();
  if (state.activeView !== 'strategy') go('strategy');
});

function revealModeContent(element, direction = 1) {
  if (!element || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const gsap = window.gsap;
  if (!gsap) return;
  gsap.killTweensOf(element);
  gsap.fromTo(element, { x: direction * 10, opacity: .72 }, {
    x: 0,
    opacity: 1,
    duration: .24,
    ease: 'power2.out',
    clearProps: 'transform,opacity'
  });
}

function setProductionMode(mode, { focus = false } = {}) {
  const nextMode = mode === 'digital' || mode === 'talking-photo' ? mode : 'clip';
  const changed = state.productionMode !== nextMode;
  state.productionMode = nextMode;
  $$('[data-production-mode]').forEach((tab) => {
    const active = tab.dataset.productionMode === nextMode;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
    tab.tabIndex = active ? 0 : -1;
    if (active && focus) tab.focus();
  });
  $$('[data-production-panel]').forEach((panel) => {
    panel.classList.toggle('hidden', panel.dataset.productionPanel !== nextMode);
  });
  // Avoid rebuilding the shared output list on repeated tab clicks.
  if (state.project && (changed || !$('#outputList')?.dataset.outputRenderKey)) renderOutputs(state.project);
  if (changed) revealModeContent($(`[data-production-panel="${nextMode}"]`), nextMode === 'clip' ? -1 : 1);
}

function renderProjectSelect() {
  $('#projectSelect').innerHTML = state.projects.map((project) => `<option value="${esc(project.id)}">${esc(project.name)}</option>`).join('');
  if (state.project) $('#projectSelect').value = state.project.id;
}

function profilePayload() {
  return { identity: $('#identityInput').value.trim(), business: $('#businessInput').value.trim(), products: $('#productsInput').value.trim(), customers: $('#customersInput').value.trim(), style: $('#styleInput').value.trim(), painPoints: $('#painPointsInput').value.trim(), cases: $('#casesInput').value.trim() };
}

function renderProfile(profile = {}) {
  setValue('#identityInput', profile.identity);
  setValue('#businessInput', profile.business);
  setValue('#productsInput', profile.products);
  setValue('#customersInput', profile.customers);
  setValue('#styleInput', profile.style);
  setValue('#painPointsInput', profile.painPoints);
  setValue('#casesInput', profile.cases);
}

function renderPositioning(positioning = {}) {
  $('#personaValue').textContent = positioning.persona || '等待生成定位';
  $('#promiseValue').textContent = positioning.promise || '补充资料后生成一句话内容承诺';
  $('#identityValue').textContent = positioning.identity || '—';
  $('#coreProductValue').textContent = positioning.coreProduct || '—';
  $('#targetCustomerValue').textContent = positioning.targetCustomer || '—';
  $('#differentiatorValue').textContent = positioning.differentiator || '—';
  $('#painPointTags').innerHTML = (positioning.painPoints || []).map((item) => `<span class="tag">${esc(item)}</span>`).join('');
  $('#positioningBadge').textContent = positioning.persona ? '已生成' : '待生成';
  $('#angleTags').innerHTML = (positioning.contentAngles || []).map((item) => `<span class="tag">${esc(item)}</span>`).join('');
  $('#keywordList').innerHTML = (positioning.searchTerms || []).map((item) => `<span class="keyword">${esc(item)}</span>`).join('');
  $('#accountList').innerHTML = (positioning.targetAccounts || []).map((item) => `<span>${esc(item)}</span>`).join('');
}

function latestAnalyzedBenchmark(benchmarks = []) {
  return benchmarks
    .filter((item) => item.status === 'analyzed' && item.analysisVersion === 'multimodal-v1' && item.analysis)
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))[0] || null;
}

function benchmarkLibraryText(item) {
  const analysis = item?.analysis || {};
  const lines = [
    `来源：${item?.title || '真实拆解文案'}`,
    analysis.topic ? `选题：${analysis.topic}` : '',
    analysis.hook ? `开头钩子：${analysis.hook}` : '',
    analysis.structure ? `内容结构：${analysis.structure}` : '',
    analysis.keyLines?.length ? `金句 / 关键表达：${analysis.keyLines.join('、')}` : '',
    analysis.trigger ? `情绪触发：${analysis.trigger}` : '',
    analysis.trust ? `信任建立：${analysis.trust}` : '',
    analysis.conversion ? `转化逻辑：${analysis.conversion}` : '',
    analysis.transcriptSummary ? `转写摘要：${analysis.transcriptSummary}` : '',
    analysis.coverTitle ? `封面标题：${analysis.coverTitle}` : '',
    analysis.publishTitle ? `发布标题：${analysis.publishTitle}` : '',
    analysis.tags?.length ? `标签：${analysis.tags.join('、')}` : ''
  ];
  return lines.filter(Boolean).join('\n');
}

function openBenchmarkLibraryEditor(benchmarkId) {
  const benchmark = (state.project?.benchmarks || []).find((item) => item.id === benchmarkId);
  if (!benchmark) return toast('没有找到这条拆解记录');
  openCopyLibraryModal();
  $('#copyLibraryProjectInput').value = state.project.id;
  $('#copyLibraryModeInput').value = 'standard';
  $('#copyLibraryTitleInput').value = benchmark.analysis?.publishTitle || benchmark.title || '真实拆解文案';
  $('#copyLibraryTextInput').value = benchmarkLibraryText(benchmark);
  $('#copyLibraryModalTitle').textContent = '编辑拆解文案并保存';
  $('#saveCopyLibraryButton').textContent = '保存到文案库';
  window.uiSelect.refresh($('#copyLibraryProjectInput'));
  window.uiSelect.refresh($('#copyLibraryModeInput'));
}

async function saveBenchmarkToLibrary(benchmarkId, button) {
  const benchmark = (state.project?.benchmarks || []).find((item) => item.id === benchmarkId);
  if (!benchmark?.analysis) return toast('拆解尚未完成，暂时无法保存');
  if (!setButtonLoading(button, true, '保存中')) return;
  try {
    await request('/api/copies', {
      method: 'POST',
      body: JSON.stringify({
        projectId: state.project.id,
        title: benchmark.analysis.publishTitle || benchmark.title || '真实拆解文案',
        mode: 'standard',
        text: benchmarkLibraryText(benchmark)
      })
    });
    await loadCopies();
    toast('拆解文案已保存到文案库');
  } catch (error) {
    toast(error.message);
  } finally {
    setButtonLoading(button, false);
  }
}

function renderBenchmarks(benchmarks = []) {
  $('#benchmarkCount').textContent = String(benchmarks.length).padStart(2, '0');
  $('#benchmarkReadyCount').textContent = String(benchmarks.filter((item) => item.status === 'analyzed' && item.analysisVersion === 'multimodal-v1').length);
  $('#benchmarkList').innerHTML = benchmarks.length ? benchmarks.map((item) => {
    const analysis = item.analysisVersion === 'multimodal-v1' ? item.analysis : null;
    const labels = { analyzing: '分析中', analyzed: '已拆解', failed: '失败' };
    const source = item.sourceText || item.sourceUrl || item.url || (item.assetId ? `素材库文件 · ${item.assetId}` : '');
    const pending = item.status === 'failed' ? `${item.errorCode ? `[${item.errorCode}] ` : ''}${item.error || '分析失败'}` : item.analysis && !analysis ? '旧版拆解没有携带视频证据，请重新拆解' : item.mediaAnalysis?.summary || '等待真实解析结果…';
    const timeline = (analysis?.timeline || []).map((segment) => `${Number(segment.start).toFixed(1)}s-${Number(segment.end).toFixed(1)}s：${segment.visual || ''}${segment.speech ? `；口播：${segment.speech}` : ''}`).join('\n');
    const evidence = (analysis?.evidence || []).join('；');
    const retry = item.status === 'failed' || (item.analysis && !analysis) ? `<button class="quiet-button" data-reanalyze-benchmark="${esc(item.id)}">重新拆解</button>` : '';
    const libraryActions = analysis ? `<div class="benchmark-library-actions"><button class="quiet-button" data-edit-benchmark="${esc(item.id)}">编辑后保存</button><button class="secondary-button small" data-save-benchmark="${esc(item.id)}">保存到文案库</button></div>` : '';
    return `<article class="benchmark-item"><div class="benchmark-top"><span class="benchmark-title">${esc(item.title)}</span><span class="platform-chip">${esc(item.platform || '待识别')} · ${labels[item.status] || esc(item.status)}</span><div class="row-actions">${retry}<button class="danger-button" data-delete-kind="benchmarks" data-delete-id="${esc(item.id)}" data-delete-label="对标记录">删除</button></div></div><div class="benchmark-url" title="${esc(source)}">${esc(source)}</div>${analysis ? `<div class="benchmark-analysis"><div class="analysis-chip"><b>选题</b>${esc(analysis.topic || '')}</div><div class="analysis-chip"><b>开头钩子</b>${esc(analysis.hook || '')}</div><div class="analysis-chip"><b>内容结构</b>${esc(analysis.structure || '')}</div><div class="analysis-chip"><b>金句 / 关键表达</b>${esc((analysis.keyLines || []).join('、'))}</div><div class="analysis-chip"><b>情绪触发</b>${esc(analysis.trigger || '')}</div><div class="analysis-chip"><b>信任建立</b>${esc(analysis.trust || '')}</div><div class="analysis-chip"><b>转化逻辑</b>${esc(analysis.conversion || '')}</div><div class="analysis-chip"><b>标题 / 标签</b>${esc([analysis.coverTitle, analysis.publishTitle, ...(analysis.tags || [])].filter(Boolean).join(' · '))}</div><div class="analysis-chip analysis-wide"><b>转写摘要</b>${esc(analysis.transcriptSummary || '')}</div><div class="analysis-chip analysis-wide"><b>真实时间轴</b><pre>${esc(timeline)}</pre></div><div class="analysis-chip analysis-wide"><b>时间证据</b>${esc(evidence)}</div></div>${libraryActions}` : `<div class="benchmark-url">${esc(pending)}</div>`}</article>`;
  }).join('') : '<div class="empty-state">还没有对标视频</div>';
}

function renderCopyBenchmarkReferences(benchmarks = []) {
  const container = $('#copyBenchmarkReferences');
  if (!container) return;
  const enabled = $('#copyUseBenchmarkReferenceInput')?.checked !== false;
  container.classList.toggle('hidden', !enabled);
  if (!enabled) {
    container.replaceChildren();
    return;
  }
  const latest = latestAnalyzedBenchmark(benchmarks);
  if (!latest) {
    container.innerHTML = '<div class="copy-reference-summary is-unavailable" role="status"><span class="copy-reference-mark" aria-hidden="true">↗</span><span><strong>真实拆解参考</strong><small>暂无已完成的真实拆解；完成后生成文案会自动引用最近一条。</small></span></div>';
    return;
  }
  container.innerHTML = `<div class="copy-reference-summary" role="status"><span class="copy-reference-mark" aria-hidden="true">↗</span><span><strong>自动参考最近一次真实拆解</strong><small>当前样本：${esc(latest.title || '最近拆解')}。生成时自动采用其结构与节奏，不需要手动选择。</small></span></div>`;
}

function renderAccountAnalyses(items = []) {
  $('#accountAnalysisList').innerHTML = items.length ? items.map((item) => {
    const analysis = item.analysis || {};
    const list = (value) => (value || []).map(esc).join('；') || '—';
    const statusLabel = item.status === 'analyzing' ? '真实作品拆解中' : item.status === 'failed' ? '拆解失败' : '已完成';
    const statusBody = item.status === 'analyzing' ? `<div class="account-analysis-pending">${esc(publicFeatureText(item.notice || '正在逐条读取真实公开作品并完成视频拆解…'))}</div>` : item.status === 'failed' ? `<div class="account-analysis-pending error">${esc(publicFeatureText(item.error || '账号拆解失败'))}</div>` : `<div class="account-analysis-grid"><div><b>账号定位</b>${esc(analysis.positioning || '—')}</div><div><b>目标受众</b>${esc(analysis.audience || '—')}</div><div><b>内容支柱</b>${list(analysis.contentPillars)}</div><div><b>钩子模式</b>${list(analysis.hookPatterns)}</div><div><b>结构模式</b>${list(analysis.structurePatterns)}</div><div><b>语言风格</b>${esc(analysis.languageStyle || '—')}</div><div><b>视觉风格</b>${esc(analysis.visualStyle || '—')}</div><div><b>转化模式</b>${list(analysis.conversionPatterns)}</div><div><b>可复用公式</b>${esc(analysis.reusableFormula || '—')}</div><div><b>样本证据与限制</b>${list([...(analysis.evidence || []), ...(analysis.limitations || [])])}</div></div>`;
    return `<article class="account-analysis-item"><div class="account-analysis-heading"><span class="platform-symbol">抖</span><div><strong>${esc(item.account)}</strong><small>${new Date(item.createdAt).toLocaleString('zh-CN')} · ${item.sampleCount || 0} 条真实作品 · ${esc(statusLabel)}</small></div><button class="danger-button" data-delete-kind="account-analyses" data-delete-id="${esc(item.id)}" data-delete-label="账号拆解报告">删除</button></div>${statusBody}<p class="field-hint">${esc(publicFeatureText(item.notice || ''))}</p></article>`;
  }).join('') : '<div class="empty-state">填写抖音主页链接、抖音号或账号标识后，系统会读取真实公开作品并逐条拆解。</div>';
}

function activeCopy() {
  const variants = state.project?.copyVariants || {};
  if (variants[state.copyMode]) return variants[state.copyMode];
  if (state.project?.copy?.mode === state.copyMode) return state.project.copy;
  return null;
}

function copyScriptText(copy = {}) {
  const mode = copy.mode || state.copyMode;
  return mode === 'qa' ? (copy.qaScript || []).join('\n') : String(copy.script || '');
}

function syncCopyToDigitalHumanInputs(copy, { force = false } = {}) {
  const script = copyScriptText(copy).trim();
  if (!script) return false;
  const title = String(copy?.publishTitle || copy?.coverTitle || '').trim();
  [
    ['#digitalScriptInput', script],
    ['#talkingPhotoScriptInput', script],
    ['#digitalRenderNameInput', title],
    ['#talkingPhotoNameInput', title]
  ].forEach(([selector, value]) => {
    const input = $(selector);
    if (input && (force || !input.value.trim())) input.value = value;
  });
  return true;
}

const autoReplaceableComplianceTerms = new Set([
  '最好', '最强', '最高', '最低', '最便宜', '第一', '唯一', '百分之百', '绝对',
  '保证', '包治', '根治', '稳赚', '零风险', '永久有效',
  '私信领', '评论区扣', '点赞过万', '转发抽奖'
]);

function buildCopyClipboardText(copy = {}, mode = state.copyMode) {
  const fields = [
    ['封面标题', copy.coverTitle],
    ['发布标题', copy.publishTitle],
    [mode === 'qa' ? '问答脚本' : '标准口播稿', mode === 'qa' ? (copy.qaScript || []).join('\n') : copy.script],
    ['建议标签', (copy.tags || []).join('，')],
    ['分镜建议', (copy.shots || []).map((item, index) => `${index + 1}. ${item}`).join('\n')],
    ['数字人呈现建议', copy.avatarDirection],
    ['素材插入建议', (copy.assetSuggestions || []).map((item, index) => `${index + 1}. ${item}`).join('\n')]
  ];
  return fields
    .filter(([, value]) => String(value || '').trim())
    .map(([label, value]) => `${label}\n${String(value).trim()}`)
    .join('\n\n');
}

async function writeTextToClipboard(value) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const fallback = document.createElement('textarea');
  fallback.value = value;
  fallback.setAttribute('readonly', '');
  fallback.style.position = 'fixed';
  fallback.style.opacity = '0';
  document.body.append(fallback);
  fallback.select();
  const copied = document.execCommand('copy');
  fallback.remove();
  if (!copied) throw new Error('浏览器未授予剪贴板权限，请手动复制');
}

function syncCopyModeUi() {
  $$('.copy-mode').forEach((button) => {
    const active = button.dataset.copyMode === state.copyMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  const button = $('#copyButton');
  if (button && button.dataset.loading !== 'true') button.textContent = activeCopy() ? `重新生成${state.copyMode === 'qa' ? '问答文案' : '标准口播'}` : `生成${state.copyMode === 'qa' ? '问答文案' : '标准口播'}`;
}

function setCopyMode(mode) {
  if ($('#copyButton')?.dataset.loading === 'true') return;
  const nextMode = mode === 'qa' ? 'qa' : 'standard';
  const changed = state.copyMode !== nextMode;
  state.copyMode = nextMode;
  const copy = activeCopy();
  if (copy) state.project.copy = copy;
  syncCopyModeUi();
  renderCopy(copy || {}, state.copyMode);
  if (changed) revealModeContent($('#copyContent'), nextMode === 'qa' ? 1 : -1);
}

function setCopyModeBusy(busy) {
  $$('.copy-mode').forEach((button) => {
    button.disabled = busy;
    button.setAttribute('aria-disabled', busy ? 'true' : 'false');
  });
}

function renderCopy(copy = {}, mode = state.copyMode) {
  const content = $('#copyContent');
  const hasCopy = Boolean(copy && Object.keys(copy).length);
  const qaLines = mode === 'qa' ? (copy.qaScript || []) : [];
  const riskTerms = [...(copy.compliance?.hits || []).map((item) => item.term), ...(copy.originality?.repeatedPhrases || [])];
  const body = mode === 'qa'
    ? `<div class="qa-script-list">${qaLines.map((line, index) => `<div class="qa-script-row"><span>${index % 2 === 0 ? 'Q' : 'A'}</span><p>${markTerms(line, riskTerms)}</p></div>`).join('') || '<div class="empty-state">点击生成问答文案，获取 Q/A 交替脚本。</div>'}</div>`
    : `<div class="script-box">${markTerms(copy.script || (hasCopy ? '当前模式没有返回可用口播稿，请重新生成。' : '点击生成标准口播，获取可直接朗读的文案。'), riskTerms)}</div>`;
  const titles = `<div class="copy-result-section"><div class="copy-section-heading"><span>标题与标签</span></div><div class="title-block"><div><div class="result-label">封面标题</div><div class="copy-value">${markTerms(copy.coverTitle || '等待生成', riskTerms)}</div></div><div><div class="result-label">发布标题</div><div class="copy-value">${markTerms(copy.publishTitle || '等待生成', riskTerms)}</div></div><div><div class="result-label">建议标签</div><div class="tag-list">${(copy.tags || []).map((tag) => `<span class="tag">${esc(tag)}</span>`).join('') || '<span class="copy-empty-inline">生成后显示标签</span>'}</div></div></div></div>`;
  const shots = `<div class="copy-result-section"><div class="copy-section-heading"><span>分镜建议</span></div><div class="shot-list">${(copy.shots || []).map((shot, index) => `<div class="shot-row"><span class="shot-index">${String(index + 1).padStart(2, '0')}</span><span>${esc(shot)}</span></div>`).join('') || '<div class="empty-state">生成后显示分镜建议</div>'}</div></div>`;
  const production = `<div class="copy-result-section"><div class="copy-section-heading"><span>数字人呈现建议</span></div><div class="production-direction">${esc(copy.avatarDirection || '生成后显示数字人的语气、动作和呈现建议')}</div></div><div class="copy-result-section"><div class="copy-section-heading"><span>素材插入建议</span></div><div class="suggestion-list">${(copy.assetSuggestions || []).map((item, index) => `<div class="suggestion-row"><span>${String(index + 1).padStart(2, '0')}</span><p>${esc(item)}</p></div>`).join('') || '<div class="empty-state">生成后显示素材插入建议</div>'}</div></div>`;
  const complianceHits = (copy.compliance?.hits || []).map((item) => `${item.category}：${item.term}${item.suggestion ? ` → ${item.suggestion}` : ''}`);
  const replaceableHitCount = (copy.compliance?.hits || []).filter((item) => autoReplaceableComplianceTerms.has(item.term)).length;
  const complianceAction = replaceableHitCount
    ? `<button class="secondary-button small copy-compliance-action" type="button" data-replace-compliance-terms>一键替换 ${replaceableHitCount} 处风险词</button>`
    : '';
  const compliance = copy.compliance ? `<div class="copy-compliance ${copy.compliance.riskLevel === 'pass' ? 'pass' : 'review'}"><div class="copy-compliance-copy"><strong>${copy.compliance.riskLevel === 'pass' ? '违规词规则检查通过' : '违规词需人工复核'}</strong><span>${complianceHits.length ? esc(complianceHits.join('；')) : `已检查 ${copy.compliance.checkedRuleCount || 0} 个本地风险词，未发现命中。`}${copy.compliance.ignoredHits?.length ? ` 已按上下文排除 ${copy.compliance.ignoredHits.length} 处非宣传用法。` : ''} 规则版本 ${esc(copy.compliance.ruleVersion || 'legacy')}；发布前仍需人工确认事实与平台规则。</span></div>${complianceAction}</div>` : '';
  const originality = copy.originality ? `<div class="copy-compliance ${copy.originality.riskLevel === 'pass' ? 'pass' : 'review'}"><strong>${copy.originality.riskLevel === 'pass' ? '本地查重通过' : '本地相似内容需复核'}</strong><span>已对比本人文案库 ${copy.originality.checkedCount || 0} 篇，最高相似度 ${Math.round((copy.originality.maxSimilarity || 0) * 100)}%，后台阈值 ${Math.round((copy.originality.threshold ?? 0.65) * 100)}%。${(copy.originality.repeatedPhrases || []).length ? `重复句：${esc(copy.originality.repeatedPhrases.join('；'))}` : '未发现完整重复句。'} 此结果不包含互联网全网查重。</span></div>` : '';
  content.innerHTML = `<div class="copy-primary-section"><div class="copy-section-heading"><span>${mode === 'qa' ? '问答文案' : '标准口播稿'}</span></div>${body}</div>${titles}${shots}${production}${compliance}${originality}`;
}

async function generateCopyMode(mode = state.copyMode) {
  if (!state.project) return null;
  const nextMode = mode === 'qa' ? 'qa' : 'standard';
  state.copyMode = nextMode;
  syncCopyModeUi();
  renderCopy({}, nextMode);
  const button = $('#copyButton');
  setCopyModeBusy(true);
  try {
    return await withButtonLoading(button, async () => {
      const payload = {
        mode: nextMode,
        draft: $('#copyDraftInput').value.trim(),
        useHistory: $('#copyUseHistoryInput').checked,
        inheritBenchmarkTitle: $('#copyInheritTitleInput').checked
      };
      // Omitted means "use the latest completed teardown"; an explicit empty
      // selection tells the API to skip teardown references entirely.
      if (!$('#copyUseBenchmarkReferenceInput')?.checked) payload.benchmarkIds = [];
      const generated = await request(`/api/projects/${state.project.id}/copy`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      state.project.copyVariants ||= {};
      state.project.copyVariants[nextMode] = generated;
      state.project.copy = generated;
      syncCopyToDigitalHumanInputs(generated, { force: true });
      renderCopy(generated, nextMode);
      renderOverview(state.project);
      syncWorkflowNextSteps(state.project);
      await loadCopies();
      toast(`${nextMode === 'qa' ? '问答式' : '标准'}文案已生成`);
      return generated;
    }, nextMode === 'qa' ? '生成问答文案中' : '生成标准口播中');
  } finally {
    setCopyModeBusy(false);
    syncCopyModeUi();
    await refreshPointsContext().catch(() => {});
  }
}

function assetMediaType(asset) {
  const mimeType = String(asset.mimeType || '');
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'file';
}

const AUTO_EDIT_CATEGORIES = ['场景', '产品', '案例', '人物', '生活', '口播', '教程', '过程', '效果', '其他'];

function inferAutoEditCategory(asset) {
  const text = `${asset?.name || ''} ${Array.isArray(asset?.tags) ? asset.tags.join(' ') : ''} ${asset?.description || ''}`.toLowerCase();
  if (/(案例|客户|项目|交付|testimonial|case)/i.test(text)) return '案例';
  if (/(人物|人像|员工|客户出镜|模特|主持|person|portrait)/i.test(text)) return '人物';
  if (/(教程|步骤|教学|怎么|如何|安装|tutorial|guide)/i.test(text)) return '教程';
  if (/(效果|对比|前后|成果|测试结果|result|before|after)/i.test(text)) return '效果';
  if (/(工厂|生产|制造|加工|装配|包装|质检|车间|流程|process|factory)/i.test(text)) return '过程';
  if (/(口播|访谈|讲解|演讲|采访|talk|speech)/i.test(text)) return '口播';
  if (/(生活|家庭|办公室|旅行|户外|使用场景|lifestyle|home|office)/i.test(text)) return '生活';
  if (/(产品|细节|特写|外观|功能|接口|插头|排插|插座|设备|product|detail)/i.test(text)) return '产品';
  return String(asset?.kind || '场景').trim() || '场景';
}

function assetAutoEditCategory(asset) {
  const explicit = String(asset?.autoEditCategory || asset?.category || '').trim();
  return explicit && explicit !== '自动识别' ? explicit : inferAutoEditCategory(asset);
}

function projectAutoEditCategoryRecords(project = state.project) {
  return Array.isArray(project?.autoEditCategories) ? project.autoEditCategories : [];
}

function projectAutoEditCategoryNames(project = state.project) {
  const values = [
    ...projectAutoEditCategoryRecords(project).map((item) => item.name),
    ...(project?.assets || []).filter((asset) => assetMediaType(asset) === 'video').map(assetAutoEditCategory),
    ...AUTO_EDIT_CATEGORIES,
  ];
  const seen = new Set();
  return values.map((value) => String(value || '').trim()).filter((value) => {
    const key = value.toLocaleLowerCase('zh-CN');
    if (!value || value === '自动识别' || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function assetCategoryOptions(selected, { includeAutomatic = false } = {}) {
  const categories = projectAutoEditCategoryNames();
  if (selected && selected !== '自动识别' && !categories.includes(selected)) categories.unshift(selected);
  return `${includeAutomatic ? `<option value="自动识别" ${selected === '自动识别' ? 'selected' : ''}>自动识别</option>` : ''}${categories.map((category) => `<option value="${esc(category)}" ${category === selected ? 'selected' : ''}>${esc(category)}</option>`).join('')}`;
}

function renderAssetCategoryControls(project = state.project) {
  if (!project) return;
  const upload = $('#assetUploadCategoryInput');
  if (upload) {
    const previous = upload.value || '自动识别';
    upload.innerHTML = assetCategoryOptions(previous, { includeAutomatic: true });
    upload.value = [...upload.options].some((option) => option.value === previous) ? previous : '自动识别';
    window.uiSelect?.refresh(upload);
  }
  const filter = $('#assetKindFilter');
  if (filter) {
    const previous = filter.value || '全部类型';
    filter.innerHTML = `<option value="全部类型">全部分类</option>${projectAutoEditCategoryNames(project).map((category) => `<option value="${esc(category)}">${esc(category)}</option>`).join('')}`;
    filter.value = [...filter.options].some((option) => option.value === previous) ? previous : '全部类型';
    window.uiSelect?.refresh(filter);
  }
}

function assetPosterUrl(asset) {
  const accessUrl = String(asset?.accessUrl || '');
  const posterUrl = accessUrl.replace(/\/content(?:\?.*)?$/, '/poster');
  if (!posterUrl || posterUrl === accessUrl) return '';
  return `${posterUrl}?v=${encodeURIComponent(asset.sha256 || asset.id || '1')}`;
}

function assetThumbnail(asset) {
  const type = assetMediaType(asset);
  const url = esc(asset.accessUrl || '');
  if (type === 'image') return `<img src="${url}" alt="" loading="lazy" />`;
  if (type === 'video') return `<img src="${esc(assetPosterUrl(asset))}" alt="" loading="lazy" decoding="async" /><span class="asset-play-mark">▶</span>`;
  if (type === 'audio') return '<span class="asset-type-mark">AUDIO</span>';
  return '<span class="asset-type-mark">FILE</span>';
}

function fillAssetSelect(selector, assets, { emptyLabel, blankLabel = '' } = {}) {
  const select = $(selector);
  if (!select) return;
  const previous = select.value;
  if (!assets.length) {
    select.innerHTML = `<option value="">${esc(emptyLabel || '暂无可用素材')}</option>`;
    select.disabled = true;
    return;
  }
  select.disabled = false;
  select.innerHTML = `${blankLabel ? `<option value="">${esc(blankLabel)}</option>` : ''}${assets.map((asset) => `<option value="${esc(asset.id)}">${esc(asset.name)} · ${esc(asset.size || '大小未知')}</option>`).join('')}`;
  if (assets.some((asset) => asset.id === previous)) select.value = previous;
  else select.value = blankLabel ? '' : assets[0].id;
}

const hiddenReferenceAssetNames = new Set([
  '屏幕截图 2026-08-31 182218.png',
  '屏幕截图 2026-08-31 182215.png'
]);

function isHiddenReferenceAsset(asset) {
  const values = [asset?.name, asset?.originalName, asset?.sourcePath, asset?.filePath]
    .map((value) => String(value || '').trim().split(/[\\/]/).pop().toLowerCase());
  return values.some((value) => hiddenReferenceAssetNames.has(value));
}

function isAutoEditOutputAsset(asset, project = state.project) {
  const output = (project?.outputs || []).find((item) => String(item.id) === String(asset?.sourceOutputId || ''));
  return output?.template === 'vlog'
    || /(?:^|[-_\s])auto[-_\s]?edit(?:\.|[-_\s]|$)/i.test(String(asset?.name || ''))
    || (asset?.tags || []).some((tag) => /自动剪辑|auto[-_\s]?edit/i.test(String(tag)));
}

function pickerAssets(project, type, { excludeAutoEdit = false } = {}) {
  return (project?.assets || []).filter((asset) => (
    assetMediaType(asset) === type
    && !(type === 'image' && isHiddenReferenceAsset(asset))
    && !(type === 'video' && excludeAutoEdit && isAutoEditOutputAsset(asset, project))
  ));
}

function renderAssetPickerTrigger(type, assets) {
  const container = type === 'image' ? $('#imageReferencePicker') : $('#renderAssetPicker');
  if (!container) return;
  const selected = state.assetPicker[type] || [];
  const count = selected.length;
  const autoEdit = type === 'video' && ($('#renderTemplateInput')?.value || 'vlog') === 'vlog';
  const label = type === 'image' ? '选择参考图' : autoEdit ? '选择主视频' : '选择视频素材';
  const countLabel = type === 'image'
    ? (count ? `已选择 ${count} 张参考图 · 最多 4 张` : '未选择参考图 · 最多 4 张')
    : autoEdit
      ? (count ? '已选择主视频，其余视频将从素材库自动匹配' : '未选择主视频')
      : (count ? `已选择 ${count} 条视频素材，将按列表顺序处理` : '未选择视频素材');
  container.innerHTML = `<button class="asset-picker-trigger" type="button" data-open-asset-picker="${type}" ${assets.length ? '' : 'disabled'}><span class="asset-picker-trigger-icon" aria-hidden="true">＋</span><span><strong>${label}</strong><small>${assets.length ? '打开素材库选择' : `暂无${type === 'image' ? '图片' : '视频'}素材`}</small></span></button><span class="asset-picker-selection" aria-live="polite">${esc(countLabel)}</span>`;
}

let activeAssetPicker = null;

function assetPickerOption(asset, type, index) {
  const checked = activeAssetPicker?.draft?.includes(asset.id);
  const singleVideo = type === 'video' && ($('#renderTemplateInput')?.value || 'vlog') === 'vlog';
  const media = type === 'image'
    ? `<img src="${esc(asset.accessUrl || '')}" alt="" loading="lazy" />`
    : `<img src="${esc(assetPosterUrl(asset))}" alt="" loading="lazy" decoding="async" />`;
  const metadata = [type === 'video' ? assetAutoEditCategory(asset) : '', asset.durationSeconds ? `${asset.durationSeconds}s` : asset.size || '大小未知'].filter(Boolean).join(' · ');
  return `<label class="asset-picker-option"><input type="${singleVideo ? 'radio' : 'checkbox'}" ${singleVideo ? 'name="asset-picker-main-video"' : ''} data-asset-picker-choice value="${esc(asset.id)}" ${checked ? 'checked' : ''}><span class="asset-picker-option-media">${media}</span><span class="asset-picker-option-copy"><strong>${esc(asset.name || '未命名素材')}</strong><small>${esc(metadata)}</small></span><span class="asset-picker-option-order">${String(index + 1).padStart(2, '0')}</span></label>`;
}

function renderAssetPickerModal() {
  if (!activeAssetPicker) return;
  const { type, assets, draft } = activeAssetPicker;
  const autoEdit = type === 'video' && ($('#renderTemplateInput')?.value || 'vlog') === 'vlog';
  const title = type === 'image' ? '选择参考图' : autoEdit ? '选择主视频' : '选择视频素材';
  const limit = type === 'image' ? '最多选择 4 张' : autoEdit ? '仅选择 1 条，其他素材自动匹配' : '最多选择 12 条';
  $('#assetPickerModalTitle').textContent = title;
  $('#assetPickerModalHint').textContent = `${limit} · 已选择 ${draft.length}`;
  $('#assetPickerBody').innerHTML = assets.length
    ? assets.map((asset, index) => assetPickerOption(asset, type, index)).join('')
    : '<div class="empty-state">当前项目暂无可选择素材</div>';
}

function openAssetPicker(type, trigger) {
  const excludeAutoEdit = type === 'video' && ($('#renderTemplateInput')?.value || 'vlog') === 'vlog';
  const assets = pickerAssets(state.project, type, { excludeAutoEdit });
  const valid = new Set(assets.map((asset) => asset.id));
  const current = (state.assetPicker[type] || []).filter((id) => valid.has(id));
  activeAssetPicker = { type, assets, draft: [...current], returnFocus: trigger };
  renderAssetPickerModal();
  window.uiDialog.open($('#assetPickerModal'), { initialFocus: '#assetPickerBody', returnFocus: trigger });
}

function closeAssetPicker() {
  const current = activeAssetPicker;
  activeAssetPicker = null;
  window.uiDialog.close($('#assetPickerModal'));
  if (current?.returnFocus && document.contains(current.returnFocus)) current.returnFocus.focus();
}

function confirmAssetPicker() {
  if (!activeAssetPicker) return;
  state.assetPicker[activeAssetPicker.type] = [...activeAssetPicker.draft];
  renderMaterialSelectors(state.project);
  closeAssetPicker();
}

function talkingPhotoCapabilities() {
  const catalogEntry = (state.catalog?.providers || []).find((item) => item.id === 'talking-photo');
  const catalogSupportsVoiceCloning = Boolean(catalogEntry?.capabilities?.includes('private-voice-clone'));
  const catalogReusesMediaVoices = Array.isArray(catalogEntry?.capabilities)
    ? catalogEntry.capabilities.includes('reuse-media-lab-voice')
    : true;
  const supportsVoiceCloning = state.talkingPhotoStatus?.supportsVoiceCloning ?? catalogSupportsVoiceCloning;
  const reusesMediaVoices = state.talkingPhotoStatus?.reusesMediaVoices ?? catalogReusesMediaVoices;
  return {
    supportsVoiceCloning,
    reusesMediaVoices,
    requiresVoiceSelection: state.talkingPhotoStatus?.requiresVoiceSelection ?? (supportsVoiceCloning || reusesMediaVoices)
  };
}

function renderTalkingPhotoCapabilities() {
  const { requiresVoiceSelection } = talkingPhotoCapabilities();
  $('#talkingPhotoVoiceSetup')?.classList.toggle('hidden', !requiresVoiceSelection);
  $('#talkingPhotoSystemVoiceNotice')?.classList.toggle('hidden', requiresVoiceSelection);
  if ($('#talkingPhotoContentStep')) $('#talkingPhotoContentStep').textContent = requiresVoiceSelection ? '03' : '02';
  window.uiSelect?.refresh($('#talkingPhotoAspectRatioInput'));
}

function renderMaterialSelectors(project) {
  renderTalkingPhotoCapabilities();
  const assets = project.assets || [];
  const images = pickerAssets(project, 'image');
  const videos = assets.filter((asset) => assetMediaType(asset) === 'video');
  const excludeAutoEdit = ($('#renderTemplateInput')?.value || 'vlog') === 'vlog';
  const renderVideos = pickerAssets(project, 'video', { excludeAutoEdit });
  const audios = assets.filter((asset) => assetMediaType(asset) === 'audio');
  const cloneSamples = audios.filter((asset) => !(asset.tags || []).includes('试听'));
  fillAssetSelect('#avatarVideoAssetInput', videos, { emptyLabel: '暂无视频素材，请先上传' });
  fillAssetSelect('#voiceAudioAssetInput', cloneSamples, { emptyLabel: '暂无音频素材，可填写外部地址', blankLabel: '不选择素材库文件' });
  fillAssetSelect('#digitalAudioAssetInput', audios, { emptyLabel: '暂无音频素材', blankLabel: '使用文案合成语音' });
  fillAssetSelect('#renderAudioAssetInput', audios, { emptyLabel: '暂无音频素材', blankLabel: '保留视频原音' });
  fillAssetSelect('#talkingPhotoImageSelect', images, { emptyLabel: '暂无图片素材，请先上传' });
  window.uiSelect?.refresh($('#talkingPhotoImageSelect'));
  const imageIds = new Set(images.map((asset) => asset.id));
  state.assetPicker.image = (state.assetPicker.image || []).filter((assetId) => imageIds.has(assetId));
  const videoIds = new Set(renderVideos.map((asset) => asset.id));
  state.assetPicker.video = (state.assetPicker.video || []).filter((assetId) => videoIds.has(assetId));
  renderAssetPickerTrigger('image', images);
  renderAssetPickerTrigger('video', renderVideos);
  updateImageReferenceSummary();
  updateRenderAssetSummary();
  const avatarSelect = $('#digitalAvatarSelect');
  if (avatarSelect) {
    const avatars = project.avatars || [];
    const previousAvatar = avatarSelect.value;
    avatarSelect.innerHTML = avatars.length ? avatars.map((item) => `<option value="${esc(item.id)}">${esc(item.name)} · ${esc(item.status)}</option>`).join('') : '<option value="">暂无已保存形象，请先创建</option>';
    avatarSelect.disabled = !avatars.length;
    if (avatars.some((item) => item.id === previousAvatar)) avatarSelect.value = previousAvatar;
  }
  const voiceSelect = $('#digitalVoiceSelect');
  if (voiceSelect) {
    const previousVoice = voiceSelect.value;
    const voices = (project.voices || []).filter((item) => item.digitalHumanCompatible !== false
      && item.voiceService !== 'talking_photo'
      && !String(item.provider || '').toLowerCase().startsWith('heygen'));
    voiceSelect.innerHTML = voices.length ? voices.map((item) => `<option value="${esc(item.id)}">媒体实验室 · ${esc(item.name)} · ${esc(item.status)}</option>`).join('') : '<option value="">暂无已保存声音，请先克隆</option>';
    voiceSelect.disabled = !voices.length;
    if (voices.some((item) => item.id === previousVoice)) voiceSelect.value = previousVoice;
    window.uiSelect?.refresh(voiceSelect);
  }
  const talkingPhotoVoiceSelect = $('#talkingPhotoVoiceSelect');
  if (talkingPhotoVoiceSelect) {
    const { requiresVoiceSelection } = talkingPhotoCapabilities();
    const voices = (project.voices || []).filter((item) => item.digitalHumanCompatible !== false
      && item.voiceService !== 'talking_photo'
      && !String(item.provider || '').toLowerCase().startsWith('heygen'));
    const previousVoice = talkingPhotoVoiceSelect.value;
    talkingPhotoVoiceSelect.innerHTML = requiresVoiceSelection
      ? voices.length ? `<option value="">请选择声音</option>${voices.map((item) => `<option value="${esc(item.id)}">媒体实验室 · ${esc(item.name)} · ${esc(item.status)}</option>`).join('')}` : '<option value="">请先到媒体实验室复刻声音</option>'
      : '<option value="">使用系统语音</option>';
    talkingPhotoVoiceSelect.disabled = !requiresVoiceSelection || !voices.length;
    if (requiresVoiceSelection && voices.some((item) => item.id === previousVoice)) talkingPhotoVoiceSelect.value = previousVoice;
    else if (requiresVoiceSelection && voices[0]) talkingPhotoVoiceSelect.value = voices[0].id;
    window.uiSelect?.refresh(talkingPhotoVoiceSelect);
  }
  const coverSource = $('#coverFrameSourceInput');
  if (coverSource) {
    const sources = [
      ...videos.map((item) => ({ value: `asset:${item.id}`, label: `素材 · ${item.name}` })),
      ...(project.outputs || []).filter((item) => item.status === 'ready' && item.storageKey).map((item) => ({ value: `output:${item.id}`, label: `成片 · ${item.title || item.filename || item.id}` }))
    ];
    const previous = coverSource.value;
    coverSource.innerHTML = sources.length ? sources.map((item) => `<option value="${esc(item.value)}">${esc(item.label)}</option>`).join('') : '<option value="">暂无可截帧的视频素材或成片</option>';
    coverSource.disabled = !sources.length;
    if (sources.some((item) => item.value === previous)) coverSource.value = previous;
  }
}

function selectedRenderAssetIds() {
  return [...(state.assetPicker.video || [])].filter(Boolean);
}

function selectedImageReferenceAssetIds() {
  return [...(state.assetPicker.image || [])].filter(Boolean);
}

function updateImageReferenceSummary() {
  const summary = $('#imageReferenceSummary');
  if (!summary) return;
  const count = selectedImageReferenceAssetIds().length;
  summary.textContent = count ? `已选择 ${count} 张 · 最多 4 张` : '未选择 · 最多 4 张';
}

function updateRenderAssetSummary() {
  const summary = $('#renderAssetSummary');
  if (!summary) return;
  const count = selectedRenderAssetIds().length;
  const autoEdit = ($('#renderTemplateInput')?.value || 'vlog') === 'vlog';
  summary.textContent = autoEdit
    ? (count ? '已选择 1 条主视频，其余视频从当前项目素材库自动匹配' : '选择 1 条主视频，其余素材从当前项目素材库自动匹配')
    : (count ? `已选择 ${count} 条真实视频素材` : '请至少选择一条真实视频素材');
}

function renderAssets(assets = [], options = {}) {
  $('#assetCount').textContent = String(assets.length).padStart(2, '0');
  if (!$('#assetGrid')) return;
  const query = ($('#assetSearchInput')?.value || '').trim().toLowerCase();
  const kind = $('#assetKindFilter')?.value || '全部类型';
  const mediaType = $('#assetMediaTypeFilter')?.value || 'all';
  const filtered = options.skipClientFilter ? assets : assets.filter((asset) => (
    (!query || `${asset.name} ${asset.kind} ${asset.autoEditCategory || ''} ${(asset.tags || []).join(' ')}`.toLowerCase().includes(query))
    && (kind === '全部类型' || assetAutoEditCategory(asset) === kind)
    && (mediaType === 'all' || assetMediaType(asset) === mediaType)
  ));
  $('#assetToolbarCount').textContent = `${String(filtered.length).padStart(2, '0')} 个素材`;
  $('#assetGrid').innerHTML = filtered.length ? filtered.map((asset) => {
    const category = assetAutoEditCategory(asset);
    const categoryButton = assetMediaType(asset) === 'video'
      ? `<button class="quiet-button" data-categorize-asset="${esc(asset.id)}">归类</button>`
      : '';
    return `<article class="asset-card"><button class="asset-thumb ${category === '场景' ? 'scene' : category === '产品' ? 'product' : category === '案例' ? 'case' : 'other'}" data-preview-asset="${esc(asset.id)}" aria-label="${esc(category)}：查看 ${esc(asset.name)}">${assetThumbnail(asset)}<span class="asset-kind-label">${esc(category)}</span></button><div class="asset-info"><div><strong>${esc(asset.name)}</strong><small>${esc(asset.size || '待计算')} · ${esc(asset.mimeType || '未知类型')}</small></div><div class="row-actions">${categoryButton}<button class="quiet-button" data-preview-asset="${esc(asset.id)}">查看</button><button class="danger-button" data-delete-kind="assets" data-delete-id="${esc(asset.id)}" data-delete-label="素材">删除</button></div></div></article>`;
  }).join('') : '<div class="empty-state">没有匹配的素材</div>';
}

let activeCategoryAssetId = null;
let activeCategoryReturnFocus = null;

function closeAssetCategoryModal() {
  activeCategoryAssetId = null;
  const returnFocus = activeCategoryReturnFocus;
  activeCategoryReturnFocus = null;
  const modal = $('#assetCategoryModal');
  if (modal?.contains(document.activeElement)) document.activeElement.blur();
  window.uiDialog.close(modal);
  if (returnFocus && document.contains(returnFocus)) requestAnimationFrame(() => returnFocus.focus());
}

function openAssetCategoryModal(assetId, trigger) {
  const asset = (state.project?.assets || []).find((item) => item.id === assetId && assetMediaType(item) === 'video');
  if (!asset) return;
  activeCategoryAssetId = asset.id;
  activeCategoryReturnFocus = trigger;
  $('#assetCategoryName').textContent = asset.name;
  const select = $('#assetCategorySelect');
  select.innerHTML = assetCategoryOptions(assetAutoEditCategory(asset));
  select.value = assetAutoEditCategory(asset);
  $('#assetNewCategoryInput').value = '';
  window.uiSelect?.refresh(select);
  window.uiDialog.open($('#assetCategoryModal'), { initialFocus: '#assetCategorySelect', returnFocus: trigger });
}

async function saveAssetCategory() {
  if (!activeCategoryAssetId || !state.project) return;
  const asset = (state.project.assets || []).find((item) => item.id === activeCategoryAssetId);
  if (!asset) return closeAssetCategoryModal();
  const button = $('#saveAssetCategoryButton');
  await withButtonLoading(button, async () => {
    try {
      const customName = $('#assetNewCategoryInput').value.trim();
      let categoryName = $('#assetCategorySelect').value;
      if (customName) {
        const created = await request(`/api/projects/${state.project.id}/asset-categories`, {
          method: 'POST',
          body: JSON.stringify({ name: customName })
        });
        state.project.autoEditCategories ||= [];
        state.project.autoEditCategories.push(created);
        categoryName = created.name;
      }
      const updated = await request(`/api/projects/${state.project.id}/assets/${asset.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ autoEditCategory: categoryName })
      });
      Object.assign(asset, updated);
      closeAssetCategoryModal();
      renderAssetCategoryControls(state.project);
      renderAssets(state.project.assets);
      renderMaterialSelectors(state.project);
      toast(`已归类为${assetAutoEditCategory(asset)}`);
    } catch (error) {
      toast(error.message);
    }
  }, '保存中');
}

let assetCategoryManagerReturnFocus = null;

function renderAssetCategoryManager() {
  const list = $('#assetCategoryList');
  if (!list || !state.project) return;
  const categories = projectAutoEditCategoryRecords();
  list.innerHTML = categories.length ? categories.map((category) => {
    const count = (state.project.assets || []).filter((asset) => assetMediaType(asset) === 'video' && assetAutoEditCategory(asset) === category.name).length;
    return `<div class="asset-category-list-item" data-category-row="${esc(category.id)}"><div class="asset-category-edit"><input value="${esc(category.name)}" maxlength="64" data-category-name="${esc(category.id)}" aria-label="分类名称：${esc(category.name)}"><small>${count} 条视频</small></div><div class="row-actions"><button class="quiet-button" type="button" data-update-category="${esc(category.id)}">保存</button><button class="danger-button" type="button" data-delete-category="${esc(category.id)}" ${category.name === '未分类' ? 'disabled title="未分类用于接收移出的素材"' : ''}>删除</button></div></div>`;
  }).join('') : '<div class="empty-state">还没有自定义分类</div>';
}

function openAssetCategoryManager(trigger) {
  assetCategoryManagerReturnFocus = trigger || null;
  renderAssetCategoryManager();
  window.uiDialog.open($('#assetCategoryManagerModal'), { initialFocus: '#assetCategoryNameInput', returnFocus: trigger });
}

function closeAssetCategoryManager() {
  const returnFocus = assetCategoryManagerReturnFocus;
  assetCategoryManagerReturnFocus = null;
  window.uiDialog.close($('#assetCategoryManagerModal'));
  if (returnFocus && document.contains(returnFocus)) requestAnimationFrame(() => returnFocus.focus());
}

async function createAssetCategory(event) {
  event.preventDefault();
  const input = $('#assetCategoryNameInput');
  const name = input.value.trim();
  if (!name) return toast('请输入分类名称');
  await withButtonLoading($('#createAssetCategoryButton'), async () => {
    try {
      const category = await request(`/api/projects/${state.project.id}/asset-categories`, { method: 'POST', body: JSON.stringify({ name }) });
      state.project.autoEditCategories ||= [];
      state.project.autoEditCategories.push(category);
      input.value = '';
      renderAssetCategoryControls(state.project);
      renderAssetCategoryManager();
      toast(`已新增分类：${category.name}`);
    } catch (error) { toast(error.message); }
  }, '新增中');
}

async function updateAssetCategory(categoryId, button) {
  const category = projectAutoEditCategoryRecords().find((item) => item.id === categoryId);
  const input = $(`[data-category-name="${CSS.escape(categoryId)}"]`);
  const name = input?.value.trim();
  if (!category || !name) return toast('分类名称不能为空');
  await withButtonLoading(button, async () => {
    try {
      const previousName = category.name;
      const updated = await request(`/api/projects/${state.project.id}/asset-categories/${encodeURIComponent(category.id)}`, { method: 'PATCH', body: JSON.stringify({ name }) });
      Object.assign(category, updated);
      for (const asset of state.project.assets || []) {
        if (asset.autoEditCategory !== previousName) continue;
        asset.autoEditCategory = updated.name;
        if (assetMediaType(asset) === 'video') asset.kind = updated.name;
      }
      renderAssetCategoryControls(state.project);
      renderAssets(state.project.assets);
      renderAssetCategoryManager();
      toast(`分类已更新为：${updated.name}`);
    } catch (error) { toast(error.message); }
  }, '保存中');
}

async function deleteAssetCategory(categoryId, button) {
  const category = projectAutoEditCategoryRecords().find((item) => item.id === categoryId);
  if (!category || !window.confirm(`删除分类“${category.name}”吗？分类中的素材会移到“未分类”，不会删除素材文件。`)) return;
  await withButtonLoading(button, async () => {
    try {
      const result = await request(`/api/projects/${state.project.id}/asset-categories/${encodeURIComponent(category.id)}`, { method: 'DELETE' });
      state.project.autoEditCategories = projectAutoEditCategoryRecords().filter((item) => item.id !== category.id);
      if (!state.project.autoEditCategories.some((item) => item.name === result.reassignedCategory)) {
        const refreshed = await request(`/api/projects/${state.project.id}/asset-categories`);
        state.project.autoEditCategories = refreshed;
      }
      const affected = new Set(result.affectedAssetIds || []);
      for (const asset of state.project.assets || []) {
        if (!affected.has(asset.id)) continue;
        asset.autoEditCategory = result.reassignedCategory;
        if (assetMediaType(asset) === 'video') asset.kind = result.reassignedCategory;
      }
      renderAssetCategoryControls(state.project);
      renderAssets(state.project.assets);
      renderAssetCategoryManager();
      toast(`分类已删除，${affected.size} 条视频已移到${result.reassignedCategory}`);
    } catch (error) { toast(error.message); }
  }, '删除中');
}

async function organizeAssetCategories(button) {
  if (!window.confirm('按视频文件名去掉末尾编号后批量归类吗？已有素材文件不会被删除。')) return;
  await withButtonLoading(button, async () => {
    try {
      const project = await request(`/api/projects/${state.project.id}/asset-categories/organize`, { method: 'POST', body: '{}' });
      renderProject(project);
      renderAssetCategoryManager();
      toast(`已整理 ${project.organized?.affectedAssetIds?.length || 0} 条视频，形成 ${project.organized?.categoryCount || 0} 个分类`);
    } catch (error) { toast(error.message); }
  }, '整理中');
}

function closeAssetPreview() {
  const modal = $('#assetPreviewModal');
  window.uiDialog.close(modal);
  modal.querySelectorAll('video, audio').forEach((media) => media.pause());
  $('#assetPreviewBody').innerHTML = '';
}

function openAssetPreview(assetId) {
  const asset = (state.project?.assets || []).find((item) => item.id === assetId);
  if (!asset?.accessUrl) return toast('该素材没有可访问的真实文件');
  const type = assetMediaType(asset);
  const url = esc(asset.accessUrl);
  const body = type === 'image'
    ? `<img src="${url}" alt="${esc(asset.name)}" />`
    : type === 'video'
      ? `<video src="${url}" controls autoplay playsinline preload="metadata"></video>`
      : type === 'audio'
        ? `<div class="audio-preview"><span class="asset-type-mark">AUDIO</span><audio src="${url}" controls autoplay preload="metadata"></audio></div>`
        : `<div class="file-preview"><span class="asset-type-mark">FILE</span><a class="secondary-button" href="${url}" target="_blank" rel="noopener">打开文件</a></div>`;
  $('#assetPreviewTitle').textContent = asset.name;
  $('#assetPreviewBody').innerHTML = body;
  $('#assetPreviewMeta').innerHTML = `<span>${esc(assetAutoEditCategory(asset))}</span><span>${esc(asset.mimeType || '未知类型')}</span><span>${esc(asset.size || '大小未知')}</span><a href="${url}" target="_blank" rel="noopener">在新窗口打开</a>`;
  window.uiDialog.open($('#assetPreviewModal'));
}

function renderMedia(project) {
  const avatars = project.avatars || [];
  const voices = (project.voices || []).filter((item) => item.digitalHumanCompatible !== false && item.voiceService !== 'talking_photo' && !String(item.provider || '').startsWith('heygen'));
  const talkingPhotoVoices = (project.voices || []).filter((item) => item.voiceService === 'talking_photo' || String(item.provider || '').startsWith('heygen'));
  const assets = project.assets || [];
  $('#avatarList').innerHTML = avatars.length ? avatars.map((item) => {
    const legacyPreviewAsset = assets.find((asset) => asset.id === item.previewImageAssetId && String(asset.mimeType || '').startsWith('image/'));
    const previewUrl = item.previewUrl || legacyPreviewAsset?.accessUrl;
    return `<article class="media-library-item"><div class="avatar-preview">${previewUrl ? `<img src="${esc(previewUrl)}" alt="${esc(item.name)}" loading="lazy" />` : '<div class="media-preview-empty">形象预览图生成中或不可用</div>'}</div><div class="media-library-copy"><span class="mini-icon teal">人</span><div><strong>${esc(item.name)}</strong><small>${esc(item.pose)} · ${esc(item.style)} · 已授权</small></div><span class="status-text">${esc(item.status)}</span><button class="danger-button" data-delete-kind="avatars" data-delete-id="${esc(item.id)}" data-delete-label="数字人形象">删除</button></div></article>`;
  }).join('') : '<div class="empty-state">还没有数字人</div>';
  $('#voiceList').innerHTML = voices.length ? voices.map((item) => {
    const localPreview = item.previewAssetId && item.previewUrl;
    return `<article class="media-library-item voice-library-item"><div class="media-library-copy"><span class="mini-icon coral">声</span><div><strong>${esc(item.name)}</strong><small>${esc(item.emotion)} · 已授权${localPreview ? ' · 试听已保存' : ''}</small></div>${localPreview ? `<span class="status-text">${esc(item.status)}</span>` : `<button class="quiet-button" data-voice-preview="${esc(item.id)}" data-task-cost-kind="voice_preview" data-task-cost-label="${taskCost('voice_preview')} 算力/次" aria-description="每次成功操作消耗 ${taskCost('voice_preview')} 算力，失败自动退回">生成试听</button>`}<button class="danger-button" data-delete-kind="voices" data-delete-id="${esc(item.id)}" data-delete-label="声音模型">删除</button></div>${localPreview ? `<audio class="voice-preview" src="${esc(item.previewUrl)}" controls preload="metadata"></audio>${item.previewText ? `<p class="voice-preview-text">${esc(item.previewText)}</p>` : ''}` : '<div class="media-preview-empty compact">在线试听已失效，请重新生成试听</div>'}</article>`;
  }).join('') : '<div class="empty-state">还没有声音模型</div>';
  const talkingPhotoVoiceList = $('#talkingPhotoVoiceList');
  if (talkingPhotoVoiceList) talkingPhotoVoiceList.innerHTML = talkingPhotoVoices.length ? talkingPhotoVoices.map((item) => `<article class="media-library-item voice-library-item"><div class="media-library-copy"><span class="mini-icon coral">声</span><div><strong>${esc(item.name)}</strong><small>${esc(item.language || '自动识别语言')} · 口播专用 · 已授权</small></div><span class="status-text">${esc(item.status)}</span><button class="danger-button" data-delete-kind="voices" data-delete-id="${esc(item.id)}" data-delete-label="口播音色">删除</button></div>${item.previewUrl ? `<audio class="voice-preview" src="${esc(item.previewUrl)}" controls preload="metadata"></audio>` : ''}</article>`).join('') : '<div class="empty-state">还没有口播专用音色</div>';
  renderMaterialSelectors(project);
  updateTalkingPhotoVoicePreview(project);
  const images = project.generatedImages || [];
  $('#imageOutputGrid').innerHTML = images.length ? images.slice(0, 6).map((item) => {
    const savedAsset = assets.find((asset) => asset.id === item.assetId);
    const imageUrl = item.accessUrl || savedAsset?.accessUrl || item.url;
    return `<article class="image-output-card"><a class="image-output-preview" href="${esc(imageUrl)}" target="_blank" rel="noopener"><img class="image-result" src="${esc(imageUrl)}" alt="${esc(item.prompt)}" loading="lazy" /></a><div><strong>${esc(item.prompt)}</strong><small>${esc(item.aspectRatio || '1:1')} · 智能图片生成</small><small>${savedAsset ? '已自动加入素材库' : '图片结果'} · ${new Date(item.createdAt).toLocaleString('zh-CN')}</small><button class="danger-button" data-delete-kind="images" data-delete-id="${esc(item.id)}" data-delete-label="生成图片">删除</button></div></article>`;
  }).join('') : '<div class="empty-state">还没有真实图片结果</div>';
}

function updateTalkingPhotoVoicePreview(project = state.project) {
  const select = $('#talkingPhotoVoiceSelect');
  const player = $('#talkingPhotoVoicePreview');
  const hint = $('#talkingPhotoVoicePreviewHint');
  if (!select || !player) return;
  const voice = (project?.voices || []).find((item) => item.id === select.value
    && item.digitalHumanCompatible !== false
    && item.voiceService !== 'talking_photo'
    && !String(item.provider || '').toLowerCase().startsWith('heygen'));
  const previewUrl = String(voice?.previewUrl || '');
  if (player.dataset.previewUrl !== previewUrl) {
    player.pause();
    player.removeAttribute('src');
    player.load();
    player.dataset.previewUrl = previewUrl;
    if (previewUrl) {
      player.src = previewUrl;
      player.load();
    }
  }
  player.hidden = !previewUrl;
  if (hint) hint.textContent = previewUrl
    ? `当前音色：${voice.name || '未命名音色'}`
    : voice ? '当前声音还没有试听文件，可先到媒体实验室生成试听。' : '选择媒体实验室声音后可直接试听。';
}

function renderTemplates() {
  const templates = (state.catalog.templates || [])
    .filter((item) => ['ready', 'partial'].includes(item.status))
    .map((item) => item.id === 'vlog' ? {
      ...item,
      name: 'AI 自动剪辑',
      category: '智能成片',
      description: '理解主视频口播时间线，从素材库自动匹配画面并连续覆盖',
      algorithm: '主视频时间线语义素材匹配',
      inputHint: '选择 1 条主视频，其他视频由系统自动匹配',
    } : item);
  const templateGrid = $('#templateGrid');
  const selectedId = $('#renderTemplateInput')?.value || 'vlog';
  if (templateGrid) {
    templateGrid.innerHTML = templates.map((item) => `<article class="template-card template-status-${esc(item.status)} ${item.id === selectedId ? 'selected' : ''}" data-template-card="${esc(item.id)}"><div class="template-preview ${esc(item.color || 'blue')}"><span>${esc(item.category || '视频模板')}</span><strong>${esc(item.name)}</strong></div><div class="template-info"><p>${esc(publicFeatureText(item.description || ''))}</p><small>${esc(publicFeatureText(item.algorithm || '智能视频处理'))} · ${esc(item.inputHint || '')}</small><button type="button" class="quiet-button" data-template-select="${esc(item.id)}">选择模板</button></div></article>`).join('');
  }
  $('#renderTemplateInput').innerHTML = templates.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('');
  if (templates.some((item) => item.id === selectedId)) $('#renderTemplateInput').value = selectedId;
  else if (templates.some((item) => item.id === 'vlog')) $('#renderTemplateInput').value = 'vlog';
  window.uiSelect?.refresh($('#renderTemplateInput'));
  updateRenderTemplateDetails();
  renderBackgroundMusicOptions();
}

function backgroundMusicDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

function syncBackgroundMusicControls() {
  const select = $('#renderBackgroundMusicInput');
  const volume = $('#renderBackgroundMusicVolumeInput');
  const volumeField = $('#renderBackgroundMusicVolumeField');
  const value = Math.max(0, Math.min(100, Number(volume?.value) || 0));
  const available = state.backgroundMusicSource === 'user' ? (state.userBackgroundMusic || []) : (state.backgroundMusic || []);
  const selected = available.find((item) => item.id === select?.value);
  if ($('#renderBackgroundMusicVolumeValue')) $('#renderBackgroundMusicVolumeValue').textContent = `${value}%`;
  if (volume) volume.disabled = !selected;
  volumeField?.classList.toggle('is-disabled', !selected);
  const hint = $('#renderBackgroundMusicHint');
  if (!hint) return;
  if (selected) hint.textContent = `${selected.name} · ${backgroundMusicDuration(selected.durationSeconds)} · ${state.backgroundMusicSource === 'user' ? '我的音乐库' : '系统音乐库'}`;
  else if (state.backgroundMusicError) hint.textContent = '背景音乐库暂不可用，不会影响无配乐生成';
  else if (state.backgroundMusicSource === 'user' && state.userBackgroundMusic.length) hint.textContent = `当前账号已上传 ${state.userBackgroundMusic.length} 首音乐`;
  else if (state.backgroundMusicSource === 'user') hint.textContent = '我的音乐库暂时为空，上传后仅当前账号可见';
  else if (state.backgroundMusic.length) hint.textContent = `系统当前提供 ${state.backgroundMusic.length} 首背景音乐`;
  else hint.textContent = '系统音乐库暂未提供背景音乐';
}

function renderBackgroundMusicOptions() {
  const select = $('#renderBackgroundMusicInput');
  if (!select) return;
  const previous = select.value;
  const available = state.backgroundMusicSource === 'user' ? (state.userBackgroundMusic || []) : (state.backgroundMusic || []);
  select.innerHTML = `<option value="">不添加背景音乐</option>${available.map((item) => `<option value="${esc(item.id)}" title="${esc(item.name)}">${esc(item.name)}</option>`).join('')}`;
  if (available.some((item) => item.id === previous)) select.value = previous;
  window.uiSelect?.refresh(select);
  syncBackgroundMusicControls();
}

async function refreshUserBackgroundMusic() {
  const endpoints = ['/api/background-music/user', '/api/account/background-music'];
  for (const endpoint of endpoints) {
    try {
      const items = await request(endpoint);
      state.userBackgroundMusic = Array.isArray(items) ? items : [];
      state.backgroundMusicError = '';
      renderBackgroundMusicOptions();
      return state.userBackgroundMusic;
    } catch (error) {
      if (error?.status && error.status !== 404) break;
    }
  }
  state.userBackgroundMusic = [];
  renderBackgroundMusicOptions();
  return [];
}

async function uploadUserBackgroundMusic(file, button) {
  if (!file) return;
  if (!file.type.startsWith('audio/')) return toast('请选择音频文件');
  if (!window.confirm('上传音乐即表示你已确认拥有相应使用权或已取得必要授权；因侵权产生的责任由上传者承担。是否继续？')) return;
  setButtonLoading(button, true, '上传中');
  try {
    const data = await fileToDataUrl(file);
    let uploaded;
    let lastError;
    for (const endpoint of ['/api/background-music/user', '/api/account/background-music']) {
      try {
        uploaded = await request(endpoint, { method: 'POST', timeoutMs: 10 * 60_000, body: JSON.stringify({ name: file.name, mimeType: file.type, data }) });
        break;
      } catch (error) { lastError = error; if (error?.status && error.status !== 404) break; }
    }
    if (!uploaded) throw lastError || new Error('我的音乐库暂不可用');
    state.userBackgroundMusic = [uploaded, ...(state.userBackgroundMusic || []).filter((item) => item.id !== uploaded.id)];
    state.backgroundMusicSource = 'user';
    const source = $('#renderBackgroundMusicLibraryInput');
    if (source) source.value = 'user';
    renderBackgroundMusicOptions();
    toast('音乐已上传到我的音乐库');
  } catch (error) { toast(error.message); }
  finally { setButtonLoading(button, false); }
}

let backgroundMusicRefreshPromise = null;
async function refreshBackgroundMusicLibrary() {
  if (backgroundMusicRefreshPromise) return backgroundMusicRefreshPromise;
  backgroundMusicRefreshPromise = request('/api/background-music')
    .then((items) => {
      state.backgroundMusic = Array.isArray(items) ? items : [];
      state.backgroundMusicError = '';
      renderBackgroundMusicOptions();
      return state.backgroundMusic;
    })
    .catch((error) => {
      state.backgroundMusic = [];
      state.backgroundMusicError = error.message;
      renderBackgroundMusicOptions();
      return [];
    })
    .finally(() => { backgroundMusicRefreshPromise = null; });
  return backgroundMusicRefreshPromise;
}

function updateRenderTemplateDetails() {
  const id = $('#renderTemplateInput')?.value || 'vlog';
  if (id === 'vlog') {
    const allowed = new Set(pickerAssets(state.project, 'video', { excludeAutoEdit: true }).map((asset) => asset.id));
    state.assetPicker.video = state.assetPicker.video.filter((assetId) => allowed.has(assetId)).slice(0, 1);
  }
  $$('.template-extra').forEach((node) => node.classList.toggle('hidden', !node.classList.contains(`template-extra-${id}`)));
  $$('.template-card').forEach((card) => card.classList.toggle('selected', card.dataset.templateCard === id));
  $('#renderModeField')?.classList.add('hidden');
  if ($('#renderAssetLabel')) $('#renderAssetLabel').textContent = id === 'vlog' ? '数字人主视频' : '口播视频（可多选）';
  updateBreathCutOptionValues();
  const videos = pickerAssets(state.project, 'video', { excludeAutoEdit: id === 'vlog' });
  renderAssetPickerTrigger('video', videos);
  updateRenderAssetSummary();
  const button = $('#renderButton');
  if (button) button.textContent = id === 'talking-head' ? '生成口播去气口' : '开始 AI 自动剪辑';
}

function updateBreathCutOptionValues() {
  const threshold = Number($('#renderGapThresholdInput')?.value || 0.1);
  const padding = Number($('#renderGapPaddingInput')?.value || 0.02);
  if ($('#renderGapThresholdValue')) $('#renderGapThresholdValue').textContent = `${threshold.toFixed(2)} 秒`;
  if ($('#renderGapPaddingValue')) $('#renderGapPaddingValue').textContent = `${padding.toFixed(2)} 秒`;
}

function renderOutputs(project) {
  const mode = state.productionMode;
  const outputs = (project.outputs || []).filter((item) => {
    if (mode === 'digital') return item.template === 'digital-human';
    if (mode === 'talking-photo') return item.template === 'talking-photo';
    return item.template !== 'digital-human' && item.template !== 'talking-photo';
  });
  const outputList = $('#outputList');
  const outputRenderKey = `${mode}:${JSON.stringify(outputs)}`;
  if (outputList?.dataset.outputRenderKey === outputRenderKey) return;
  if (outputList) outputList.dataset.outputRenderKey = outputRenderKey;
  const modeTitle = mode === 'talking-photo' ? '数字人口播成片结果' : mode === 'digital' ? '数字人素材成片结果' : '素材视频结果';
  if ($('#outputPanelTitle')) $('#outputPanelTitle').textContent = modeTitle;
  const emptyMessage = mode === 'talking-photo' ? '还没有数字人口播成片' : mode === 'digital' ? '还没有数字人素材成片' : '还没有素材视频成片，请先上传视频素材';
    $('#outputList').innerHTML = outputs.length ? outputs.map((item) => { const mediaUrl = item.accessUrl || item.url; return `<div class="output-row"><span class="output-thumb">${esc(item.templateLabel || item.template || 'VIDEO')}</span><div><strong>${esc(item.title)}</strong><small>${esc(item.duration)} · ${esc(item.ratio || '')} · ${esc(publicFeatureText(item.algorithm || (item.template === 'digital-human' ? '数字人口播' : '智能视频处理')))}</small><small>${esc(publicFeatureText(item.editSummary || item.note || ''))}</small>${item.warning ? `<small class="output-subtitle-status warning">${esc(item.warning)}</small>` : ''}${item.subtitleStatus === 'ready' ? `<small class="output-subtitle-status">${item.subtitleBurned ? '字幕已烧录进成片' : item.subtitleAttachedToTimeline ? `字幕已合入成片（云端原生）· 可下载 ${esc(String(item.subtitleFormat || 'ass').toUpperCase())} 文件` : `字幕已生成，可下载 ${esc(String(item.subtitleFormat || 'srt').toUpperCase())} 文件`}</small>` : item.subtitleStatus === 'unavailable' ? '<small class="output-subtitle-status warning">字幕未生成，请补充文案后重试</small>' : ''}${item.scriptTransformed && item.speechScript ? `<small class="output-speech-script">目标语言稿：${esc(item.speechScript)}</small>` : ''}</div><a class="quiet-button" href="${esc(mediaUrl || '#')}" target="_blank" rel="noopener">查看成片</a>${item.subtitleUrl ? `<a class="quiet-button" href="${esc(item.subtitleUrl)}" download>下载${esc(String(item.subtitleFormat || 'srt').toUpperCase())}字幕</a>` : ''}<button class="primary-button" data-import-jianying="${esc(item.id)}">导入剪映</button><button class="quiet-button" data-export-editing="${esc(item.id)}">下载交接包</button><button class="danger-button" data-delete-kind="outputs" data-delete-id="${esc(item.id)}" data-delete-label="生成成片">删除</button></div>`; }).join('') : `<div class="empty-state">${emptyMessage}</div>`;
}

function renderPublish(project) {
  const sourceSelect = $('#publishSourceOutputSelect');
  const readyOutputs = (project.outputs || []).filter((item) => item.status === 'ready' && (item.accessUrl || item.url));
  if (sourceSelect) {
    const previous = sourceSelect.value;
    sourceSelect.innerHTML = readyOutputs.length ? readyOutputs.map((item) => `<option value="${esc(item.id)}">${esc(item.title || '未命名成片')} · ${esc(item.duration || '')} · ${esc(item.ratio || '原始画幅')}</option>`).join('') : '<option value="">暂无真实成片，请先生成视频</option>';
    sourceSelect.disabled = !readyOutputs.length;
    if (readyOutputs.some((item) => item.id === previous)) sourceSelect.value = previous;
  }
  const titleInput = $('#publishTitleInput');
  if (titleInput && !titleInput.value) titleInput.value = project.copy?.publishTitle || readyOutputs[0]?.title || '';
  const tagsInput = $('#publishTagsInput');
  if (tagsInput && !tagsInput.value && Array.isArray(project.copy?.tags)) tagsInput.value = project.copy.tags.join('，');
  const coverSelect = $('#publishCoverAssetSelect');
  if (coverSelect) {
    const previousCover = coverSelect.value;
    const covers = (project.assets || []).filter((item) => String(item.mimeType || '').startsWith('image/'));
    coverSelect.innerHTML = `<option value="">由平台或发布服务自动截取</option>${covers.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('')}`;
    if (covers.some((item) => item.id === previousCover)) coverSelect.value = previousCover;
  }
  renderPublishPlatforms();
  const packages = project.publishPackages || [];
  $('#publishList').innerHTML = packages.length ? packages.map((pack) => `<div class="publish-row"><div><strong>发布参数清单 · ${new Date(pack.createdAt).toLocaleDateString('zh-CN')}</strong><small>${esc(pack.sourceTitle || '历史成片')} · ${(pack.platforms || []).map(esc).join(' / ')}</small><small class="manifest-notice">${esc(pack.notice || '仅包含平台适配参数，不代表已自动发布。')}</small></div><div class="publish-formats">${(pack.formats || []).map((item) => `<span>${esc(item.platform)} ${esc(item.aspectRatio)}</span>`).join('')}</div><button class="quiet-button" data-export-pack="${esc(pack.id)}">导出 JSON</button><button class="danger-button" data-delete-kind="publish-packages" data-delete-id="${esc(pack.id)}" data-delete-label="发布参数清单">删除</button></div>`).join('') : '<div class="empty-state">还没有基于真实成片的发布参数清单</div>';
  const attempts = project.publishAttempts || [];
  $('#publishAttemptCount').textContent = `${attempts.length} 次发布`;
  $('#publishAttemptList').innerHTML = attempts.length ? attempts.map((attempt) => {
    const mode = attempt.mode === 'draft' ? '保存草稿' : attempt.mode === 'scheduled' ? `定时 · ${new Date(attempt.publishDate).toLocaleString('zh-CN')}` : '立即发布';
    const results = (attempt.results || []).map((result) => `<div class="publish-platform-result ${esc(result.status)}"><span class="platform-symbol">${esc(result.platform.slice(0, 1))}</span><div><strong>${esc(result.platform)}</strong><small>${esc(result.message)}</small></div><span class="status-text">${result.status === 'success' ? '成功' : result.status === 'waiting_user_action' ? '待人工处理' : '失败'}</span></div>`).join('');
    return `<article class="publish-attempt"><details><summary><span class="history-type ${attempt.status === 'success' ? 'teal' : attempt.status === 'partial' ? 'coral' : 'blue'}">发</span><div><strong>${esc(attempt.title || attempt.sourceTitle || '平台发布')}</strong><small>${new Date(attempt.createdAt).toLocaleString('zh-CN')} · ${mode} · 成功 ${attempt.successCount || 0}/${(attempt.results || []).length}</small></div><span class="status-text">${attempt.status === 'success' ? '全部成功' : attempt.status === 'partial' ? '部分完成' : '发布失败'}</span></summary><div class="publish-platform-results">${results}</div></details><div class="publish-attempt-actions"><button class="danger-button" data-delete-kind="publish-attempts" data-delete-id="${esc(attempt.id)}" data-delete-label="自动发布记录">删除</button></div></article>`;
  }).join('') : '<div class="empty-state">还没有自动发布记录</div>';
}

function renderPublishPlatforms() {
  const grid = $('#publishPlatformGrid');
  if (!grid) return;
  const selected = new Set($$('[data-publish-platform]:checked').map((item) => item.value));
  const defaults = new Set(['抖音', '小红书', '视频号']);
  const formatNotes = { 抖音: '9:16 · 草稿/定时', 小红书: '3:4 / 1:1 · 草稿/定时', 视频号: '9:16 · 草稿/定时', 快手: '9:16 · 草稿/定时', B站: '不支持草稿/定时', 百家号: '不支持草稿/定时' };
  const connections = state.connections || [];
  grid.innerHTML = connections.map((connection) => {
    const connected = connection.status === 'connected';
    const checked = connected && (selected.has(connection.platform) || (!selected.size && defaults.has(connection.platform)));
    return `<label class="platform-card ${checked ? 'selected' : ''} ${connected ? 'connected' : 'unavailable'}"><input type="checkbox" data-publish-platform value="${esc(connection.platform)}" ${checked ? 'checked' : ''} ${connected ? '' : 'disabled'} /><span class="platform-card-top"><strong>${esc(connection.platform)}</strong><i class="connection-dot ${connected ? 'connected' : ''}"></i></span><span>${esc(formatNotes[connection.platform] || '按平台规则复核')}</span><small>${connected ? '已授权，可发布' : connection.status === 'service_unavailable' ? '发布服务不可用' : '请先扫码授权'}</small></label>`;
  }).join('') || '<div class="empty-state">没有可用平台，请先到账号与团队完成授权。</div>';
  const connectedCount = connections.filter((item) => item.status === 'connected').length;
  $('#publishPlatformSummary').textContent = `${connectedCount}/${connections.length} 个平台已授权`;
}

function ticketStatusLabel(status) {
  return { open: '待处理', processing: '处理中', resolved: '已解决', closed: '已关闭' }[status] || status;
}

function accountTypeLabel(user = state.user) {
  if (user?.role === 'admin') return '个人用户';
  if (user?.role === 'agent') return '企业代理';
  if (user?.accountType === 'enterprise_member') return '企业成员';
  if (user?.accountType === 'enterprise') return '企业用户';
  return '个人用户';
}

function memberAvailablePoints(user = state.user) {
  const enterpriseBalance = Math.max(0, Number(user?.enterprisePointsBalance ?? user?.pointsBalance ?? 0));
  const remainingLimit = Math.max(0, Number(user?.memberPointsLimit || 0) - Number(user?.memberPointsUsed || 0));
  return Math.min(enterpriseBalance, remainingLimit);
}

function currentPointsLabel(user = state.user) {
  if (user?.accountType === 'enterprise_member') return `${memberAvailablePoints(user)} 企业可用算力`;
  return `${user?.pointsBalance || 0} ${user?.pointsAccountType === 'organization' ? '企业算力' : '个人算力'}`;
}

function renderCurrentUserMeta() {
  $('#currentUserType').textContent = accountTypeLabel();
  $('#currentUserCompute').textContent = `${state.user?.accountType === 'enterprise_member' ? memberAvailablePoints() : state.user?.pointsBalance || 0}`;
}

async function refreshPointsContext() {
  const [user, organization] = await Promise.all([request('/api/auth/me'), request('/api/account/organization')]);
  state.user = user;
  state.organization = organization;
  renderCurrentUserMeta();
  renderSupport();
  renderAccountWorkspace();
}

function renderAccountWorkspace() {
  const organization = state.organization;
  const config = state.catalog.projectConfig || {};
  const isOwner = organization?.ownerId === state.user?.id;
  const isPersonal = state.user?.accountType === 'personal' || state.user?.role === 'admin';
  $('#accountModeBadge').textContent = organization ? (isOwner ? (state.user?.role === 'agent' ? '代理 · 企业负责人' : '企业负责人') : '企业成员') : `${state.user?.role === 'admin' ? '管理员 · ' : ''}个人用户 · ${config.personalIpSlots || 3} 个档案位`;
  $('#organizationEmpty').classList.toggle('hidden', Boolean(organization));
  $('#organizationContent').classList.toggle('hidden', !organization);
  $('#organizationEmpty').textContent = isPersonal ? '个人用户无法开通或加入团队空间' : '企业工作空间正在初始化，请刷新后查看';
  $('#createOrganizationButton').classList.toggle('hidden', Boolean(organization) || isPersonal);
  $('#saveOrganizationButton').classList.toggle('hidden', !organization || !isOwner);
  $('#teamMembersPanel').classList.toggle('hidden', !organization || !isOwner);
  if (organization) {
    $('#organizationNameInput').value = organization.name || '';
    $('#organizationSeatsInput').value = organization.seatLimit || 1;
    $('#organizationQuotaInput').value = organization.pointsBalance || 0;
    $('#organizationNameInput').disabled = !isOwner;
    $('#organizationSeatsInput').disabled = !isOwner;
    $('#organizationQuotaInput').disabled = true;
    const currentMembership = organization.members?.find((member) => member.userId === state.user?.id && member.role !== 'owner');
    const currentMemberAvailable = currentMembership
      ? Math.max(0, Math.min(Number(organization.pointsBalance || 0), Number(currentMembership.computeQuota || 0) - Number(currentMembership.computeUsed || 0)))
      : null;
    $('#teamSummary').innerHTML = isOwner
      ? `<span><strong>${organization.members?.length || 0}</strong> / ${organization.seatLimit} 已用席位</span><span><strong>${organization.pointsBalance || 0}</strong> 企业算力余额</span><span><strong>${organization.pointsUsed || 0}</strong> 企业累计已用</span>`
      : `<span><strong>${organization.pointsBalance || 0}</strong> 企业算力余额</span><span><strong>${currentMembership?.computeQuota || 0}</strong> 我的累计使用上限</span><span><strong>${currentMembership?.computeUsed || 0}</strong> 我已使用</span><span><strong>${currentMemberAvailable || 0}</strong> 当前可用</span>`;
    $('#teamMemberList').innerHTML = (organization.members || []).map((member) => {
      const person = member.user || {};
      const role = member.role === 'owner' ? '企业负责人' : '成员';
      const editable = isOwner && member.role !== 'owner';
      const actions = editable ? `<button class="quiet-button" type="button" data-save-team-member="${esc(member.userId)}">保存</button><button class="danger-button" type="button" data-remove-team-member="${esc(member.userId)}">移除</button>` : '<span class="member-locked-state">负责人</span>';
      const permissionInputs = ['创作', '素材', '发布'].map((permission) => `<label><input data-member-permission type="checkbox" value="${permission}" ${(member.permissions || []).includes(permission) ? 'checked' : ''} ${editable ? '' : 'disabled aria-disabled="true"'} />${permission}</label>`).join('');
      const memberName = esc(person.displayName || '未知成员');
      const available = member.role === 'owner' ? Number(organization.pointsBalance || 0) : Math.max(0, Math.min(Number(organization.pointsBalance || 0), Number(member.computeQuota || 0) - Number(member.computeUsed || 0)));
      return `<div class="team-member-row" data-team-member="${esc(member.userId)}"><span class="avatar">${esc(String(person.displayName || '成').slice(0, 1))}</span><div class="team-member-identity"><span class="team-member-name"><strong>${memberName}</strong><em>${role}</em></span><small>${esc(person.account || member.userId)}</small></div><label class="member-quota-field"><input data-member-quota aria-label="${memberName}的企业算力累计使用上限" type="number" min="0" value="${esc(member.computeQuota || 0)}" ${editable ? '' : 'disabled'} /><small>已用 ${member.computeUsed || 0} · 当前可用 ${available}</small></label><div class="member-permission-picker" role="group" aria-label="${memberName}的开放权限">${permissionInputs}</div><div class="team-member-actions">${actions}</div></div>`;
    }).join('') || '<div class="empty-state">还没有成员</div>';
  } else {
    $('#teamMemberList').innerHTML = '';
  }
  $('#platformConnectionList').innerHTML = (state.connections || []).map((connection) => {
    const active = connection.status === 'connected';
    const unavailable = connection.status === 'service_unavailable';
    const expired = connection.status === 'expired';
    const actions = active
      ? `<button class="quiet-button" data-check-platform="${esc(connection.platform)}">检查</button><button class="danger-button" data-clear-platform="${esc(connection.platform)}">退出</button>`
      : `<button class="quiet-button" data-connect-platform="${esc(connection.platform)}">${expired ? '重新扫码' : unavailable ? '重试连接' : '扫码授权'}</button>`;
    return `<div class="connection-row"><span class="platform-symbol">${esc(connection.platform.slice(0, 1))}</span><div><strong>${esc(connection.platform)}</strong><small>${esc(connection.note || (active ? '扫码登录态有效' : '尚未扫码授权'))}</small><small>${connection.supportsDraft ? '支持草稿' : '不支持草稿'} · ${connection.supportsSchedule ? '支持定时' : '不支持定时'}</small></div><span class="status-text">${active ? '已授权' : unavailable ? '服务不可用' : expired ? '已过期' : '未授权'}</span><span class="connection-actions">${actions}</span></div>`;
  }).join('') || '<div class="empty-state">正在读取平台状态</div>';
  renderPublishPlatforms();
}

function renderSupport() {
  $('#accountPointsBadge').textContent = currentPointsLabel();
  $('#ticketList').innerHTML = state.tickets.length ? state.tickets.map((ticket) => `<div class="ticket-row"><span class="ticket-token">#</span><div><strong>${esc(ticket.subject)}</strong><small>${esc(ticket.category)} · ${new Date(ticket.createdAt).toLocaleString('zh-CN')}</small><p>${esc(ticket.message)}</p>${ticket.adminNote ? `<small class="ticket-note">客服回复：${esc(ticket.adminNote)}</small>` : ''}</div><span class="status-text">${ticketStatusLabel(ticket.status)}</span></div>`).join('') : '<div class="empty-state">还没有提交过工单</div>';
}

function renderCustomTemplates(project) {
  const templates = project.customTemplates || [];
  const statusLabels = { draft: '待评估', submitted: '待评估', evaluating: '评估中', approved: '方案已确认', developing: '开发中', blocked: '暂缓处理', ready: '已交付', rejected: '暂不支持' };
  $('#customTemplateList').innerHTML = templates.length ? templates.map((item) => `<div class="custom-template-row"><span class="template-token">REQ</span><div><strong>${esc(item.name)}</strong><small>联系方式：${esc(item.contact || '历史记录未填写')}</small><small>${esc(item.requirement || '未填写功能效果与交付要求')}</small></div><span class="status-text">${esc(statusLabels[item.status] || item.status)}</span><button class="danger-button" data-delete-kind="custom-templates" data-delete-id="${esc(item.id)}" data-delete-label="功能建议记录">删除</button></div>`).join('') : '<div class="empty-state">还没有提交功能建议</div>';
}

function setNextStepEnabled(selector, enabled) {
  const button = $(selector);
  if (!button) return;
  button.disabled = !enabled;
  button.setAttribute('aria-disabled', enabled ? 'false' : 'true');
}

function syncWorkflowNextSteps(project = state.project) {
  if (!project) return;
  const benchmarkReady = (project.benchmarks || []).some((item) => item.status === 'analyzed' && item.analysisVersion === 'multimodal-v1');
  const copyReady = Boolean(activeCopy() || project.copy);
  const outputReady = (project.outputs || []).some((item) => item.status === 'ready' && (item.accessUrl || item.url));
  setNextStepEnabled('#strategyNextStepButton', Boolean(project.positioning));
  setNextStepEnabled('#benchmarkNextStepButton', benchmarkReady);
  setNextStepEnabled('#copyNextStepButton', copyReady);
  setNextStepEnabled('#renderNextStepButton', outputReady);
}

function completion(project) {
  const profileReady = Object.keys(project.profile || {}).filter((key) => String(project.profile[key] || '').trim()).length >= 2;
  const positioningReady = Boolean(project.positioning);
  const benchmarkReady = (project.benchmarks || []).some((item) => item.status === 'analyzed' && item.analysisVersion === 'multimodal-v1');
  const copyReady = Boolean(project.copy && Object.keys(project.copy).length);
  const outputReady = (project.outputs || []).some((item) => item.status === 'ready' && (item.accessUrl || item.url));
  const done = [profileReady && positioningReady, benchmarkReady, copyReady, outputReady].filter(Boolean).length;
  $('#completionValue').textContent = `${Math.min(100, Math.round((done / 4) * 100))}%`;
  $('#completedStepCount').textContent = String(done);
  $('#stepStatus').textContent = `${done} / 4 核心环节`;
  return done;
}

function renderOverview(project) {
  const done = completion(project);
  const profileReady = Object.keys(project.profile || {}).filter((key) => String(project.profile[key] || '').trim()).length >= 2;
  const positioningReady = Boolean(project.positioning);
  const benchmarkReady = (project.benchmarks || []).some((item) => item.status === 'analyzed' && item.analysisVersion === 'multimodal-v1');
  const benchmarkRunning = (project.benchmarks || []).some((item) => item.status === 'analyzing');
  const copyReady = Boolean(project.copy && Object.keys(project.copy).length);
  const outputReady = (project.outputs || []).some((item) => item.status === 'ready' && (item.accessUrl || item.url));
  const outputRunning = (project.outputs || []).some((item) => ['queued', 'running', 'processing'].includes(item.status));
  const stageState = [profileReady && positioningReady, benchmarkReady, copyReady, outputReady];
  const stageLabels = [
    positioningReady ? '定位已生成' : profileReady ? '资料已保存' : '待输入资料',
    benchmarkReady ? '真实拆解已完成' : benchmarkRunning ? '真实分析处理中' : '待添加对标',
    copyReady ? '文案已生成' : '待生成文案',
    outputReady ? '真实成片已就绪' : outputRunning ? '成片生成中' : (project.assets || []).length ? '待选择模板' : '待上传素材'
  ];
  const stageNodes = ['strategy', 'benchmark', 'copy', 'render'];
  const activeStage = stageState.findIndex((ready) => !ready);
  stageNodes.forEach((view, index) => {
    const node = $(`.workflow-step[data-go="${view}"]`);
    if (node) {
      node.classList.toggle('done', stageState[index]);
      node.classList.toggle('active', index === (activeStage === -1 ? 3 : activeStage));
    }
    const status = $(`#workflow${view[0].toUpperCase()}${view.slice(1)}Status`);
    if (status) status.textContent = stageLabels[index];
  });
  ['One', 'Two', 'Three'].forEach((name, index) => $(`#workflowConnector${name}`)?.classList.toggle('done', stageState[index]));
  const progressBar = $('#heroProgressBar');
  if (progressBar) progressBar.style.transform = `scaleX(${done / 4})`;
  if ($('#heroProgressText')) $('#heroProgressText').textContent = `${done} / 4`;
  if ($('#heroProjectSignal')) $('#heroProjectSignal').textContent = done === 4 ? '基础闭环已建立' : done > 0 ? '生产流程进行中' : '等待资料输入';
  const features = state.catalog.features || [];
  const featureViews = { ip_profile: 'strategy', team: 'account', copy: 'copy', chat: 'chat', benchmark: 'benchmark', assets: 'assets', digital_human: 'media', render: 'render', publish: 'publish' };
  $('#featureGrid').innerHTML = features.map((feature) => `<article class="feature-card" data-go="${featureViews[feature.id] || 'overview'}"><div class="feature-top"><span class="feature-index">${String(features.indexOf(feature) + 1).padStart(2, '0')}</span></div><h3>${esc(feature.label)}</h3><p>${esc(publicFeatureText(feature.description))}</p><button class="feature-action">${esc(feature.action)} <span>→</span></button></article>`).join('');
  const actions = [];
  if (!profileReady) actions.push(['完善客户资料', '把身份、产品和客户写进项目', 'strategy']);
  if (!positioningReady) actions.push(['生成 IP 定位', '基于当前资料输出定位表', 'strategy']);
  if (!benchmarkReady) actions.push(['完成真实对标拆解', '上传视频或分享链接并等待分析证据', 'benchmark']);
  if (!copyReady) actions.push(['生成第一套文案', '输出口播、标题、分镜和制作建议', 'copy']);
  if (!outputReady) actions.push(['生成真实视频成片', '选择主视频并自动匹配素材生成成片', 'render']);
  $('#nextActionList').innerHTML = actions.slice(0, 4).map(([title, desc, view]) => `<button class="next-action" data-go="${view}"><span class="next-action-mark">＋</span><span><strong>${esc(title)}</strong><small>${esc(desc)}</small></span><span>→</span></button>`).join('') || '<div class="empty-state">当前项目已完成基础闭环</div>';
  const latest = [...(project.outputs || []), ...(project.generatedImages || [])][0];
  $('#latestOutput').innerHTML = latest ? `<div class="latest-output"><span class="output-thumb">${latest.template ? 'VIDEO' : 'IMAGE'}</span><div><strong>${esc(latest.title || latest.prompt || '最近生成结果')}</strong><small>${esc(latest.status || 'ready')}</small></div><button class="quiet-button" data-go="${latest.template ? 'render' : 'media'}">查看</button></div>` : '<div class="empty-state">还没有生成结果</div>';
}

function copyRecordText(item) {
  const content = item?.content || {};
  return (item?.mode || content.mode) === 'qa' ? (content.qaScript || []).join('\n') : content.script || '';
}

function renderCopyLibrary() {
  const items = state.copies || [];
  const search = ($('#copyLibrarySearchInput')?.value || '').trim().toLowerCase();
  const projectFilter = $('#copyLibraryProjectFilter');
  if (projectFilter) {
    const project = state.project;
    projectFilter.innerHTML = project ? `<option value="${esc(project.id)}">${esc(project.name)}</option>` : '<option value="">当前项目</option>';
    projectFilter.disabled = true;
  }
  const filtered = items.filter((item) => !search || `${item.title} ${copyRecordText(item)}`.toLowerCase().includes(search));
  $('#copyLibraryCount').textContent = `${items.length} 篇文案`;
  $('#copyLibraryVisibleCount').textContent = `${filtered.length} 篇结果`;
  $('#copyLibraryList').innerHTML = filtered.length ? filtered.map((item) => {
    const content = item.content || {};
    const fullText = copyRecordText(item);
    const originality = content.originality;
    const mode = (item.mode || content.mode) === 'qa' ? '问答脚本' : '标准口播';
    const time = item.updatedAt || item.createdAt;
    return `<article class="copy-library-item"><details><summary><span class="history-type teal">文</span><div><strong>${esc(item.title || '未命名文案')}</strong><small>${esc(item.projectName || '')} · ${new Date(time).toLocaleString('zh-CN')} · ${mode}</small></div><span class="status-text">${originality ? `相似度 ${Math.round((originality.maxSimilarity || 0) * 100)}%` : item.manual ? '手工文案' : 'AI 留存'}</span></summary><div class="copy-library-content"><pre>${esc(fullText || '该记录没有可显示的正文')}</pre><div class="copy-library-meta">${content.coverTitle ? `<span>封面：${esc(content.coverTitle)}</span>` : ''}${content.publishTitle ? `<span>发布：${esc(content.publishTitle)}</span>` : ''}<span>${item.manual ? '手工创建' : 'AI 自动留存'}</span>${item.usedHistoricalStyle ? '<span>已参考历史风格</span>' : ''}${item.draft ? '<span>基于半成品续写</span>' : ''}</div></div></details><div class="copy-library-actions"><button class="quiet-button" data-edit-copy="${esc(item.id)}">编辑</button><button class="danger-button" data-delete-copy="${esc(item.id)}">删除</button></div></article>`;
  }).join('') : `<div class="empty-state">${items.length ? '没有匹配的文案' : '还没有留存文案，可以新建或从 AI 文案页面生成。'}</div>`;
}

function activeChatPreset() {
  const presets = state.chat?.presets || [];
  return presets.find((item) => item.id === state.chat?.activePresetId) || presets[0] || null;
}

function renderChat({ scrollToEnd = false } = {}) {
  const chat = state.chat;
  const select = $('#chatPresetSelect');
  const list = $('#chatMessageList');
  if (!select || !list) return;
  const presets = chat?.presets || [];
  select.innerHTML = presets.length
    ? presets.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('')
    : '<option value="">暂无可用角色</option>';
  select.disabled = !presets.length;
  if (presets.some((item) => item.id === chat?.activePresetId)) select.value = chat.activePresetId;
  window.uiSelect?.refresh(select);
  const preset = activeChatPreset();
  $('#chatPresetName').textContent = preset?.name || '未配置角色';
  $('#chatPresetDescription').textContent = preset?.description || '暂未配置对话角色';
  const model = chat?.model;
  $('#chatModelStatus').textContent = model?.configured ? '智能对话已就绪' : '对话能力待配置';
  $('#chatModelStatus').classList.toggle('warning', Boolean(model && !model.configured));
  $('#chatSendButton').disabled = !state.project || !preset || !model?.configured || chat?.pending === true;
  $('#clearChatButton').disabled = !state.project || !(chat?.messages || []).length || chat?.pending === true;

  const messages = chat?.messages || [];
  if (!messages.length && !chat?.pending) {
    list.innerHTML = `<div class="chat-empty"><div class="chat-empty-mark" aria-hidden="true">AI</div><strong>${esc(preset?.name || 'AI 项目助手')}</strong><div class="chat-starter-list"><button type="button" data-chat-starter="根据当前项目资料，告诉我现在最应该优先完成什么。">梳理下一步</button><button type="button" data-chat-starter="检查当前项目还缺少哪些关键信息或素材。">检查项目缺口</button><button type="button" data-chat-starter="结合当前定位，给我 5 个适合近期发布的选题。">生成近期选题</button></div></div>`;
  } else {
    list.innerHTML = messages.map((message) => {
      const role = message.role === 'assistant' ? 'assistant' : 'user';
      const rolePreset = (chat?.presets || []).find((item) => item.id === message.presetId);
      const label = role === 'assistant' ? (rolePreset?.name || 'AI 项目助手') : '我';
      return `<article class="chat-message ${role}"><div class="chat-message-meta"><strong>${esc(label)}</strong><time>${esc(message.createdAt ? new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '')}</time></div><div class="chat-message-content">${esc(message.content)}</div></article>`;
    }).join('') + (chat?.pending ? '<article class="chat-message assistant pending"><div class="chat-message-meta"><strong>AI 项目助手</strong></div><div class="chat-thinking" aria-label="AI 正在思考"><i></i><i></i><i></i></div></article>' : '');
  }
  if (scrollToEnd) requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
}

function closeCopyLibraryModal() {
  window.uiDialog.close($('#copyLibraryModal'));
  $('#copyLibraryProjectInput').disabled = false;
  window.uiSelect.refresh($('#copyLibraryProjectInput'));
  state.editingCopyId = null;
}

function openCopyLibraryModal(copyId = null) {
  if (!state.projects.length) return toast('请先创建一个 IP 项目');
  const item = copyId ? state.copies.find((copy) => copy.id === copyId) : null;
  if (copyId && !item) return toast('没有找到这篇文案');
  state.editingCopyId = item?.id || null;
  const projectInput = $('#copyLibraryProjectInput');
  const project = state.project;
  projectInput.innerHTML = project ? `<option value="${esc(project.id)}">${esc(project.name)}</option>` : '';
  projectInput.value = project?.id || '';
  projectInput.disabled = true;
  $('#copyLibraryModeInput').value = item?.mode || item?.content?.mode || 'standard';
  $('#copyLibraryTitleInput').value = item?.title || '';
  $('#copyLibraryTextInput').value = item ? copyRecordText(item) : '';
  $('#copyLibraryModalTitle').textContent = item ? '编辑文案' : '新建文案';
  $('#saveCopyLibraryButton').textContent = item ? '保存修改' : '保存文案';
  window.uiSelect.refresh(projectInput);
  window.uiSelect.refresh($('#copyLibraryModeInput'));
  window.uiDialog.open($('#copyLibraryModal'), { initialFocus: '#copyLibraryTitleInput' });
}

async function loadCopies(projectId = state.project?.id) {
  if (!projectId) {
    state.copies = [];
    renderCopyLibrary();
    return;
  }
  const copies = await request(`/api/copies?projectId=${encodeURIComponent(projectId)}`);
  if (state.project?.id !== projectId) return;
  state.copies = copies;
  renderCopyLibrary();
}

async function loadTasks(project) {
  try {
    const tasks = await request(`/api/projects/${project.id}/tasks`);
    if (state.requestedProjectId !== project.id || state.project?.id !== project.id) return;
    state.tasks = tasks;
    syncTaskButtons(tasks);
    $('#taskCount').textContent = String(tasks.length).padStart(2, '0');
    $('#historyList').innerHTML = tasks.length ? tasks.map((task) => `<div class="history-row"><span class="history-type ${task.kind === 'image' ? 'blue' : task.kind === 'publish' ? 'teal' : 'coral'}">${task.kind === 'image' ? '图' : task.kind === 'publish' ? '发' : task.kind === 'video' ? '片' : 'AI'}</span><div><strong>${esc(task.kind)} · ${esc(task.template || '任务')}${Number(task.attempt || 1) > 1 ? ` · 第 ${esc(task.attempt)} 次` : ''}</strong><small>${new Date(task.createdAt).toLocaleString('zh-CN')} · ${esc(taskStatusText(task))}${task.pointsCost ? ` · ${task.pointsCost} 算力` : ''}</small></div><span class="status-text">${task.progress}%</span>${task.canRetry ? `<button class="quiet-button" data-retry-task="${esc(task.id)}">重试</button>` : ''}${['queued', 'running'].includes(task.status) ? '' : `<button class="danger-button" data-delete-kind="tasks" data-delete-id="${esc(task.id)}" data-delete-label="任务记录">删除</button>`}</div>`).join('') : '<div class="empty-state">还没有生成任务</div>';
  } catch {
    if (state.requestedProjectId === project.id && state.project?.id === project.id) $('#historyList').innerHTML = '<div class="empty-state">任务记录暂不可用</div>';
  }
}

function renderProject(project) {
  const projectChanged = state.project?.id !== project.id;
  state.project = project;
  if (projectChanged) {
    state.copies = [];
    const firstVideo = (project.assets || []).find((asset) => assetMediaType(asset) === 'video');
    state.assetPicker = { image: [], video: firstVideo ? [firstVideo.id] : [] };
  }
  if (!['standard', 'qa'].includes(state.copyMode)) state.copyMode = 'standard';
  if (project.copy?.mode === 'qa' && !project.copyVariants?.standard) state.copyMode = 'qa';
  syncCopyModeUi();
  $('#pageTitle').textContent = project.name;
  const copyHeading = $('#copyView .view-heading h2');
  const copyDescription = $('#copyView .view-heading p');
  const copySaveHint = $('#copyView .save-hint');
  const libraryDescription = $('#libraryView .view-heading p');
  if (copyHeading) copyHeading.textContent = 'AI 文案创作';
  if (copyDescription) copyDescription.textContent = '参考最近文案库风格，并可选用最近一次真实拆解的结构生成原创文案';
  if (copySaveHint) copySaveHint.textContent = '生成结果会自动留存；真实拆解需手动保存后才进入文案库';
  if (libraryDescription) libraryDescription.textContent = '集中查看、创建和维护当前项目文案库；真实拆解不会自动进入这里';
  renderProjectSelect();
  renderProfile(project.profile);
  renderPositioning(project.positioning || {});
  renderBenchmarks(project.benchmarks || []);
  renderCopyBenchmarkReferences(project.benchmarks || []);
  renderAccountAnalyses(project.accountAnalyses || []);
  (project.accountAnalyses || []).filter((item) => item.status === 'analyzing').forEach((item) => monitorAccountAnalysis(item, false));
  syncBenchmarkButton(project);
  renderCopy(activeCopy() || {}, state.copyMode);
  if (projectChanged) {
    const projectCopy = activeCopy() || project.copy;
    if (projectCopy) syncCopyToDigitalHumanInputs(projectCopy, { force: true });
    else ['#digitalScriptInput', '#talkingPhotoScriptInput', '#digitalRenderNameInput', '#talkingPhotoNameInput'].forEach((selector) => setValue(selector, ''));
  }
  renderAssetCategoryControls(project);
  renderAssets(project.assets || []);
  renderSpeechLanguageOptions();
  renderMaterialSelectors(project);
  renderMedia(project);
  renderTemplates();
  renderOutputs(project);
  renderPublish(project);
  renderCustomTemplates(project);
  renderCopyLibrary();
  renderOverview(project);
  syncWorkflowNextSteps(project);
  loadTasks(project);
}

async function loadProject(id) {
  const projectId = String(id || '');
  const loadToken = Symbol(projectId);
  state.projectLoadToken = loadToken;
  const [project, chat] = await Promise.all([
    request(`/api/projects/${projectId}`),
    request(`/api/projects/${projectId}/chat`)
  ]);
  if (state.projectLoadToken !== loadToken || state.requestedProjectId !== projectId) return false;
  polling.stopWhere((entry) => entry.meta?.projectId && entry.meta.projectId !== projectId);
  state.chat = chat;
  renderProject(project);
  renderChat({ scrollToEnd: true });
  await loadCopies(project.id);
  return true;
}

async function selectProject(id) {
  const projectId = String(id || '');
  if (!projectId) return false;
  state.requestedProjectId = projectId;
  polling.stopWhere((entry) => entry.meta?.projectId && entry.meta.projectId !== projectId);
  if (state.project?.id !== projectId) {
    syncTaskButtons([]);
    setButtonLoading($('#analyzeBenchmarkButton'), false);
  }
  return loadProject(projectId);
}

async function pollTask(task, message, button = taskButton(task.kind), announce = true) {
  const projectId = task?.projectId || state.project?.id;
  if (!task?.id || !projectId) return setButtonLoading(button, false);
  const timerKey = `task:${task.id}`;
  setButtonLoading(button, true);
  if (announce) toast(`${message}已创建，正在处理`);
  polling.stop(timerKey);
  polling.start(timerKey, {
    meta: { projectId, type: 'task' },
    intervalMs: 900,
    timeoutMs: 35 * 60_000,
    startedAt: pollStartedAt(task),
    maxFailures: 3,
    poll: async () => {
      const current = await request(`/api/tasks/${task.id}`, { timeoutMs: 12_000 });
      if (state.requestedProjectId !== projectId || state.project?.id !== projectId) return true;
      setButtonProgress(button, current.progress, current.progressStage);
      if (current.status === 'success' || current.status === 'failed') {
        const previousAttemptIds = new Set((state.project?.publishAttempts || []).map((attempt) => attempt.id));
        const loaded = await loadProject(projectId);
        if (!loaded || state.requestedProjectId !== projectId || state.project?.id !== projectId) {
          if (state.requestedProjectId === projectId && state.project?.id === projectId) setButtonLoading(button, false);
          return true;
        }
        setButtonLoading(button, false);
        await refreshPointsContext().catch(() => {});
        if (task.kind === 'platform_publish' && current.status === 'success') {
          const attempt = current.result?.attempt || (state.project.publishAttempts || []).find((item) => !previousAttemptIds.has(item.id));
          const results = attempt?.results || [];
          const successCount = Number(attempt?.successCount ?? results.filter((item) => item.status === 'success').length);
          const waiting = results.filter((item) => item.status === 'waiting_user_action');
          const failed = results.filter((item) => item.status === 'failed');
          go('publish');
          requestAnimationFrame(() => $('#publishAttemptList')?.scrollIntoView({ behavior: 'auto', block: 'start' }));
          if (attempt?.status === 'success' || (results.length > 0 && successCount === results.length)) {
            toast(`\u53d1\u5e03\u6210\u529f\uff0c\u5171\u6210\u529f\u53d1\u5e03 ${successCount} \u4e2a\u5e73\u53f0`);
          } else if (attempt?.status === 'partial' || waiting.length) {
            const waitingNames = waiting.map((item) => item.platform).join('\u3001');
            toast(`\u5df2\u6210\u529f\u53d1\u5e03 ${successCount} \u4e2a\u5e73\u53f0${waitingNames ? `\uff0c${waitingNames}\u5f85\u4eba\u5de5\u5904\u7406` : ''}`);
          } else {
            const reason = failed.map((item) => item.message).filter(Boolean).join('\uff1b') || attempt?.message || '\u8bf7\u67e5\u770b\u53d1\u5e03\u5386\u53f2';
            toast(`\u53d1\u5e03\u5931\u8d25\uff1a${reason}`);
          }
          return true;
        }
        toast(current.status === 'success' ? `${message}已完成` : `${message}失败：${current.error?.message || '请查看任务记录'}`);
        return true;
      }
      return false;
    },
    onTimeout: () => {
      if (state.requestedProjectId !== projectId || state.project?.id !== projectId) return;
      setButtonLoading(button, false);
      toast(`${message}等待已超时，后台任务不受影响，可在任务记录中查看最终状态`);
    },
    onError: () => {
      if (state.requestedProjectId !== projectId || state.project?.id !== projectId) return;
      setButtonLoading(button, false);
      toast(`${message}状态连续获取失败，已停止等待，请刷新后查看`);
    }
  });
}

async function saveProfile(show = true) {
  const profile = await request(`/api/projects/${state.project.id}/profile`, { method: 'POST', body: JSON.stringify(profilePayload()) });
  state.project.profile = profile; renderOverview(state.project); $('#profileHint').textContent = '刚刚保存 · 当前项目'; if (show) toast('资料已保存');
}

async function createGenerate(kind, input, message, button = taskButton(kind)) {
  if (kind === 'image' && !input.aspectRatio) input.aspectRatio = $('#imageAspectRatioInput')?.value || '1:1';
  if (!setButtonLoading(button, true)) return;
  try {
    const task = await request(`/api/projects/${state.project.id}/generate`, { method: 'POST', headers: { 'Idempotency-Key': createIdempotencyKey(`generate-${kind}`) }, body: JSON.stringify({ kind, ...input }) });
    await pollTask(task, message, button);
  } catch (error) {
    setButtonLoading(button, false);
    toast(error.message);
  }
}

function setLoadingButtonLabel(button, label) {
  if (!button || button.dataset.loading !== 'true') return;
  button.dataset.loadingLabel = label;
  const labelNode = button.querySelector('.button-loading-label');
  if (labelNode) labelNode.textContent = label;
  const progress = button.querySelector('.button-loading-progress');
  if (progress) progress.setAttribute('aria-label', label);
}

function monitorTaskBatch(tasks, message, button, creationErrors = [], projectId = state.project?.id) {
  if (!projectId || !tasks.length) return setButtonLoading(button, false);
  const taskIds = new Set(tasks.map((task) => task.id));
  const timerKey = `task-batch:${[...taskIds].sort().join(':')}`;
  polling.start(timerKey, {
    meta: { projectId, type: 'task-batch' },
    intervalMs: 1_500,
    timeoutMs: 35 * 60_000,
    startedAt: Math.min(...tasks.map((task) => pollStartedAt(task))),
    maxFailures: 3,
    poll: async () => {
      const currentTasks = await request(`/api/projects/${projectId}/tasks`, { timeoutMs: 12_000 });
      if (state.requestedProjectId !== projectId || state.project?.id !== projectId) return true;
      const current = currentTasks.filter((task) => taskIds.has(task.id));
      const finished = current.filter((task) => ['success', 'failed'].includes(task.status));
      const progressValues = current.map((task) => {
        if (task.status === 'success') return 100;
        const progress = Number(task.progress);
        return Number.isFinite(progress) ? Math.max(0, Math.min(99, progress)) : 0;
      });
      const aggregateProgress = progressValues.length
        ? progressValues.reduce((sum, value) => sum + value, 0) / tasks.length
        : null;
      const active = current
        .filter((task) => ['queued', 'running'].includes(task.status))
        .sort((a, b) => Number(b.progress || 0) - Number(a.progress || 0))[0];
      const stage = active?.progressStage || (finished.length ? '正在整理结果' : '任务已提交');
      setLoadingButtonLabel(button, `批量处理 ${finished.length}/${tasks.length}`);
      setButtonProgress(button, aggregateProgress > 0 ? aggregateProgress : null, `${stage} · ${finished.length}/${tasks.length}`);
      if (current.length < tasks.length || finished.length < tasks.length) return false;
      const successCount = finished.filter((task) => task.status === 'success').length;
      const failedCount = finished.length - successCount + creationErrors.length;
      await loadProject(projectId);
      setButtonLoading(button, false);
      toast(failedCount
        ? `${message}批量完成：${successCount} 条成功，${failedCount} 条失败`
        : `${message}批量完成：${successCount} 条已分别出片`);
      return true;
    },
    onTimeout: () => {
      if (state.requestedProjectId !== projectId || state.project?.id !== projectId) return;
      setButtonLoading(button, false);
      toast(`${message}批量等待已超时，后台任务不受影响，可在任务记录中查看`);
    },
    onError: () => {
      if (state.requestedProjectId !== projectId || state.project?.id !== projectId) return;
      setButtonLoading(button, false);
      toast(`${message}批量状态连续获取失败，请刷新任务记录查看结果`);
    }
  });
}

async function createGenerateBatch(kind, inputs, message, button = taskButton(kind)) {
  if (!Array.isArray(inputs) || !inputs.length) return;
  const projectId = state.project?.id;
  if (!projectId) return;
  if (!setButtonLoading(button, true, '批量创建中')) return;
  const tasks = [];
  const errors = [];
  for (let index = 0; index < inputs.length; index += 1) {
    setLoadingButtonLabel(button, `创建任务 ${index + 1}/${inputs.length}`);
    const input = inputs[index];
    try {
      const task = await request(`/api/projects/${projectId}/generate`, {
        method: 'POST',
        headers: { 'Idempotency-Key': createIdempotencyKey(`generate-${kind}-${input.template || 'batch'}-${input.videoAssetIds?.[0] || index}`) },
        body: JSON.stringify({ kind, ...input })
      });
      tasks.push(task);
    } catch (error) {
      errors.push(error);
    }
  }
  if (!tasks.length) {
    setButtonLoading(button, false);
    return toast(errors[0]?.message || `${message}创建失败`);
  }
  toast(`已创建 ${tasks.length} 条独立任务${errors.length ? `，${errors.length} 条创建失败` : ''}`);
  monitorTaskBatch(tasks, message, button, errors, projectId);
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`读取 ${file.name} 失败`));
    reader.readAsDataURL(file);
  });
}

async function uploadAsset(file, { videoCategory = '' } = {}) {
  const isVideo = file.type.startsWith('video/');
  const kind = isVideo
    ? (String(videoCategory || '').trim() === '自动识别'
      ? inferAutoEditCategory({ name: file.name, kind: '场景' })
      : String(videoCategory || '').trim() || inferAutoEditCategory({ name: file.name, kind: '场景' }))
    : file.type.startsWith('audio/') ? '声音' : '其他';
  const ticket = await request(`/api/projects/${state.project.id}/assets/uploads`, {
    method: 'POST',
    body: JSON.stringify({
      name: file.name,
      kind,
      autoEditCategory: kind,
      mimeType: file.type || 'application/octet-stream',
      sizeBytes: file.size
    })
  });
  await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(ticket.method || 'PUT', ticket.uploadUrl, true);
    xhr.timeout = 30 * 60_000;
    xhr.withCredentials = ticket.driver === 'local';
    Object.entries(ticket.headers || {}).forEach(([key, value]) => xhr.setRequestHeader(key, value));
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      window.dispatchEvent(new CustomEvent('chensi:asset-upload-progress', { detail: { file, progress: Math.round(event.loaded / event.total * 100) } }));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      reject(Object.assign(new Error(ticket.driver === 'oss'
        ? `OSS 直传失败（HTTP ${xhr.status}），请检查 Bucket CORS、Endpoint 和签名配置`
        : `素材上传失败（HTTP ${xhr.status}）`), { code: 'ASSET_BINARY_UPLOAD_FAILED' }));
    };
    xhr.onerror = () => reject(Object.assign(new Error(ticket.driver === 'oss'
      ? '浏览器无法直传 OSS，请检查 Bucket CORS 是否允许当前站点执行 PUT，并确认公网 Endpoint 可访问'
      : '素材上传连接中断，请重试'), { code: 'ASSET_BINARY_UPLOAD_FAILED' }));
    xhr.ontimeout = () => reject(Object.assign(new Error('素材上传超时，请检查网络后重试'), { code: 'ASSET_BINARY_UPLOAD_TIMEOUT' }));
    xhr.onabort = () => reject(Object.assign(new Error('素材上传已取消'), { code: 'ASSET_BINARY_UPLOAD_ABORTED' }));
    xhr.send(file);
  });
  return request(`/api/projects/${state.project.id}/assets/uploads/${encodeURIComponent(ticket.uploadId)}/complete`, {
    method: 'POST',
    timeoutMs: 5 * 60_000,
    body: JSON.stringify({ token: ticket.token })
  });
}

async function searchAssets() {
  const query = $('#assetSearchInput').value.trim();
  const kind = $('#assetKindFilter').value;
  if (!query) return renderAssets(state.project.assets || []);
  try {
    const params = new URLSearchParams({ q: query, kind, limit: '30' });
    const result = await request(`/api/projects/${state.project.id}/assets/search?${params}`);
    renderAssets(result.items || []);
  } catch {
    renderAssets(state.project.assets || []);
  }
}

function prepareDigitalHumanFromCopy() {
  const copy = activeCopy() || state.project?.copy;
  if (!copy) return false;
  setProductionMode('digital');
  return syncCopyToDigitalHumanInputs(copy, { force: true });
}

navItems.forEach((button) => button.addEventListener('click', () => go(button.dataset.view)));
document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-go]');
  if (target && !target.hasAttribute('data-guided-start')) go(target.dataset.go);
});

$('#copyUseBenchmarkReferenceInput')?.addEventListener('change', () => {
  renderCopyBenchmarkReferences(state.project?.benchmarks || []);
});
$('#strategyNextStepButton').addEventListener('click', () => go('benchmark'));
$('#benchmarkNextStepButton').addEventListener('click', () => go('copy'));
$('#copyNextStepButton').addEventListener('click', () => {
  if (!prepareDigitalHumanFromCopy()) return toast('请先生成一套文案');
  go('media');
});
$('#mediaNextStepButton').addEventListener('click', () => {
  prepareDigitalHumanFromCopy();
  go('render');
});
$('#renderNextStepButton').addEventListener('click', () => go('publish'));

$('#projectSelect').addEventListener('change', (event) => {
  selectProject(event.target.value).catch((error) => toast(error.message));
});
$('#chatPresetSelect').addEventListener('change', async (event) => {
  if (!state.project || !state.chat) return;
  const previous = state.chat.activePresetId;
  state.chat.activePresetId = event.target.value;
  renderChat();
  try {
    await request(`/api/projects/${state.project.id}/chat`, { method: 'PATCH', body: JSON.stringify({ presetId: state.chat.activePresetId }) });
  } catch (error) {
    state.chat.activePresetId = previous;
    renderChat();
    toast(error.message);
  }
});
$('#chatComposer').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.project || !state.chat || state.chat.pending) return;
  const input = $('#chatMessageInput');
  const message = input.value.trim();
  if (!message) return;
  const button = $('#chatSendButton');
  const previousMessages = [...(state.chat.messages || [])];
  input.value = '';
  state.chat.messages = [...previousMessages, { id: 'pending-user', role: 'user', content: message, presetId: state.chat.activePresetId, createdAt: new Date().toISOString() }];
  state.chat.pending = true;
  setButtonLoading(button, true, '思考中');
  renderChat({ scrollToEnd: true });
  try {
    const result = await request(`/api/projects/${state.project.id}/chat`, {
      method: 'POST',
      body: JSON.stringify({ message, presetId: state.chat.activePresetId })
    });
    state.chat.messages = [...previousMessages, result.userMessage, result.assistantMessage];
    state.chat.activePresetId = result.activePresetId;
  } catch (error) {
    state.chat.messages = previousMessages;
    input.value = message;
    toast(error.message);
  } finally {
    state.chat.pending = false;
    setButtonLoading(button, false);
    renderChat({ scrollToEnd: true });
    await refreshPointsContext().catch(() => {});
    input.focus();
  }
});
$('#chatMessageInput').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  $('#chatComposer').requestSubmit();
});
$('#clearChatButton').addEventListener('click', async () => {
  if (!state.project || !state.chat?.messages?.length) return;
  const confirmed = await window.uiDialog.confirm({ title: '开始新对话', message: '当前项目的对话记录将被清空。', confirmText: '清空并开始', danger: true });
  if (!confirmed) return;
  try {
    await request(`/api/projects/${state.project.id}/chat`, { method: 'DELETE' });
    state.chat.messages = [];
    renderChat();
    $('#chatMessageInput').focus();
  } catch (error) { toast(error.message); }
});
document.addEventListener('click', (event) => {
  const starter = event.target.closest('[data-chat-starter]');
  if (!starter) return;
  $('#chatMessageInput').value = starter.dataset.chatStarter;
  $('#chatMessageInput').focus();
});
async function refreshPlatformConnections(button, message = true) {
  await withButtonLoading(button, async () => {
    try {
      state.connections = await request('/api/account/platform-connections');
      renderAccountWorkspace();
      if (message) toast('平台授权状态已刷新');
    } catch (error) { toast(error.message); }
  }, '刷新中');
}

const platformAuthActiveStatuses = new Set(['preparing', 'waiting_scan', 'waiting_verification', 'waiting_interaction', 'waiting_confirm']);
const platformAuthStatusLabels = {
  preparing: '正在准备',
  waiting_scan: '等待扫码',
  waiting_verification: '身份验证',
  waiting_interaction: '登录验证',
  waiting_confirm: '等待确认',
  connected: '授权成功',
  expired: '二维码已过期',
  failed: '授权失败',
  cancelled: '已取消'
};

function platformAuthMessage(value, status) {
  const message = String(value || '').trim();
  const fallback = status === 'connected'
    ? '平台授权成功'
    : status === 'failed'
      ? '授权失败，请重新获取二维码'
      : status === 'expired'
        ? '授权二维码已过期，请重新获取'
    : status === 'waiting_scan'
      ? '请使用平台手机端扫码，并在手机上确认授权'
      : status === 'waiting_interaction'
        ? '请在完整登录页面中继续完成平台验证'
      : status === 'waiting_confirm'
        ? '已扫码，请在手机端确认授权'
        : '正在连接平台授权页面';
  if (!message || message.length > 240 || /(?:data:image\/|;base64,|__CHENSI_PUBLISH_)/i.test(message)) return fallback;
  return message;
}

function renderPlatformVerification() {
  const panel = $('#platformVerificationPanel');
  const methodsElement = $('#platformVerificationMethods');
  const phone = $('#platformVerificationPhone');
  const form = $('#platformVerificationCodeForm');
  panel.classList.add('hidden');
  methodsElement.replaceChildren();
  methodsElement.dataset.signature = '';
  form.classList.add('hidden');
  phone.classList.add('hidden');
}

function platformBrowserLocation(remoteBrowser) {
  const title = String(remoteBrowser?.title || '').trim();
  try {
    const hostname = new URL(remoteBrowser?.url || '').hostname;
    return title ? `${title} · ${hostname}` : hostname || '平台登录页面';
  } catch {
    return title || '平台登录页面';
  }
}

function renderPlatformBrowser(remoteBrowser, active) {
  const panel = $('#platformBrowserPanel');
  const image = $('#platformBrowserImage');
  const openButton = $('#openPlatformBrowserButton');
  const hasFrame = Boolean(remoteBrowser?.frameDataUrl);
  const requested = Boolean(remoteBrowser?.requested);
  panel.classList.toggle('hidden', !hasFrame);
  openButton.classList.toggle('hidden', hasFrame || !active);
  openButton.disabled = requested;
  openButton.textContent = requested ? '正在打开完整登录页面' : '打开完整登录页面';
  $('.platform-auth-modal').classList.toggle('is-browser-mode', hasFrame);
  if (!hasFrame) return;
  if (image.src !== remoteBrowser.frameDataUrl) image.src = remoteBrowser.frameDataUrl;
  image.dataset.width = String(remoteBrowser.width || 1280);
  image.dataset.height = String(remoteBrowser.height || 720);
  $('#platformBrowserLocation').textContent = platformBrowserLocation(remoteBrowser);
}

function renderPlatformAuthTask(task) {
  if (!task) return;
  const previous = state.platformAuth.task;
  const current = { ...previous, ...task };
  if (!Object.hasOwn(task, 'qrCode') && previous?.qrCode) current.qrCode = previous.qrCode;
  if (task.remoteBrowser && previous?.remoteBrowser?.frameDataUrl && !task.remoteBrowser.frameDataUrl) {
    current.remoteBrowser = { ...previous.remoteBrowser, ...task.remoteBrowser };
  } else if (!Object.hasOwn(task, 'remoteBrowser') && previous?.remoteBrowser) {
    current.remoteBrowser = previous.remoteBrowser;
  }
  state.platformAuth.task = current;
  const status = current.status || 'preparing';
  const active = platformAuthActiveStatuses.has(status);
  const retryable = ['expired', 'failed', 'cancelled'].includes(status);
  const image = $('#platformAuthQrImage');
  const placeholder = $('#platformAuthPlaceholder');
  const qrFrame = image.closest('.platform-auth-qr-frame');
  const verification = current.verification;
  const hasBrowserFrame = Boolean(current.remoteBrowser?.frameDataUrl);
  const showVerificationQr = verification?.selectedMethod === 'face';
  const showQrFrame = !hasBrowserFrame && (!verification || showVerificationQr);
  $('#platformAuthTitle').textContent = `${current.platform || state.platformAuth.platform || '平台'}授权`;
  $('#platformAuthStatus').dataset.status = status;
  $('#platformAuthStatusBadge').textContent = platformAuthStatusLabels[status] || '授权处理中';
  $('#platformAuthMessage').textContent = platformAuthMessage(current.message, status);
  renderPlatformVerification();
  renderPlatformBrowser(current.remoteBrowser, active);
  qrFrame.classList.toggle('hidden', !showQrFrame);
  $('#platformAuthHint').textContent = hasBrowserFrame
    ? '页面操作会安全发送到当前账号的独立授权会话，登录完成后自动保存。'
    : verification
    ? '正在加载平台完整验证页面，后续操作直接在页面中完成。'
    : '二维码仅用于本次授权。扫码后请在手机端确认，页面会自动更新授权结果。';
  if (current.qrCode) {
    if (image.src !== current.qrCode) image.src = current.qrCode;
    image.classList.remove('hidden');
    placeholder.classList.add('hidden');
  } else {
    image.removeAttribute('src');
    image.classList.add('hidden');
    placeholder.classList.remove('hidden');
    placeholder.querySelector('small').textContent = status === 'connected' ? '授权已完成' : retryable ? '请重新获取二维码' : '正在获取授权二维码';
  }
  $('#retryPlatformAuthButton').classList.toggle('hidden', !retryable);
  $('#cancelPlatformAuthButton').textContent = active ? '取消授权' : '关闭';
}

async function closePlatformAuth({ cancelActive = true } = {}) {
  const task = state.platformAuth.task;
  if (task?.id) polling.stop(`platform-auth:${task.id}`);
  if (cancelActive && task?.id && platformAuthActiveStatuses.has(task.status)) {
    await request(`/api/account/platform-connection-tasks/${encodeURIComponent(task.id)}`, { method: 'DELETE' }).catch(() => {});
  }
  window.uiDialog.close($('#platformAuthModal'));
  $('#platformVerificationCodeInput').value = '';
  state.platformAuth.task = null;
}

async function completePlatformAuth(task) {
  if (task.status !== 'connected') return;
  state.connections = state.connections.map((connection) => (
    connection.platformId === task.platformId || connection.platform === task.platform
      ? { ...connection, status: 'connected', note: task.message || '扫码登录态有效' }
      : connection
  ));
  renderAccountWorkspace();
  toast(`${task.platform}授权成功`);
  await closePlatformAuth({ cancelActive: false });
  request('/api/account/platform-connections').then((connections) => {
    state.connections = connections;
    renderAccountWorkspace();
  }).catch(() => {});
}

function pollPlatformAuth(task) {
  const expiresAt = Date.parse(task.expiresAt || '');
  const timeoutMs = Number.isFinite(expiresAt) ? Math.max(5_000, expiresAt - Date.now() + 5_000) : 10 * 60_000;
  polling.start(`platform-auth:${task.id}`, {
    intervalMs: 1_000,
    timeoutMs,
    poll: async () => {
      const qrVersion = state.platformAuth.task?.qrCodeUpdatedAt;
      const frameVersion = state.platformAuth.task?.remoteBrowser?.frameUpdatedAt;
      const params = new URLSearchParams();
      if (qrVersion) params.set('qrCodeUpdatedAt', qrVersion);
      if (frameVersion) params.set('browserFrameUpdatedAt', frameVersion);
      const query = params.size ? `?${params}` : '';
      const current = await request(`/api/account/platform-connection-tasks/${encodeURIComponent(task.id)}${query}`);
      renderPlatformAuthTask(current);
      if (!platformAuthActiveStatuses.has(current.status)) {
        await completePlatformAuth(current);
        return true;
      }
      return false;
    },
    onTimeout: () => renderPlatformAuthTask({ ...state.platformAuth.task, status: 'expired', message: '等待扫码超时，请重新获取二维码', qrCode: null }),
    onError: (error) => renderPlatformAuthTask({ ...state.platformAuth.task, status: 'failed', message: error?.message || '授权状态读取失败，请重试', qrCode: null })
  });
}

async function sendPlatformBrowserAction(action, input = {}, button = null) {
  const task = state.platformAuth.task;
  if (!task?.id || !platformAuthActiveStatuses.has(task.status)) return;
  if (button) setButtonLoading(button, true, '同步中');
  try {
    const current = await request(`/api/account/platform-connection-tasks/${encodeURIComponent(task.id)}/interaction`, {
      method: 'POST',
      body: JSON.stringify({ action, ...input })
    });
    renderPlatformAuthTask(current);
  } catch (error) {
    toast(error.message);
  } finally {
    if (button) setButtonLoading(button, false);
  }
}

async function beginPlatformAuth(platform, trigger = state.platformAuth.trigger) {
  const previous = state.platformAuth.task;
  if (previous?.id) {
    polling.stop(`platform-auth:${previous.id}`);
    if (platformAuthActiveStatuses.has(previous.status)) {
      await request(`/api/account/platform-connection-tasks/${encodeURIComponent(previous.id)}`, { method: 'DELETE' }).catch(() => {});
    }
  }
  state.platformAuth = { task: null, platform, trigger };
  renderPlatformAuthTask({ platform, status: 'preparing', message: `正在准备${platform}授权二维码`, qrCode: null });
  window.uiDialog.open($('#platformAuthModal'), { initialFocus: '#cancelPlatformAuthButton', returnFocus: trigger });
  setButtonLoading(trigger, true, '准备二维码');
  try {
    const task = await request('/api/account/platform-connection-tasks', { method: 'POST', body: JSON.stringify({ platform }) });
    renderPlatformAuthTask(task);
    if (platformAuthActiveStatuses.has(task.status)) pollPlatformAuth(task);
    else await completePlatformAuth(task);
  } catch (error) {
    renderPlatformAuthTask({ platform, status: 'failed', message: error.message, qrCode: null });
  } finally {
    setButtonLoading(trigger, false);
  }
}

$('#refreshPlatformConnectionsButton').addEventListener('click', (event) => refreshPlatformConnections(event.currentTarget));
$('#refreshPublishConnectionsButton').addEventListener('click', (event) => refreshPlatformConnections(event.currentTarget));
$('#closePlatformAuthModal').addEventListener('click', () => closePlatformAuth());
$('#cancelPlatformAuthButton').addEventListener('click', () => closePlatformAuth());
$('#retryPlatformAuthButton').addEventListener('click', () => beginPlatformAuth(state.platformAuth.platform, state.platformAuth.trigger));
$('#platformAuthModal').addEventListener('click', (event) => { if (event.target.id === 'platformAuthModal') closePlatformAuth(); });
$('#openPlatformBrowserButton').addEventListener('click', (event) => sendPlatformBrowserAction('open_browser', {}, event.currentTarget));
$('#platformBrowserBackButton').addEventListener('click', (event) => sendPlatformBrowserAction('go_back', {}, event.currentTarget));
$('#platformBrowserReloadButton').addEventListener('click', (event) => sendPlatformBrowserAction('reload', {}, event.currentTarget));
$('#platformBrowserScrollUpButton').addEventListener('click', (event) => sendPlatformBrowserAction('scroll', { deltaY: -640 }, event.currentTarget));
$('#platformBrowserScrollDownButton').addEventListener('click', (event) => sendPlatformBrowserAction('scroll', { deltaY: 640 }, event.currentTarget));
$('#platformBrowserEnterButton').addEventListener('click', (event) => sendPlatformBrowserAction('press_key', { key: 'Enter' }, event.currentTarget));
$('#platformBrowserInputForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('#platformBrowserTextInput');
  const text = input.value;
  if (!text) return;
  await sendPlatformBrowserAction('type_text', { text }, $('#platformBrowserTypeButton'));
  input.value = '';
});
$('#platformBrowserViewport').addEventListener('keydown', (event) => {
  if (!['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  sendPlatformBrowserAction('press_key', { key: event.key });
});
let platformBrowserPointerStart = null;
$('#platformBrowserViewport').addEventListener('pointerdown', (event) => {
  const image = $('#platformBrowserImage');
  const rect = image.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  event.currentTarget.setPointerCapture?.(event.pointerId);
  platformBrowserPointerStart = {
    x: (event.clientX - rect.left) * (Number(image.dataset.width) || 1280) / rect.width,
    y: (event.clientY - rect.top) * (Number(image.dataset.height) || 720) / rect.height,
    pointerId: event.pointerId
  };
});
$('#platformBrowserViewport').addEventListener('pointerup', (event) => {
  const start = platformBrowserPointerStart;
  platformBrowserPointerStart = null;
  if (!start || start.pointerId !== event.pointerId) return;
  const image = $('#platformBrowserImage');
  const rect = image.getBoundingClientRect();
  const end = {
    x: (event.clientX - rect.left) * (Number(image.dataset.width) || 1280) / rect.width,
    y: (event.clientY - rect.top) * (Number(image.dataset.height) || 720) / rect.height
  };
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  if (distance < 8) sendPlatformBrowserAction('click', end);
  else sendPlatformBrowserAction('drag', { startX: start.x, startY: start.y, endX: end.x, endY: end.y });
});
$('#platformVerificationMethods').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-platform-verification-method]');
  const task = state.platformAuth.task;
  if (!button || !task?.id || button.dataset.platformVerificationMethod === task.verification?.selectedMethod) return;
  setButtonLoading(button, true);
  try {
    const current = await request(`/api/account/platform-connection-tasks/${encodeURIComponent(task.id)}/verification`, {
      method: 'POST',
      body: JSON.stringify({ action: 'select_method', method: button.dataset.platformVerificationMethod })
    });
    renderPlatformAuthTask(current);
  } catch (error) { toast(error.message); }
  finally { setButtonLoading(button, false); }
});
$('#platformVerificationCodeForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const task = state.platformAuth.task;
  const input = $('#platformVerificationCodeInput');
  const button = $('#submitPlatformVerificationCodeButton');
  const code = input.value.replace(/\s+/g, '');
  if (!task?.id || !/^\d{4,8}$/.test(code)) return toast('请输入 4 至 8 位数字验证码');
  setButtonLoading(button, true, '验证中');
  try {
    const current = await request(`/api/account/platform-connection-tasks/${encodeURIComponent(task.id)}/verification`, {
      method: 'POST',
      body: JSON.stringify({ action: 'submit_code', code })
    });
    input.value = '';
    renderPlatformAuthTask(current);
  } catch (error) { toast(error.message); }
  finally { setButtonLoading(button, false); }
});
$('#resendPlatformVerificationCodeButton').addEventListener('click', async (event) => {
  const task = state.platformAuth.task;
  if (!task?.id) return;
  setButtonLoading(event.currentTarget, true, '发送中');
  try {
    const current = await request(`/api/account/platform-connection-tasks/${encodeURIComponent(task.id)}/verification`, {
      method: 'POST',
      body: JSON.stringify({ action: 'resend_code' })
    });
    renderPlatformAuthTask(current);
  } catch (error) { toast(error.message); }
  finally { setButtonLoading(event.currentTarget, false); }
});
$('#selectJianyingDirectoryButton').addEventListener('click', async (event) => {
  await withButtonLoading(event.currentTarget, async () => {
    try {
      const pickerId = `chensi-jy-${String(state.user?.id || 'user').replace(/[^a-zA-Z0-9_-]/g, '').slice(-16)}`;
      const handle = await window.showDirectoryPicker({ id: pickerId, mode: 'readwrite', startIn: 'documents' });
      await inspectJianyingDirectory(handle);
      await saveJianyingHandle(handle);
      state.jianying.directoryHandle = handle;
      state.jianying.permission = 'granted';
      renderJianyingRoot();
      toast('剪映草稿目录已保存，以后导入无需安装助手');
    } catch (error) {
      if (error?.name !== 'AbortError') toast(error.message);
    }
  }, '读取目录');
});
$('#forgetJianyingDirectoryButton').addEventListener('click', async (event) => {
  await withButtonLoading(event.currentTarget, async () => {
    try {
      await deleteJianyingHandle();
      state.jianying.directoryHandle = null;
      state.jianying.permission = 'prompt';
      renderJianyingRoot();
      toast('已清除当前账号保存的草稿目录授权');
    } catch (error) { toast(error.message); }
  }, '清除中');
});
$('#refreshButton').addEventListener('click', async () => {
  const selectedProjectId = state.project?.id;
  const [me, catalog, projects, health, organization, tickets, connections, backgroundMusic, talkingPhotoStatus] = await Promise.all([
    request('/api/auth/me'), request('/api/catalog'), request('/api/projects'), request('/api/health'),
    request('/api/account/organization'), request('/api/account/tickets'), request('/api/account/platform-connections'),
    request('/api/background-music').catch((error) => { state.backgroundMusicError = error.message; return []; }),
    request('/api/account-media/talking-photo/status').catch(() => null)
  ]);
  state.user = me;
  state.catalog = catalog;
  renderTaskCosts();
  state.projects = projects;
  state.organization = organization;
  state.tickets = tickets;
  state.connections = connections;
  state.backgroundMusic = backgroundMusic;
  state.talkingPhotoStatus = talkingPhotoStatus;
  state.copies = [];
  renderProjectSelect();
  renderTemplates();
  renderBackgroundMusicOptions();
  renderAccountWorkspace();
  renderSupport();
  renderCopyLibrary();
  renderJianyingRoot();
  const target = projects.find((project) => project.id === selectedProjectId) || projects[0];
  if (target) await selectProject(target.id);
  $('#healthDot').classList.add('ok');
  $('#healthText').textContent = health.mode === 'local' ? '本地服务在线' : '服务在线';
  toast('项目、工单与账号数据已刷新');
});
$('#saveProfileButton').addEventListener('click', () => saveProfile());
$('#positioningButton').addEventListener('click', async (event) => {
  await withButtonLoading(event.currentTarget, async () => {
    try { await saveProfile(false); state.project.positioning = await request(`/api/projects/${state.project.id}/positioning`, { method: 'POST', body: '{}' }); renderPositioning(state.project.positioning); renderOverview(state.project); syncWorkflowNextSteps(state.project); toast('IP 定位已生成'); } catch (error) { toast(error.message); } finally { await refreshPointsContext().catch(() => {}); }
  });
});

$('#analyzeBenchmarkButton').addEventListener('click', async (event) => {
  const input = $('#benchmarkInput');
  if (!input.value.trim()) return toast('请粘贴抖音、小红书或视频号分享文案，其他平台请上传视频');
  const button = event.currentTarget;
  if (!setButtonLoading(button, true)) return;
  try {
    const item = await request(`/api/projects/${state.project.id}/benchmarks`, { method: 'POST', body: JSON.stringify({ url: input.value.trim(), platform: $('#platformSelect').value }) });
    state.project.benchmarks.unshift(item);
    renderBenchmarks(state.project.benchmarks);
    input.value = '';
    monitorBenchmark(item, button);
  } catch (error) {
    setButtonLoading(button, false);
    toast(error.message);
  }
});
$('#accountAnalysisButton').addEventListener('click', async (event) => {
  const account = $('#accountAnalysisInput').value.trim();
  if (!account) return toast('请填写抖音账号名称、主页链接或账号标识');
  await withButtonLoading(event.currentTarget, async () => {
    try {
      const report = await request(`/api/projects/${state.project.id}/account-analyses`, { method: 'POST', body: JSON.stringify({ account }) });
      state.project.accountAnalyses ||= [];
      state.project.accountAnalyses.unshift(report);
      renderAccountAnalyses(state.project.accountAnalyses);
      $('#accountAnalysisInput').value = '';
      if (report.status === 'analyzing') monitorAccountAnalysis(report);
      else toast('账号风格报告已生成');
    } catch (error) { toast(error.message); }
  }, '聚合分析中');
});
document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-reanalyze-benchmark]');
  if (!button || !state.project) return;
  if (!setButtonLoading(button, true, '分析中')) return;
  try {
    const item = await request(`/api/projects/${state.project.id}/benchmarks/${button.dataset.reanalyzeBenchmark}/reanalyze`, { method: 'POST', body: '{}' });
    const current = state.project.benchmarks.find((benchmark) => benchmark.id === item.id);
    if (current) Object.assign(current, item);
    state.project.benchmarks = [current || item, ...state.project.benchmarks.filter((benchmark) => benchmark.id !== item.id)];
    renderBenchmarks(state.project.benchmarks);
    monitorBenchmark(item, $('#analyzeBenchmarkButton'));
  } catch (error) {
    setButtonLoading(button, false);
    toast(error.message);
  }
});
document.addEventListener('click', (event) => {
  const edit = event.target.closest('[data-edit-benchmark]');
  if (edit) {
    event.preventDefault();
    openBenchmarkLibraryEditor(edit.dataset.editBenchmark);
    return;
  }
  const save = event.target.closest('[data-save-benchmark]');
  if (save) {
    event.preventDefault();
    saveBenchmarkToLibrary(save.dataset.saveBenchmark, save);
  }
});
$('#benchmarkUploadButton').addEventListener('click', () => $('#benchmarkFileInput').click());
$('#benchmarkFileInput').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  const button = $('#benchmarkUploadButton');
  if (!setButtonLoading(button, true)) return;
  try {
    const asset = await uploadAsset(file);
    state.project.assets.unshift(asset);
    const item = await request(`/api/projects/${state.project.id}/benchmarks`, {
      method: 'POST',
      body: JSON.stringify({ assetId: asset.id, title: file.name })
    });
    state.project.benchmarks.unshift(item);
    renderAssets(state.project.assets);
    renderMaterialSelectors(state.project);
    renderBenchmarks(state.project.benchmarks);
    monitorBenchmark(item, button);
  } catch (error) { setButtonLoading(button, false); toast(error.message); }
  event.target.value = '';
});

$$('.copy-mode').forEach((button) => button.addEventListener('click', () => setCopyMode(button.dataset.copyMode)));
$('#copyButton').addEventListener('click', async () => {
  try { await generateCopyMode(state.copyMode); } catch (error) { toast(error.message); }
});
$('#copyExportButton').addEventListener('click', () => {
  const copy = activeCopy();
  if (!copy) return toast('当前模式还没有可导出的文案');
  downloadJson(`${state.project.name}-${state.copyMode === 'qa' ? '问答文案' : '标准口播'}.json`, copy);
});
$('#copyResultButton').addEventListener('click', async () => {
  const copy = activeCopy();
  if (!copy) return toast('当前模式还没有可复制的文案');
  try {
    await writeTextToClipboard(buildCopyClipboardText(copy, state.copyMode));
    toast('完整文案已复制到剪贴板');
  } catch (error) {
    toast(error.message);
  }
});
document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-replace-compliance-terms]');
  if (!button || !state.project) return;
  const copy = activeCopy();
  if (!copy) return toast('当前模式还没有可替换的文案');
  if (!setButtonLoading(button, true, '替换中')) return;
  try {
    const nextCopy = await request(`/api/projects/${state.project.id}/copy/replace-compliance`, {
      method: 'POST',
      body: JSON.stringify({ mode: state.copyMode, libraryId: copy.libraryId })
    });
    state.project.copyVariants ||= {};
    state.project.copyVariants[state.copyMode] = nextCopy;
    state.project.copy = nextCopy;
    renderCopy(nextCopy, state.copyMode);
    renderOverview(state.project);
    await loadCopies();
    const replacedCount = Number(nextCopy.replacementSummary?.replacedCount || 0);
    toast(replacedCount ? `已替换 ${replacedCount} 处风险词，请复核语义后发布` : '没有可安全自动替换的风险词，请人工复核');
  } catch (error) {
    setButtonLoading(button, false);
    toast(error.message);
  }
});

$('#avatarCreateButton').addEventListener('click', () => {
  if ($('#avatarConsentInput').value !== 'yes') return toast('请先确认形象授权');
  const videoAssetId = $('#avatarVideoAssetInput').value;
  if (!videoAssetId) return toast('请先上传并选择形象参考视频');
  return createGenerate('avatar_create', { mode: 'create_avatar', name: $('#avatarNameInput').value, pose: $('#avatarPoseInput').value, style: $('#avatarStyleInput').value, videoAssetId, consent: true }, '形象创建任务');
});
$('#voiceButton').addEventListener('click', () => {
  if (!$('#voiceConsentInput').checked) return toast('请先确认声音授权');
  const sample = $('#voiceSampleInput').value.trim();
  const sampleAssetId = $('#voiceAudioAssetInput').value;
  if (!sample && !sampleAssetId) return toast('请先上传并选择声音样本，或填写外部地址');
  return createGenerate('voice_clone', { name: $('#voiceNameInput').value, emotion: $('#voiceEmotionInput').value, sample, sampleAssetId, consent: true }, '声音克隆任务');
});
document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-voice-preview]');
  if (!button) return;
  createGenerate('voice_preview', { voiceId: button.dataset.voicePreview }, '声音试听任务', button);
});
document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-retry-task]');
  if (!button || !state.project) return;
  event.preventDefault();
  const previousTaskId = button.dataset.retryTask;
  if (!setButtonLoading(button, true, '重试中')) return;
  try {
    const task = await request(`/api/projects/${state.project.id}/tasks/${previousTaskId}/retry`, {
      method: 'POST',
      headers: { 'Idempotency-Key': createIdempotencyKey(`retry-${previousTaskId}`) },
      body: '{}'
    });
    state.tasks = [task, ...state.tasks.filter((item) => item.id !== previousTaskId && item.id !== task.id)];
    button.closest('.history-row')?.remove();
    await pollTask(task, '任务重试', taskButton(task.kind));
  } catch (error) {
    setButtonLoading(button, false);
    toast(error.message);
  }
});
document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-delete-kind]');
  if (!button || !state.project) return;
  event.preventDefault();
  event.stopPropagation();
  const label = button.dataset.deleteLabel || '记录';
  const confirmed = await window.uiDialog.confirm({
    title: `删除${label}`,
    message: `删除后无法恢复，请确认不再需要这个${label}。`,
    confirmText: '删除',
    tone: 'danger',
    returnFocus: button
  });
  if (!confirmed) return;
  if (!setButtonLoading(button, true, '删除中')) return;
  try {
    await request(`/api/projects/${state.project.id}/${button.dataset.deleteKind}/${button.dataset.deleteId}`, { method: 'DELETE' });
    if (button.dataset.deleteKind === 'assets' && !$('#assetPreviewModal').classList.contains('hidden')) closeAssetPreview();
    await loadProject(state.project.id);
    toast(`${label}已删除`);
  } catch (error) {
    setButtonLoading(button, false);
    toast(error.message);
  }
});
$('#digitalRenderLanguageInput').addEventListener('change', (event) => {
  const hint = $('#digitalLanguageHint');
  if (!hint) return;
  const isUyghur = event.currentTarget.value === 'ug-CN';
  hint.classList.remove('warning');
  hint.textContent = isUyghur
    ? '维吾尔语会自动转换文案并直接生成口播音频，无需上传驱动音频或选择克隆声音。'
    : '其他语言会先生成目标语言口播稿，再使用已保存声音合成口播音频。';
});
$('#digitalHumanButton').addEventListener('click', () => {
  if ($('#digitalConsentInput').value !== 'yes') return toast('请先确认形象授权');
  const avatarId = $('#digitalAvatarSelect').value;
  if (!avatarId) return toast('请先选择已保存的数字人形象');
  const script = $('#digitalScriptInput').value.trim();
  const audioAssetId = $('#digitalAudioAssetInput').value;
  if (!script && !audioAssetId) return toast('请输入文案，或选择真实驱动音频');
  const language = $('#digitalRenderLanguageInput').value;
  if (script && language !== 'ug-CN' && !$('#digitalVoiceSelect').value) return toast('输入文案时请先选择已保存声音');
  return createGenerate('digital_human', {
    avatarId,
    voiceId: $('#digitalVoiceSelect').value,
    script,
    audioAssetId,
    language,
    name: $('#digitalRenderNameInput').value,
    autoSubtitles: $('#digitalAutoSubtitleInput')?.checked !== false,
    consent: true
  }, '数字人素材任务');
});
$('#talkingPhotoUploadButton')?.addEventListener('click', () => $('#talkingPhotoUploadInput')?.click());
$('#talkingPhotoUploadInput')?.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file || !state.project) return;
  if (!/^image\/(jpeg|png)$/i.test(file.type)) return toast('数字人口播人物图片仅支持 JPG 或 PNG 格式');
  if (!window.confirm('上传人物图片即表示你已确认拥有相应肖像权或已取得必要授权；因未经授权使用产生的责任由上传者承担。是否继续？')) return;
  const button = $('#talkingPhotoUploadButton');
  await withButtonLoading(button, async () => {
    try {
      const asset = await uploadAsset(file);
      state.project.assets.unshift(asset);
      renderAssets(state.project.assets);
      renderMaterialSelectors(state.project);
      const select = $('#talkingPhotoImageSelect');
      if (select) {
        select.value = asset.id;
        window.uiSelect?.refresh(select);
      }
      toast('人物图片已上传并选中');
    } catch (error) {
      toast(error.message);
    }
  }, '上传中');
});
$('#talkingPhotoVoiceSelect')?.addEventListener('change', () => updateTalkingPhotoVoicePreview());
$('#talkingPhotoVoicePreview')?.addEventListener('error', () => {
  const hint = $('#talkingPhotoVoicePreviewHint');
  if (hint && $('#talkingPhotoVoicePreview')?.src) hint.textContent = '试听加载失败，请到媒体实验室重新生成试听。';
});
$('#talkingPhotoButton')?.addEventListener('click', () => {
  const imageAssetId = $('#talkingPhotoImageSelect')?.value || '';
  const voiceId = $('#talkingPhotoVoiceSelect')?.value || '';
  const script = $('#talkingPhotoScriptInput')?.value.trim() || '';
  if (!imageAssetId) return toast('请先选择或上传一张人物图片');
  if (talkingPhotoCapabilities().requiresVoiceSelection && !voiceId) return toast('请先选择媒体实验室中已复刻的声音');
  if (!script) return toast('请输入数字人口播文案');
  return createGenerate('talking_photo', {
    imageAssetId,
    voiceId,
    script,
    aspectRatio: $('#talkingPhotoAspectRatioInput')?.value || '9:16',
    name: $('#talkingPhotoNameInput')?.value.trim() || '',
    consent: true
  }, '数字人口播任务');
});
$('#imageButton').addEventListener('click', () => { const prompt = $('#imagePromptInput').value.trim(); if (!prompt) return toast('请填写图片生成提示词'); return createGenerate('image', { prompt, style: $('#imageStyleInput').value, referenceAssetIds: selectedImageReferenceAssetIds() }, '配图任务'); });
$('#imageReferenceUploadButton').addEventListener('click', () => $('#imageReferenceUploadInput').click());
$('#imageReferenceUploadInput').addEventListener('change', async (event) => {
  const files = [...(event.target.files || [])].slice(0, 4);
  if (!files.length) return;
  if (!window.confirm('上传参考图即表示你已确认拥有相应使用权或已取得必要授权；因侵权产生的责任由上传者承担。是否继续？')) { event.target.value = ''; return; }
  try {
    const uploadedIds = [];
    for (const file of files) {
      const asset = await uploadAsset(file);
      state.project.assets.unshift(asset);
      uploadedIds.push(asset.id);
    }
    renderAssets(state.project.assets);
    const selectableIds = uploadedIds.filter((assetId) => !isHiddenReferenceAsset(state.project.assets.find((asset) => asset.id === assetId)));
    state.assetPicker.image = [...new Set([...(state.assetPicker.image || []), ...selectableIds])].slice(0, 4);
    renderMaterialSelectors(state.project);
    updateImageReferenceSummary();
    toast(`已上传并选择 ${uploadedIds.length} 张参考图`);
  } catch (error) { toast(error.message); }
  event.target.value = '';
});
document.addEventListener('change', (event) => {
  if (!event.target.matches('[data-asset-picker-choice]') || !activeAssetPicker) return;
  const selected = $$('[data-asset-picker-choice]:checked').map((input) => input.value).filter(Boolean);
  const autoEdit = activeAssetPicker.type === 'video' && ($('#renderTemplateInput')?.value || 'vlog') === 'vlog';
  const max = activeAssetPicker.type === 'image' ? 4 : autoEdit ? 1 : 12;
  if (selected.length > max) {
    event.target.checked = false;
    toast(`${activeAssetPicker.type === 'image' ? '参考图' : '视频素材'}最多选择 ${max} 个`);
    return;
  }
  activeAssetPicker.draft = selected;
  $('#assetPickerModalHint').textContent = `${activeAssetPicker.type === 'image' ? '最多选择 4 张' : autoEdit ? '仅选择 1 条，其他素材自动匹配' : '最多选择 12 条'} · 已选择 ${selected.length}`;
});
$('#coverFrameButton').addEventListener('click', async (event) => {
  const [sourceType, sourceId] = String($('#coverFrameSourceInput').value || '').split(':');
  if (!sourceId) return toast('请先选择视频素材或成片');
  await withButtonLoading(event.currentTarget, async () => {
    try {
      const asset = await request(`/api/projects/${state.project.id}/covers/frame`, { method: 'POST', body: JSON.stringify({ sourceType, sourceId, timestamp: Number($('#coverFrameTimeInput').value || 0) }) });
      state.project.assets.unshift(asset);
      renderAssets(state.project.assets);
      renderMedia(state.project);
      toast('封面帧已截取并保存到素材库');
    } catch (error) { toast(error.message); }
  }, '截帧中');
});
document.addEventListener('click', async (event) => {
  const importButton = event.target.closest('[data-import-jianying]');
  if (importButton && state.project) {
    await withButtonLoading(importButton, async () => {
      try {
        await importOutputToBrowserJianying(importButton.dataset.importJianying, importButton);
      } catch (error) { toast(error.message); }
    }, '准备剪映草稿');
    return;
  }
  const button = event.target.closest('[data-export-editing]');
  if (!button || !state.project) return;
  await withButtonLoading(button, async () => {
    try {
      const pack = await request(`/api/projects/${state.project.id}/editing-packages`, { method: 'POST', body: JSON.stringify({ sourceOutputId: button.dataset.exportEditing }) });
      downloadJson(`${state.project.name}-剪映继续编辑交接包.json`, pack);
      toast('剪映继续编辑交接包已下载');
    } catch (error) { toast(error.message); }
  }, '导出中');
});

$('#assetUploadButton').addEventListener('click', () => $('#assetFileInput').click());
$('#manageAssetCategoriesButton')?.addEventListener('click', (event) => openAssetCategoryManager(event.currentTarget));
$('#assetCategoryCreateForm')?.addEventListener('submit', createAssetCategory);
$('#closeAssetCategoryManager')?.addEventListener('click', closeAssetCategoryManager);
$('#doneAssetCategoryManager')?.addEventListener('click', closeAssetCategoryManager);
$('#assetCategoryManagerModal')?.addEventListener('click', (event) => {
  if (event.target.id === 'assetCategoryManagerModal') closeAssetCategoryManager();
  const updateButton = event.target.closest('[data-update-category]');
  if (updateButton) updateAssetCategory(updateButton.dataset.updateCategory, updateButton);
  const deleteButton = event.target.closest('[data-delete-category]');
  if (deleteButton) deleteAssetCategory(deleteButton.dataset.deleteCategory, deleteButton);
});
$('#organizeAssetCategoriesButton')?.addEventListener('click', (event) => organizeAssetCategories(event.currentTarget));
$('#assetFileInput').addEventListener('change', async (event) => {
  const files = [...event.target.files];
  if (!files.length) return;
  if (!window.confirm('上传素材即表示你已确认拥有相应使用权或已取得必要授权；因侵权产生的责任由上传者承担。是否继续？')) { event.target.value = ''; return; }
  const videoCategory = $('#assetUploadCategoryInput')?.value || '场景';
  const button = $('#assetUploadButton');
  if (!setButtonLoading(button, true, '上传中')) return;
  const progressHandler = (progressEvent) => {
    const fileIndex = files.indexOf(progressEvent.detail.file);
    if (fileIndex < 0) return;
    const aggregate = Math.round(((fileIndex + progressEvent.detail.progress / 100) / files.length) * 95);
    setButtonProgress(button, aggregate, `上传 ${fileIndex + 1}/${files.length}`);
  };
  window.addEventListener('chensi:asset-upload-progress', progressHandler);
  try {
    for (const file of files) {
      const asset = await uploadAsset(file, { videoCategory });
      state.project.assets.unshift(asset);
    }
    if (!state.assetPicker.video.length) {
      const firstVideo = state.project.assets.find((asset) => assetMediaType(asset) === 'video');
      if (firstVideo) state.assetPicker.video = [firstVideo.id];
    }
    renderAssets(state.project.assets);
    renderMaterialSelectors(state.project);
    toast(`已加入 ${files.length} 个素材`);
    event.target.value = '';
  } catch (error) { toast(error.message); }
  finally {
    window.removeEventListener('chensi:asset-upload-progress', progressHandler);
    setButtonLoading(button, false);
  }
});
document.addEventListener('click', (event) => {
  const trigger = event.target.closest('[data-categorize-asset]');
  if (trigger) openAssetCategoryModal(trigger.dataset.categorizeAsset, trigger);
});
$('#saveAssetCategoryButton')?.addEventListener('click', saveAssetCategory);
$('#closeAssetCategoryModal')?.addEventListener('click', closeAssetCategoryModal);
$('#cancelAssetCategoryButton')?.addEventListener('click', closeAssetCategoryModal);
$('#assetCategoryModal')?.addEventListener('click', (event) => {
  if (event.target.id === 'assetCategoryModal') closeAssetCategoryModal();
});
$('#assetSearchInput').addEventListener('input', () => { clearTimeout(searchAssets.timer); searchAssets.timer = setTimeout(searchAssets, 220); });
$('#assetKindFilter').addEventListener('change', searchAssets);
$('#assetMediaTypeFilter').addEventListener('change', searchAssets);
document.addEventListener('change', (event) => {
  if (event.target.matches('[data-render-video-asset]')) updateRenderAssetSummary();
});

document.addEventListener('click', (event) => {
  const trigger = event.target.closest('[data-open-asset-picker]');
  if (trigger) {
    event.preventDefault();
    openAssetPicker(trigger.dataset.openAssetPicker, trigger);
  }
});
$('#assetPickerConfirmButton')?.addEventListener('click', confirmAssetPicker);
$('#closeAssetPicker')?.addEventListener('click', closeAssetPicker);
$('#cancelAssetPicker')?.addEventListener('click', closeAssetPicker);
$('#assetPickerModal')?.addEventListener('click', (event) => {
  if (event.target.id === 'assetPickerModal') closeAssetPicker();
});

$$('[data-production-mode]').forEach((tab) => {
  tab.addEventListener('click', () => setProductionMode(tab.dataset.productionMode));
  tab.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const modes = ['clip', 'digital', 'talking-photo'];
    const currentIndex = Math.max(0, modes.indexOf(state.productionMode));
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    setProductionMode(modes[(currentIndex + direction + modes.length) % modes.length], { focus: true });
  });
});

$('#renderButton').addEventListener('click', () => {
  const videoAssetIds = selectedRenderAssetIds();
  if (!videoAssetIds.length) return toast('请先上传并选择至少一条视频素材');
  const template = $('#renderTemplateInput').value;
  if (template === 'vlog' && videoAssetIds.length !== 1) return toast('AI 自动剪辑只需要选择一条主视频');
  const payload = {
    videoAssetIds,
    template,
    ratio: $('#renderRatioInput').value,
    mode: $('#renderModeInput').value,
  };
  const backgroundMusicId = $('#renderBackgroundMusicInput')?.value || '';
  if (backgroundMusicId) {
    payload.backgroundMusicId = backgroundMusicId;
    payload.backgroundMusicVolume = Math.max(0, Math.min(1, Number($('#renderBackgroundMusicVolumeInput')?.value || 18) / 100));
  }
  if (template === 'vlog') {
    payload.audioAssetId = $('#renderAudioAssetInput').value;
    payload.subtitleText = $('#renderSubtitleInput').value.trim();
    payload.materialStartSeconds = Number($('#renderMaterialStartInput')?.value || 0);
    payload.sourceTailSeconds = Number($('#renderSourceTailInput')?.value || 0);
    payload.hdFilter = $('#renderHdFilterInput')?.checked !== false;
    payload.subtitleEmphasis = $('#renderSubtitleEmphasisInput')?.checked !== false;
  } else if (template === 'talking-head') {
    payload.gapThreshold = Number($('#renderGapThresholdInput')?.value || 0.1);
    payload.gapPadding = Number($('#renderGapPaddingInput')?.value || 0.02);
  }
  if (template === 'vlog') return createGenerate('video', payload, 'AI 自动剪辑任务');
  const templateLabel = '口播去气口';
  const inputs = videoAssetIds.map((assetId) => {
    const asset = (state.project?.assets || []).find((item) => item.id === assetId);
    const sourceName = String(asset?.name || templateLabel).replace(/\.[a-z0-9]{2,5}$/i, '');
    return { ...payload, videoAssetIds: [assetId], title: `${sourceName}-${templateLabel}` };
  });
  return createGenerateBatch('video', inputs, `${templateLabel}任务`);
});
$('#renderTemplateInput').addEventListener('change', updateRenderTemplateDetails);
$('#renderGapThresholdInput')?.addEventListener('input', updateBreathCutOptionValues);
$('#renderGapPaddingInput')?.addEventListener('input', updateBreathCutOptionValues);
$('#renderBackgroundMusicInput')?.addEventListener('change', syncBackgroundMusicControls);
$('#renderBackgroundMusicLibraryInput')?.addEventListener('change', async (event) => {
  state.backgroundMusicSource = event.target.value === 'user' ? 'user' : 'system';
  if (state.backgroundMusicSource === 'user' && !state.userBackgroundMusic.length) await refreshUserBackgroundMusic();
  renderBackgroundMusicOptions();
});
$('#uploadBackgroundMusicButton')?.addEventListener('click', () => $('#backgroundMusicFileInput')?.click());
$('#backgroundMusicFileInput')?.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';
  await uploadUserBackgroundMusic(file, $('#uploadBackgroundMusicButton'));
});
$('#renderBackgroundMusicVolumeInput')?.addEventListener('input', syncBackgroundMusicControls);
document.addEventListener('click', (event) => { const button = event.target.closest('[data-template-select]'); if (!button) return; $('#renderTemplateInput').value = button.dataset.templateSelect; window.uiSelect?.refresh($('#renderTemplateInput')); updateRenderTemplateDetails(); toast('已选择模板'); });

function selectedPublishPlatforms() {
  return $$('[data-publish-platform]:checked').map((input) => input.value);
}

function publishInput() {
  const mode = $('input[name="publishMode"]:checked')?.value || 'immediate';
  return {
    sourceOutputId: $('#publishSourceOutputSelect').value,
    platforms: selectedPublishPlatforms(),
    title: $('#publishTitleInput').value.trim(),
    tags: $('#publishTagsInput').value.split(/[,，\n]/).map((item) => item.trim().replace(/^#+/, '')).filter(Boolean).slice(0, 10),
    coverAssetId: $('#publishCoverAssetSelect').value,
    mode,
    publishDate: mode === 'scheduled' ? $('#publishScheduleInput').value : null
  };
}

$('#publishPackageButton').addEventListener('click', () => {
  const sourceOutputId = $('#publishSourceOutputSelect').value;
  const platforms = selectedPublishPlatforms();
  if (!sourceOutputId) return toast('请先选择一条真实成片');
  if (!platforms.length) return toast('至少选择一个平台');
  createGenerate('publish', { sourceOutputId, platforms, title: $('#publishTitleInput').value.trim() }, '发布参数清单');
});
$('#platformPublishButton').addEventListener('click', () => {
  const input = publishInput();
  if (!input.sourceOutputId) return toast('请先选择一条真实成片');
  if (!input.platforms.length) return toast('请至少选择一个已授权平台');
  if (!input.title) return toast('请填写发布标题');
  if (input.mode === 'scheduled' && !input.publishDate) return toast('请选择定时发布时间');
  const unsupportedDraft = input.mode === 'draft' && input.platforms.filter((platform) => ['B站', '百家号'].includes(platform));
  const unsupportedSchedule = input.mode === 'scheduled' && input.platforms.filter((platform) => ['B站', '百家号'].includes(platform));
  if (unsupportedDraft.length) return toast(`${unsupportedDraft.join('、')}不支持保存草稿`);
  if (unsupportedSchedule.length) return toast(`${unsupportedSchedule.join('、')}不支持定时发布`);
  createGenerate('platform_publish', input, '平台发布任务');
});
document.addEventListener('change', (event) => {
  if (event.target.matches('[data-publish-platform]')) event.target.closest('.platform-card')?.classList.toggle('selected', event.target.checked);
  if (event.target.matches('input[name="publishMode"]')) {
    $$('.publish-mode-option').forEach((item) => item.classList.toggle('selected', item.contains(event.target)));
    $('#publishScheduleField').classList.toggle('hidden', event.target.value !== 'scheduled');
  }
});
$('#createOrganizationButton').addEventListener('click', async (event) => {
  await withButtonLoading(event.currentTarget, async () => {
    try {
      state.organization = await request('/api/account/organization', { method: 'POST', body: JSON.stringify({ name: `${state.user.displayName}的企业工作空间`, seatLimit: state.catalog.projectConfig?.defaultEnterpriseSeats || 5 }) });
      renderAccountWorkspace();
      toast('企业工作空间已开通');
    } catch (error) { toast(error.message); }
  }, '开通中');
});
$('#saveOrganizationButton').addEventListener('click', async (event) => {
  await withButtonLoading(event.currentTarget, async () => {
    try {
      state.organization = await request('/api/account/organization', { method: 'PATCH', body: JSON.stringify({ name: $('#organizationNameInput').value, seatLimit: Number($('#organizationSeatsInput').value) }) });
      renderAccountWorkspace(); toast('企业设置已保存');
    } catch (error) { toast(error.message); }
  }, '保存中');
});
$('#addTeamMemberButton').addEventListener('click', async (event) => {
  const account = $('#teamMemberAccountInput').value.trim();
  const displayName = $('#teamMemberNameInput').value.trim();
  const password = $('#teamMemberPasswordInput').value;
  const computeQuota = Number($('#teamMemberQuotaInput').value || 0);
  if (!displayName || !account) return toast('请填写成员姓名和登录账号');
  if (password.length < 8) return toast('成员初始密码至少 8 位');
  if (!Number.isInteger(computeQuota) || computeQuota <= 0) return toast('请设置大于 0 的成员算力使用上限');
  const permissions = $$('.permission-picker input:checked').map((input) => input.value);
  if (!permissions.length) return toast('至少选择一项成员权限');
  await withButtonLoading(event.currentTarget, async () => {
    try {
      state.organization = await request('/api/account/organization/members', { method: 'POST', body: JSON.stringify({ displayName, account, password, computeQuota, permissions }) });
      $('#teamMemberNameInput').value = ''; $('#teamMemberAccountInput').value = ''; $('#teamMemberPasswordInput').value = ''; $('#teamMemberQuotaInput').value = '';
      renderAccountWorkspace(); toast('成员已添加');
    } catch (error) { toast(error.message); }
  }, '添加中');
});
document.addEventListener('click', async (event) => {
  const editCopy = event.target.closest('[data-edit-copy]');
  if (editCopy) {
    event.preventDefault();
    event.stopPropagation();
    openCopyLibraryModal(editCopy.dataset.editCopy);
    return;
  }
  const deleteCopy = event.target.closest('[data-delete-copy]');
  if (deleteCopy) {
    event.preventDefault();
    event.stopPropagation();
    const confirmed = await window.uiDialog.confirm({
      title: '删除文案',
      message: '这篇文案将从文案库中永久移除，删除后无法恢复。',
      confirmText: '删除文案',
      tone: 'danger',
      returnFocus: deleteCopy
    });
    if (!confirmed) return;
    await withButtonLoading(deleteCopy, async () => {
      try {
        await request(`/api/copies/${deleteCopy.dataset.deleteCopy}`, { method: 'DELETE' });
        await loadCopies();
        toast('文案已删除');
      } catch (error) { toast(error.message); }
    }, '删除中');
    return;
  }
  const platform = event.target.closest('[data-connect-platform]');
  if (platform) {
    await beginPlatformAuth(platform.dataset.connectPlatform, platform);
    return;
  }
  const checkPlatform = event.target.closest('[data-check-platform]');
  if (checkPlatform) {
    await withButtonLoading(checkPlatform, async () => {
      try { await request('/api/account/platform-connections/check', { method: 'POST', body: JSON.stringify({ platform: checkPlatform.dataset.checkPlatform }) }); state.connections = await request('/api/account/platform-connections'); renderAccountWorkspace(); toast('登录状态已检查'); } catch (error) { toast(error.message); }
    }, '检查中');
    return;
  }
  const clearPlatform = event.target.closest('[data-clear-platform]');
  if (clearPlatform) {
    const confirmed = await window.uiDialog.confirm({
      title: `退出${clearPlatform.dataset.clearPlatform}授权`,
      message: '退出会同时清除当前账号在服务端保存的平台 Cookie 和浏览器登录状态；下次必须重新扫码绑定，已有内容和任务记录不会受影响。',
      confirmText: '退出授权',
      tone: 'danger',
      returnFocus: clearPlatform
    });
    if (!confirmed) return;
    await withButtonLoading(clearPlatform, async () => {
      try { const result = await request('/api/account/platform-connections/clear', { method: 'POST', body: JSON.stringify({ platform: clearPlatform.dataset.clearPlatform }) }); state.connections = await request('/api/account/platform-connections'); renderAccountWorkspace(); toast(result.message || '平台登录态已彻底清除'); } catch (error) { toast(error.message); }
    }, '退出中');
    return;
  }
  const saveMember = event.target.closest('[data-save-team-member]');
  if (saveMember) {
    const row = saveMember.closest('[data-team-member]');
    const permissions = [...row.querySelectorAll('[data-member-permission]:checked')].map((input) => input.value);
    if (!permissions.length) return toast('至少保留一项成员权限');
    await withButtonLoading(saveMember, async () => {
      try { state.organization = await request(`/api/account/organization/members/${saveMember.dataset.saveTeamMember}`, { method: 'PATCH', body: JSON.stringify({ computeQuota: Number(row.querySelector('[data-member-quota]').value || 0), permissions }) }); renderAccountWorkspace(); toast('成员权限与算力使用上限已更新'); } catch (error) { toast(error.message); }
    }, '保存中');
  }
  const removeMember = event.target.closest('[data-remove-team-member]');
  if (removeMember) {
    const confirmed = await window.uiDialog.confirm({
      title: '移除团队成员',
      message: '移除后该企业成员账号将停用，不能再访问企业空间。',
      confirmText: '移除成员',
      tone: 'danger',
      returnFocus: removeMember
    });
    if (!confirmed) return;
    await withButtonLoading(removeMember, async () => {
      try { state.organization = await request(`/api/account/organization/members/${removeMember.dataset.removeTeamMember}`, { method: 'DELETE' }); renderAccountWorkspace(); toast('成员已移除'); } catch (error) { toast(error.message); }
    }, '移除中');
  }
});
$('#createTicketButton').addEventListener('click', async (event) => {
  const subject = $('#ticketSubjectInput').value.trim(); const message = $('#ticketMessageInput').value.trim();
  if (!subject || !message) return toast('请填写工单标题和问题描述');
  await withButtonLoading(event.currentTarget, async () => {
    try {
      const ticket = await request('/api/account/tickets', { method: 'POST', body: JSON.stringify({ subject, message, category: $('#ticketCategoryInput').value }) });
      state.tickets.unshift(ticket); $('#ticketSubjectInput').value = ''; $('#ticketMessageInput').value = ''; renderSupport(); toast('工单已提交');
    } catch (error) { toast(error.message); }
  }, '提交中');
});
$('#redeemCouponButton').addEventListener('click', async (event) => {
  const code = $('#couponCodeInput').value.trim(); if (!code) return toast('请输入卡密');
  await withButtonLoading(event.currentTarget, async () => {
    try {
      const result = await request('/api/account/redeem', { method: 'POST', body: JSON.stringify({ code }) });
      await refreshPointsContext();
      $('#couponCodeInput').value = ''; renderCurrentUserMeta(); renderSupport(); renderAccountWorkspace(); toast(`已兑换 ${result.points} 算力`);
    } catch (error) { toast(error.message); }
  }, '兑换中');
});
document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-export-pack]');
  if (!button) return;
  const pack = (state.project.publishPackages || []).find((item) => item.id === button.dataset.exportPack);
  if (pack) downloadJson(`${state.project.name}-发布包-${pack.id}.json`, pack);
});
$('#customTemplateButton').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const name = $('#customTemplateNameInput').value.trim();
  const contact = $('#customTemplateContactInput').value.trim();
  const requirement = $('#customTemplateRequirementInput').value.trim();
  if (!name) return toast('请填写功能名称');
  if (!contact) return toast('请填写联系方式');
  if (!requirement) return toast('请填写功能效果与交付要求');
  await withButtonLoading(button, async () => {
    try {
      const template = await request(`/api/projects/${state.project.id}/custom-templates`, { method: 'POST', body: JSON.stringify({ name, contact, requirement }) });
      state.project.customTemplates.unshift(template);
      renderCustomTemplates(state.project);
      $('#customTemplateNameInput').value = '';
      $('#customTemplateContactInput').value = '';
      $('#customTemplateRequirementInput').value = '';
      toast('功能建议已提交，等待后台评估');
    } catch (error) { toast(error.message); }
  }, '提交中');
});

$('#newProjectButton').addEventListener('click', (event) => window.uiDialog.open($('#projectModal'), { initialFocus: '#newProjectName', returnFocus: event.currentTarget }));
$('#closeModal').addEventListener('click', () => window.uiDialog.close($('#projectModal')));
$('#projectModal').addEventListener('click', (event) => { if (event.target.id === 'projectModal') window.uiDialog.close(event.currentTarget); });
document.addEventListener('click', (event) => { const preview = event.target.closest('[data-preview-asset]'); if (preview) openAssetPreview(preview.dataset.previewAsset); });
$('#closeAssetPreview').addEventListener('click', closeAssetPreview);
$('#assetPreviewModal').addEventListener('click', (event) => { if (event.target.id === 'assetPreviewModal') closeAssetPreview(); });
$('#createCopyButton').addEventListener('click', () => openCopyLibraryModal());
$('#closeCopyLibraryModal').addEventListener('click', closeCopyLibraryModal);
$('#cancelCopyLibraryModal').addEventListener('click', closeCopyLibraryModal);
$('#copyLibraryModal').addEventListener('click', (event) => { if (event.target.id === 'copyLibraryModal') closeCopyLibraryModal(); });
$('#copyLibrarySearchInput').addEventListener('input', renderCopyLibrary);
$('#copyLibraryProjectFilter').addEventListener('change', renderCopyLibrary);
$('#copyLibraryForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#saveCopyLibraryButton');
  const title = $('#copyLibraryTitleInput').value.trim();
  const text = $('#copyLibraryTextInput').value.trim();
  if (!title) return toast('请填写文案标题');
  if (!text) return toast('请填写文案正文');
  await withButtonLoading(button, async () => {
    try {
      const editing = state.editingCopyId;
      await request(editing ? `/api/copies/${editing}` : '/api/copies', {
        method: editing ? 'PATCH' : 'POST',
        body: JSON.stringify({
          projectId: $('#copyLibraryProjectInput').value,
          title,
          mode: $('#copyLibraryModeInput').value,
          text
        })
      });
      closeCopyLibraryModal();
      await loadCopies();
      toast(editing ? '文案已更新' : '文案已创建');
    } catch (error) { toast(error.message); }
  }, '保存中');
});
$('#createProjectButton').addEventListener('click', async () => { try { const project = await request('/api/projects', { method: 'POST', body: JSON.stringify({ name: $('#newProjectName').value, industry: $('#newProjectIndustry').value, purpose: $('#newProjectPurpose').value }) }); state.projects.unshift(project); renderProjectSelect(); window.uiDialog.close($('#projectModal')); await selectProject(project.id); toast('项目已创建'); } catch (error) { toast(error.message); } });
$('#logoutButton').addEventListener('click', async () => {
  await request('/api/auth/logout', { method: 'POST', body: '{}' }).catch(() => {});
  clearAccessToken();
  window.location.assign('/login.html');
});

async function boot() {
  try {
    const me = await request('/api/auth/me').catch(() => null);
    if (!me) return window.location.assign('/login.html');
    state.user = me;
    $('#currentUserName').textContent = me.displayName;
    renderCurrentUserMeta();
    $('#userAvatar').textContent = String(me.displayName || '辰').slice(0, 1).toUpperCase();
    $('#adminEntry').classList.toggle('hidden', me.role !== 'admin');
    const [catalog, projects, health, organization, tickets, connections, backgroundMusic, talkingPhotoStatus] = await Promise.all([request('/api/catalog'), request('/api/projects'), request('/api/health'), request('/api/account/organization'), request('/api/account/tickets'), request('/api/account/platform-connections'), request('/api/background-music').catch((error) => { state.backgroundMusicError = error.message; return []; }), request('/api/account-media/talking-photo/status').catch(() => null)]);
    state.catalog = catalog; state.projects = projects; state.organization = organization; state.tickets = tickets; state.connections = connections; state.copies = []; state.backgroundMusic = backgroundMusic; state.talkingPhotoStatus = talkingPhotoStatus;
    renderTaskCosts();
    const minimumSchedule = new Date(Date.now() + 2 * 60 * 60 * 1_000 + 60_000);
    minimumSchedule.setSeconds(0, 0);
    $('#publishScheduleInput').min = minimumSchedule.toISOString().slice(0, 16);
    renderProjectSelect(); renderTemplates(); renderBackgroundMusicOptions(); renderAccountWorkspace(); renderSupport(); renderCopyLibrary(); renderJianyingRoot();
    await restoreJianyingDirectory();
    if (projects.length) await selectProject(projects[0].id);
    else window.uiDialog.open($('#projectModal'), { initialFocus: '#newProjectName', returnFocus: $('#newProjectButton') });
    $('#healthDot').classList.add('ok'); $('#healthText').textContent = health.mode === 'local' ? '本地服务在线' : '服务在线';
  } catch (error) { $('#healthText').textContent = '服务连接失败'; toast(error.message); }
}

boot();
