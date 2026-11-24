import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runCommand } from '../backend/providers/media.js';
import { saveAssetFile } from '../backend/lib/storage.js';
import {
  finishJianyingWebExport,
  jianyingWebExportFileForUser,
  jianyingWebExportForUser,
  startJianyingWebExport
} from '../backend/providers/jianying-web.js';
import { mergeJianyingIndexData, rewriteJianyingJson } from '../web/public/jianying-files.js';

const hasRuntime = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0
  && spawnSync('python', ['-c', 'import pyJianYingDraft'], { windowsHide: true }).status === 0;

test('Jianying path rewriting handles slashes and nested JSON strings', () => {
  const replacements = [
    { from: 'C:/server/drafts/old', to: 'D:/剪映草稿/新草稿' },
    { from: 'C:/server/drafts', to: 'D:/剪映草稿' }
  ];
  const source = {
    forward: 'C:/server/drafts/old/materials/video.mp4',
    backward: 'C:\\server\\drafts\\old\\materials\\video.mp4',
    nested: JSON.stringify({ path: 'C:/server/drafts/old/materials/subtitles.srt' })
  };
  const rewritten = rewriteJianyingJson(source, replacements);
  assert.equal(rewritten.forward, 'D:/剪映草稿/新草稿/materials/video.mp4');
  assert.equal(rewritten.backward, 'D:\\剪映草稿\\新草稿\\materials\\video.mp4');
  assert.equal(JSON.parse(rewritten.nested).path, 'D:/剪映草稿/新草稿/materials/subtitles.srt');
});

test('Jianying index merge preserves existing drafts and replaces duplicates', () => {
  const index = {
    root_path: 'D:/剪映草稿',
    draft_ids: 2,
    all_draft_store: [
      { draft_id: 'OLD', draft_fold_path: 'D:/剪映草稿/旧草稿' },
      { draft_id: 'NEW', draft_fold_path: 'C:/server/drafts/old' }
    ]
  };
  const updated = mergeJianyingIndexData(index, {
    draft_id: 'NEW',
    draft_fold_path: 'C:/server/drafts/old',
    draft_json_file: 'C:/server/drafts/old/draft_content.json'
  }, {
    folderName: '新草稿',
    rootPath: 'D:/剪映草稿',
    draftPath: 'D:/剪映草稿/新草稿',
    replacements: [{ from: 'C:/server/drafts/old', to: 'D:/剪映草稿/新草稿' }]
  });
  assert.equal(updated.draft_ids, 2);
  assert.deepEqual(updated.all_draft_store.map((item) => item.draft_id), ['NEW', 'OLD']);
  assert.equal(updated.all_draft_store[0].draft_json_file, 'D:/剪映草稿/新草稿/draft_content.json');
  assert.equal(index.all_draft_store[0].draft_id, 'OLD');
});

test('browser Jianying export is isolated by user and exposes a verified manifest', { skip: !hasRuntime }, async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'chensi-jianying-web-test-'));
  const previousStorageRoot = process.env.IP_AGENT_STORAGE_ROOT;
  process.env.IP_AGENT_STORAGE_ROOT = path.join(temp, 'storage');
  t.after(async () => {
    previousStorageRoot === undefined ? delete process.env.IP_AGENT_STORAGE_ROOT : process.env.IP_AGENT_STORAGE_ROOT = previousStorageRoot;
    await fs.rm(temp, { recursive: true, force: true });
  });

  const source = path.join(temp, 'source.mp4');
  await runCommand('ffmpeg', [
    '-hide_banner', '-f', 'lavfi', '-i', 'color=c=black:s=320x568:d=1',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-shortest',
    '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', '-y', source
  ], { timeoutMs: 30_000 });
  const stored = await saveAssetFile({
    projectId: 'web-project',
    assetId: 'web-output',
    name: 'output.mp4',
    data: (await fs.readFile(source)).toString('base64')
  });
  const created = startJianyingWebExport({
    userId: 'user-a',
    project: { id: 'web-project', name: '网页剪映测试' },
    output: {
      id: 'web-output', title: '测试成片', status: 'ready', ratio: '9:16', durationSeconds: 1,
      storageKey: stored.storageKey, speechScript: '第一句。第二句。'
    }
  });
  assert.equal(created.status, 'preparing');
  assert.equal(jianyingWebExportForUser(created.id, 'user-b'), null);

  let current;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    current = jianyingWebExportForUser(created.id, 'user-a');
    if (current?.status !== 'preparing') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(current?.status, 'ready', current?.error);
  assert.equal(current.manifest.format, 'chensi-jianying-web-v1');
  assert.ok(current.manifest.files.some((item) => item.rel === 'draft_content.json' && item.rewritePaths));
  assert.ok(current.manifest.files.some((item) => item.rel.startsWith('materials/') && item.size > 0 && /^[a-f0-9]{64}$/.test(item.sha256)));
  const material = current.manifest.files.find((item) => item.rel.startsWith('materials/') && item.contentType === 'video/mp4');
  const resolved = jianyingWebExportFileForUser(created.id, 'user-a', material.rel);
  assert.equal((await fs.stat(resolved.filePath)).size, material.size);
  assert.equal(jianyingWebExportFileForUser(created.id, 'user-b', material.rel), null);
  await finishJianyingWebExport(created.id, 'user-a');
  assert.equal(jianyingWebExportForUser(created.id, 'user-a'), null);
});

