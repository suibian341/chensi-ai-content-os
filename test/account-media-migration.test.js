import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('legacy project media migrates to the task owner account', async (t) => {
  const port = await freePort();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'chensi-account-media-migration-'));
  const dataDir = path.join(temp, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  const createdAt = '2026-01-01T00:00:00.000Z';
  const legacyStore = {
    schemaVersion: 2,
    users: [
      { id: 'owner-user', account: 'owner@example.com', displayName: '企业负责人', role: 'user', accountType: 'enterprise', status: 'active', pointsBalance: 0, createdAt },
      { id: 'member-user', account: 'member@example.com', displayName: '企业成员', role: 'user', accountType: 'enterprise_member', status: 'active', pointsBalance: 0, createdAt }
    ],
    projects: [{
      id: 'legacy-project', name: '旧项目', industry: '测试', purpose: '测试', ownerId: 'owner-user', organizationId: null,
      createdAt, updatedAt: createdAt,
      assets: [
        { id: 'avatar-preview', name: '形象预览.jpg', mimeType: 'image/jpeg', storageKey: 'legacy-project/avatar-preview.jpg', createdAt },
        { id: 'voice-preview', name: '音色试听.mp3', mimeType: 'audio/mpeg', storageKey: 'legacy-project/voice-preview.mp3', createdAt },
        { id: 'regular-asset', name: '项目素材.txt', mimeType: 'text/plain', storageKey: 'legacy-project/regular.txt', createdAt }
      ],
      avatars: [{ id: 'legacy-avatar', avatarId: 'legacy-avatar', name: '成员形象', previewImageAssetId: 'avatar-preview', createdAt }],
      voices: [{ id: 'legacy-voice', engineVoiceId: 'legacy-voice', name: '成员音色', previewAssetId: 'voice-preview', createdAt }]
    }],
    jobs: [
      { id: 'avatar-task', projectId: 'legacy-project', kind: 'avatar_create', userId: 'member-user', status: 'success', result: { type: 'avatar_create', avatar: { id: 'legacy-avatar', avatarId: 'legacy-avatar' } }, createdAt },
      { id: 'voice-task', projectId: 'legacy-project', kind: 'voice_clone', userId: 'member-user', status: 'success', result: { type: 'voice_clone', voice: { id: 'legacy-voice', engineVoiceId: 'legacy-voice' } }, createdAt }
    ],
    sessions: [], pointLedger: [], auditLogs: [], organizations: [], tickets: [], coupons: [],
    platformConnectionRequests: [], copyLibrary: [], idempotencyRecords: [], settings: { taskCosts: {}, projectConfig: {} }
  };
  await fs.writeFile(path.join(dataDir, 'store.json'), JSON.stringify(legacyStore, null, 2), 'utf8');
  const child = spawn(process.execPath, ['backend/server.js'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env, PORT: String(port), IP_AGENT_DATA_DIR: dataDir, IP_AGENT_STORAGE_ROOT: path.join(temp, 'storage'),
      IP_AGENT_SKIP_PROJECT_ENV: '1', IP_AGENT_CUT_DISABLED: '1', IP_AGENT_LLM_BASE_URL: '', IP_AGENT_IMAGE_BASE_URL: '',
      IP_AGENT_SKYHUMAN_API_TOKEN: '', SKYHUMAN_API_TOKEN: '', IP_AGENT_VOLCENGINE_VOICE_API_KEY: '', VOLCENGINE_TTS_API_KEY: ''
    },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  t.after(async () => { child.kill(); await fs.rm(temp, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server start timeout')), 5_000);
    child.stdout.on('data', (chunk) => { if (String(chunk).includes('running at')) { clearTimeout(timer); resolve(); } });
    child.once('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
  const migrated = JSON.parse(await fs.readFile(path.join(dataDir, 'store.json'), 'utf8'));
  const project = migrated.projects.find((item) => item.id === 'legacy-project');
  assert.equal(migrated.schemaVersion, 5);
  assert.equal(migrated.settings.taskCosts.chat, 1);
  assert.ok(project.autoEditCategories.some((item) => item.name === '产品'));
  assert.deepEqual(project.avatars, []);
  assert.deepEqual(project.voices, []);
  assert.deepEqual(project.assets.map((item) => item.id), ['regular-asset']);
  assert.equal(migrated.accountMedia.avatars[0].ownerUserId, 'member-user');
  assert.equal(migrated.accountMedia.voices[0].ownerUserId, 'member-user');
  assert.equal(migrated.accountMedia.avatars[0].sourceProjectId, 'legacy-project');
  assert.deepEqual(new Set(migrated.accountMedia.assets.map((item) => item.id)), new Set(['avatar-preview', 'voice-preview']));
  assert.ok(migrated.accountMedia.assets.every((item) => item.ownerUserId === 'member-user'));
});
