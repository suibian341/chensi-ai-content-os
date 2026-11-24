import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { commandAvailable, detectJianyingDraftRoot } from '../backend/providers/config.js';
import { importOutputToJianying, validateJianyingDraftRoot } from '../backend/providers/jianying.js';
import { runCommand } from '../backend/providers/media.js';
import { saveAssetFile } from '../backend/lib/storage.js';

const hasRuntime = commandAvailable('ffmpeg') && spawnSync('python', ['-c', 'import pyJianYingDraft'], { windowsHide: true }).status === 0;

test('Jianying draft root validation accepts writable folders and rejects invalid paths', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'chensi-jianying-root-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  assert.equal(await validateJianyingDraftRoot(temp), path.resolve(temp));
  await assert.rejects(() => validateJianyingDraftRoot(path.join(temp, 'missing')), { code: 'JIANYING_DRAFT_ROOT_INVALID' });
  await assert.rejects(() => validateJianyingDraftRoot('relative-drafts'), { code: 'JIANYING_DRAFT_ROOT_INVALID' });
});

test('Jianying draft root follows the path configured by the desktop editor', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'chensi-jianying-config-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const customRoot = path.join(temp, 'Custom Drafts');
  const configRoot = path.join(temp, 'JianyingPro', 'User Data', 'Config');
  await fs.mkdir(customRoot, { recursive: true });
  await fs.mkdir(configRoot, { recursive: true });
  await fs.writeFile(path.join(configRoot, 'globalSetting'), `[General]\ncurrentCustomDraftPath=${customRoot.replace(/\\/g, '\\\\')}\n`, 'utf8');
  assert.equal(path.resolve(detectJianyingDraftRoot(temp)), path.resolve(customRoot));
});

test('Jianying import creates a self-contained video and subtitle draft', { skip: !hasRuntime }, async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'chensi-jianying-test-'));
  const draftRoot = path.join(temp, 'drafts');
  const storageRoot = path.join(temp, 'storage');
  await fs.mkdir(draftRoot, { recursive: true });
  const previous = {
    draftRoot: process.env.IP_AGENT_JIANYING_DRAFT_ROOT,
    storageRoot: process.env.IP_AGENT_STORAGE_ROOT
  };
  process.env.IP_AGENT_JIANYING_DRAFT_ROOT = draftRoot;
  process.env.IP_AGENT_STORAGE_ROOT = storageRoot;
  t.after(async () => {
    previous.draftRoot === undefined ? delete process.env.IP_AGENT_JIANYING_DRAFT_ROOT : process.env.IP_AGENT_JIANYING_DRAFT_ROOT = previous.draftRoot;
    previous.storageRoot === undefined ? delete process.env.IP_AGENT_STORAGE_ROOT : process.env.IP_AGENT_STORAGE_ROOT = previous.storageRoot;
    await fs.rm(temp, { recursive: true, force: true });
  });

  const source = path.join(temp, 'source.mp4');
  await runCommand('ffmpeg', [
    '-hide_banner', '-f', 'lavfi', '-i', 'color=c=black:s=320x568:d=1',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-shortest',
    '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', '-y', source
  ], { timeoutMs: 30_000 });
  const stored = await saveAssetFile({ projectId: 'jianying-project', assetId: 'output', name: 'output.mp4', data: (await fs.readFile(source)).toString('base64') });
  const result = await importOutputToJianying({
    id: 'output', title: '测试成片', status: 'ready', ratio: '9:16', durationSeconds: 1,
    storageKey: stored.storageKey, speechScript: '第一句。第二句。'
  }, { id: 'jianying-project', name: '剪映测试项目' });

  const content = JSON.parse(await fs.readFile(path.join(result.draftPath, 'draft_content.json'), 'utf8'));
  const meta = JSON.parse(await fs.readFile(path.join(result.draftPath, 'draft_meta_info.json'), 'utf8'));
  assert.equal(result.directDraftImport, true);
  assert.equal(content.tracks.filter((item) => item.type === 'video').length, 1);
  assert.equal(content.tracks.filter((item) => item.type === 'text')[0].segments.length, 2);
  assert.equal(content.materials.videos.length, 1);
  assert.equal(await fs.stat(content.materials.videos[0].path).then(() => true), true);
  assert.equal(meta.draft_name, result.draftName);
  assert.equal(meta.tm_duration, 1_000_000);
  const index = JSON.parse(await fs.readFile(path.join(draftRoot, 'root_meta_info.json'), 'utf8'));
  assert.equal(result.indexRegistered, true);
  assert.equal(index.all_draft_store.some((item) => item.draft_id === meta.draft_id), true);
  assert.equal(index.all_draft_store.find((item) => item.draft_id === meta.draft_id).draft_fold_path, result.draftPath.replace(/\\/g, '/'));

  const second = await importOutputToJianying({
    id: 'output', title: '测试成片', status: 'ready', ratio: '9:16', durationSeconds: 1,
    storageKey: stored.storageKey, speechScript: '第一句。第二句。'
  }, { id: 'jianying-project', name: '剪映测试项目' });
  const secondMeta = JSON.parse(await fs.readFile(path.join(second.draftPath, 'draft_meta_info.json'), 'utf8'));
  const updatedIndex = JSON.parse(await fs.readFile(path.join(draftRoot, 'root_meta_info.json'), 'utf8'));
  assert.notEqual(secondMeta.draft_id, meta.draft_id);
  assert.equal(updatedIndex.all_draft_store.filter((item) => [meta.draft_id, secondMeta.draft_id].includes(item.draft_id)).length, 2);
});
