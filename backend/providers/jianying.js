import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ProviderError } from '../lib/http.js';
import { readAssetFile } from '../lib/storage.js';
import { subtitleLineGroups } from '../video-engine/common.js';
import { getProviderConfig } from './config.js';

const resultPrefix = '__CHENSI_JIANYING_RESULT__';

function bridgeError(code, message, details = null, status = 503) {
  return new ProviderError(code, message, { status, details });
}

export async function validateJianyingDraftRoot(input) {
  const candidate = String(input || '').trim();
  if (!candidate) {
    throw bridgeError('JIANYING_DRAFT_ROOT_REQUIRED', '请输入剪映草稿保存目录', null, 400);
  }
  if (!path.isAbsolute(candidate)) {
    throw bridgeError('JIANYING_DRAFT_ROOT_INVALID', '剪映草稿保存目录必须是绝对路径', null, 400);
  }
  const resolved = path.resolve(candidate);
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) throw new Error('所选路径不是文件夹');
    await fs.access(resolved, constants.R_OK | constants.W_OK);
    return resolved;
  } catch (error) {
    throw bridgeError('JIANYING_DRAFT_ROOT_INVALID', `剪映草稿目录不可用：${resolved}`, error.message, 409);
  }
}

export function selectJianyingDraftRoot(initialPath = '') {
  if (process.platform !== 'win32') {
    throw bridgeError('JIANYING_FOLDER_PICKER_UNAVAILABLE', '剪映草稿目录选择器目前只支持 Windows', null, 409);
  }
  const safeInitialPath = String(initialPath || '').replace(/'/g, "''");
  const script = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$owner = New-Object System.Windows.Forms.Form
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择剪映草稿保存文件夹'
$dialog.ShowNewFolderButton = $true
$dialog.SelectedPath = '${safeInitialPath}'
$owner.Text = '选择剪映草稿保存位置'
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedToolWindow
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0
$owner.Show()
$owner.Activate()
$owner.BringToFront()
[System.Windows.Forms.Application]::DoEvents()
$result = $dialog.ShowDialog($owner)
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::WriteLine('__CHENSI_FOLDER__' + $dialog.SelectedPath)
} else {
  [Console]::WriteLine('__CHENSI_CANCELLED__')
}
$dialog.Dispose()
$owner.Close()
$owner.Dispose()
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', encoded], {
      windowsHide: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(bridgeError('JIANYING_FOLDER_PICKER_TIMEOUT', '选择剪映草稿目录超时，请重新选择'));
    }, 10 * 60_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(bridgeError('JIANYING_FOLDER_PICKER_FAILED', '无法打开 Windows 文件夹选择器', error.message));
    });
    child.on('close', async (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stdout.includes('__CHENSI_CANCELLED__')) return resolve(null);
      const marker = '__CHENSI_FOLDER__';
      const index = stdout.lastIndexOf(marker);
      const selected = index >= 0 ? stdout.slice(index + marker.length).split(/\r?\n/, 1)[0].trim() : '';
      if (exitCode !== 0 || !selected) {
        reject(bridgeError('JIANYING_FOLDER_PICKER_FAILED', '文件夹选择器没有返回有效目录', stderr || `exit ${exitCode}`));
        return;
      }
      try {
        const stat = await fs.stat(selected);
        if (!stat.isDirectory()) throw new Error('所选路径不是文件夹');
        resolve(path.resolve(selected));
      } catch (error) {
        reject(bridgeError('JIANYING_DRAFT_ROOT_INVALID', `所选剪映草稿目录不可用：${selected}`, error.message, 409));
      }
    });
  });
}

function runBridge(payload, { allowTemporaryRoot = false } = {}) {
  const config = getProviderConfig().jianying;
  if (!config.enabled && !allowTemporaryRoot) {
    throw bridgeError('JIANYING_RUNTIME_UNAVAILABLE', '剪映草稿模块不可用，请检查 Python、草稿目录和桥接文件');
  }
  return new Promise((resolve, reject) => {
    const child = spawn(config.pythonCommand, [config.bridgePath], {
      cwd: path.dirname(config.bridgePath),
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(bridgeError('JIANYING_IMPORT_TIMEOUT', '生成剪映草稿超时，请检查素材文件和 Python 依赖'));
    }, config.timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-1_000_000); });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-100_000); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(bridgeError('JIANYING_RUNTIME_START_FAILED', '无法启动剪映草稿生成模块', error.message));
    });
    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const marker = stdout.lastIndexOf(resultPrefix);
      if (marker < 0) {
        reject(bridgeError('JIANYING_INVALID_RESPONSE', '剪映草稿模块没有返回有效结果', { exitCode, stderr: stderr.slice(-2_000) }));
        return;
      }
      try {
        const line = stdout.slice(marker + resultPrefix.length).split(/\r?\n/, 1)[0].trim();
        const result = JSON.parse(line);
        if (result.success === false) {
          reject(bridgeError(result.code || 'JIANYING_IMPORT_FAILED', result.error || '剪映草稿生成失败', result.details || null, Number(result.status) || 503));
          return;
        }
        resolve(result);
      } catch (error) {
        if (error instanceof ProviderError) reject(error);
        else reject(bridgeError('JIANYING_INVALID_RESPONSE', '剪映草稿模块返回内容无法解析', error.message));
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

function normalizedPath(value) {
  return path.resolve(String(value || '')).replace(/\\/g, '/');
}

function contentTypeForJianyingFile(filename) {
  const extension = path.extname(filename).toLowerCase();
  if (extension === '.json') return 'application/json; charset=utf-8';
  if (extension === '.mp4') return 'video/mp4';
  if (extension === '.srt') return 'application/x-subrip; charset=utf-8';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.png') return 'image/png';
  if (extension === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

async function sha256File(filename) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filename);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

async function listDraftFiles(root) {
  const files = [];
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile()) {
        const stat = await fs.stat(filename);
        files.push({
          rel: path.relative(root, filename).replace(/\\/g, '/'),
          filePath: filename,
          size: stat.size,
          sha256: await sha256File(filename),
          contentType: contentTypeForJianyingFile(filename),
          rewritePaths: path.extname(filename).toLowerCase() === '.json'
        });
      }
    }
  }
  await visit(root);
  return files.sort((left, right) => left.rel.localeCompare(right.rel));
}

async function downloadRemoteVideo(url, directory, maxBytes, timeoutMs) {
  const sourceUrl = String(url || '').trim();
  if (!/^https?:\/\//i.test(sourceUrl)) throw bridgeError('JIANYING_VIDEO_LOCAL_REQUIRED', '成片没有可读取的本地文件或远程地址', null, 409);
  const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok || !response.body) throw bridgeError('JIANYING_VIDEO_DOWNLOAD_FAILED', `下载成片失败：HTTP ${response.status}`, null, 502);
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > maxBytes) throw bridgeError('JIANYING_VIDEO_TOO_LARGE', '成片超过剪映导入大小限制', null, 413);
  const filename = path.join(directory, 'source-video.mp4');
  let received = 0;
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      received += chunk.length;
      if (received > maxBytes) callback(bridgeError('JIANYING_VIDEO_TOO_LARGE', '成片超过剪映导入大小限制', null, 413));
      else callback(null, chunk);
    }
  });
  await pipeline(Readable.fromWeb(response.body), limiter, (await fs.open(filename, 'w')).createWriteStream());
  return filename;
}

function srtTimestamp(seconds) {
  const totalMs = Math.max(0, Math.round(Number(seconds || 0) * 1_000));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1_000);
  const ms = totalMs % 1_000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function subtitleLines(value) {
  return subtitleLineGroups(value, { maxLines: 1 }).map((group) => group.join('\n'));
}

async function createFallbackSrt(text, durationSeconds, directory) {
  const lines = subtitleLines(text);
  if (!lines.length) return null;
  const duration = Math.max(Number(durationSeconds) || lines.length * 2.5, lines.length * 0.6);
  const totalWeight = lines.reduce((sum, line) => sum + Math.max(1, line.length), 0);
  let cursor = 0;
  const blocks = lines.map((line, index) => {
    const remaining = duration - cursor;
    const segmentDuration = index === lines.length - 1 ? remaining : Math.max(0.6, duration * (Math.max(1, line.length) / totalWeight));
    const end = Math.min(duration, cursor + segmentDuration);
    const block = `${index + 1}\n${srtTimestamp(cursor)} --> ${srtTimestamp(end)}\n${line}`;
    cursor = end;
    return block;
  });
  const filename = path.join(directory, 'generated-subtitles.srt');
  await fs.writeFile(filename, `${blocks.join('\n\n')}\n`, 'utf8');
  return filename;
}

function canvasSize(ratio) {
  const [width, height] = String(ratio || '').split(':').map(Number);
  if (width > 0 && height > 0) {
    if (width < height) return { width: 1080, height: Math.round(1080 * height / width) };
    return { width: Math.round(1080 * width / height), height: 1080 };
  }
  return { width: 1080, height: 1920 };
}

export async function importOutputToJianying(output, project) {
  const config = getProviderConfig().jianying;
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'chensi-jianying-'));
  const storedFiles = [];
  try {
    let videoPath;
    if (output.storageKey) {
      const storedVideo = await readAssetFile(output, { includeData: false });
      storedFiles.push(storedVideo);
      videoPath = storedVideo.filePath;
    }
    else videoPath = await downloadRemoteVideo(output.url || output.accessUrl, temporary, config.maxVideoBytes, config.downloadTimeoutMs);

    let subtitlePath = null;
    if (output.subtitleStorageKey) {
      const storedSubtitle = await readAssetFile({ storageKey: output.subtitleStorageKey }, { includeData: false });
      storedFiles.push(storedSubtitle);
      subtitlePath = storedSubtitle.filePath;
    }
    if (!subtitlePath) subtitlePath = await createFallbackSrt(output.speechScript || output.subtitleText || '', output.durationSeconds, temporary);

    const size = canvasSize(output.ratio);
    const result = await runBridge({
      action: 'import',
      draftRoot: config.draftRoot,
      indexPath: config.indexPath,
      draftName: `${project.name}-${output.title || '成片'}`,
      videoPath,
      subtitlePath,
      width: size.width,
      height: size.height,
      fps: 30,
      sourceOutputId: output.id
    });
    return {
      id: `jianying_${Date.now().toString(36)}`,
      format: 'jianying-draft-v1',
      targetEditor: '剪映专业版',
      directDraftImport: true,
      sourceOutputId: output.id,
      draftName: result.draftName,
      draftPath: result.draftPath,
      durationSeconds: result.durationSeconds,
      subtitleCount: result.subtitleCount || 0,
      indexRegistered: result.indexRegistered === true,
      indexPath: result.indexPath,
      draftRoot: config.draftRoot,
      draftRootSource: config.draftRootSource,
      editorAction: '请在剪映首页刷新草稿列表；若剪映导入前已经打开，请完全退出剪映后重新打开。',
      library: result.library,
      libraryVersion: result.libraryVersion,
      compatibility: '已生成可编辑草稿并登记到剪映索引；剪映已打开时可能需要重启客户端才能重新读取外部写入的索引。',
      createdAt: new Date().toISOString()
    };
  } finally {
    await Promise.allSettled(storedFiles.map((item) => item.cleanup()));
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}

export async function buildJianyingWebPackage(output, project, { onStage = () => {} } = {}) {
  const config = getProviderConfig().jianying;
  const packageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'chensi-jianying-web-'));
  const draftRoot = path.join(packageRoot, 'drafts');
  const sourcesRoot = path.join(packageRoot, 'sources');
  const storedFiles = [];
  let completed = false;
  try {
    await fs.mkdir(draftRoot, { recursive: true });
    await fs.mkdir(sourcesRoot, { recursive: true });
    onStage('读取成片');
    let videoPath;
    if (output.storageKey) {
      const storedVideo = await readAssetFile(output, { includeData: false });
      storedFiles.push(storedVideo);
      videoPath = storedVideo.filePath;
    } else {
      videoPath = await downloadRemoteVideo(output.url || output.accessUrl, sourcesRoot, config.maxVideoBytes, config.downloadTimeoutMs);
    }

    let subtitlePath = null;
    if (output.subtitleStorageKey) {
      const storedSubtitle = await readAssetFile({ storageKey: output.subtitleStorageKey }, { includeData: false });
      storedFiles.push(storedSubtitle);
      subtitlePath = storedSubtitle.filePath;
    }
    if (!subtitlePath) subtitlePath = await createFallbackSrt(output.speechScript || output.subtitleText || '', output.durationSeconds, sourcesRoot);

    onStage('生成剪映草稿结构');
    const size = canvasSize(output.ratio);
    const result = await runBridge({
      action: 'import',
      draftRoot,
      indexPath: path.join(draftRoot, 'root_meta_info.json'),
      draftName: `${project.name}-${output.title || '成片'}`,
      videoPath,
      subtitlePath,
      width: size.width,
      height: size.height,
      fps: Math.max(1, Math.min(120, Number(output.fps || 30))),
      sourceOutputId: output.id
    }, { allowTemporaryRoot: true });

    onStage('生成文件清单');
    const index = JSON.parse(await fs.readFile(path.join(draftRoot, 'root_meta_info.json'), 'utf8'));
    const metadata = JSON.parse(await fs.readFile(path.join(result.draftPath, 'draft_meta_info.json'), 'utf8'));
    const indexEntry = (index.all_draft_store || []).find((item) => item.draft_id === metadata.draft_id);
    if (!indexEntry) throw bridgeError('JIANYING_INDEX_ENTRY_MISSING', '生成的剪映草稿缺少索引条目', null, 500);
    const files = await listDraftFiles(result.draftPath);
    completed = true;
    return {
      packageRoot,
      draftPath: result.draftPath,
      sourcePaths: {
        root: normalizedPath(draftRoot),
        draft: normalizedPath(result.draftPath)
      },
      manifest: {
        format: 'chensi-jianying-web-v1',
        sourceOutputId: output.id,
        draftName: result.draftName,
        durationSeconds: result.durationSeconds,
        subtitleCount: result.subtitleCount || 0,
        indexEntry,
        totalBytes: files.reduce((sum, item) => sum + item.size, 0),
        files: files.map(({ filePath, ...item }) => item)
      },
      files: new Map(files.map((item) => [item.rel, item]))
    };
  } finally {
    await Promise.allSettled(storedFiles.map((item) => item.cleanup()));
    if (!completed) await fs.rm(packageRoot, { recursive: true, force: true }).catch(() => {});
  }
}
