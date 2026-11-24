import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
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

async function call(base, pathname, cookie, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(options.headers || {}) }
  });
  const payload = await response.json();
  return { response, payload };
}

test('AI chat charges once per successful reply and refunds failures', async (t) => {
  let providerCalls = 0;
  const provider = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw);
    const message = String(input.messages?.at(-1)?.content || '');
    providerCalls += 1;
    if (message.includes('触发失败')) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'test provider failure' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: `已回答：${message}` } }] }));
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));

  const port = await freePort();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'chensi-chat-points-'));
  const child = spawn(process.execPath, ['backend/server.js'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      PORT: String(port),
      IP_AGENT_DATA_DIR: path.join(temp, 'data'),
      IP_AGENT_STORAGE_ROOT: path.join(temp, 'storage'),
      IP_AGENT_SKIP_PROJECT_ENV: '1',
      IP_AGENT_CHAT_BASE_URL: `http://127.0.0.1:${provider.address().port}/v1`,
      IP_AGENT_CHAT_API_KEY: 'test-chat-key',
      IP_AGENT_CHAT_MODEL: 'test-chat-model'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => child.once('close', resolve));
    }
    await new Promise((resolve) => provider.close(resolve));
    await fs.rm(temp, { recursive: true, force: true });
  });

  await new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`server start timeout: ${stderr}`)), 5_000);
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.stdout.on('data', (chunk) => {
      if (!String(chunk).includes('running at')) return;
      clearTimeout(timer);
      resolve();
    });
    child.once('exit', (code) => reject(new Error(`server exited ${code}: ${stderr}`)));
  });

  const base = `http://127.0.0.1:${port}`;
  const setup = await call(base, '/api/auth/setup', '', {
    method: 'POST',
    body: JSON.stringify({ account: 'chat-admin@example.com', displayName: '对话计费测试', password: 'secure-password' })
  });
  assert.equal(setup.response.status, 201);
  const cookie = String(setup.response.headers.get('set-cookie') || '').split(';')[0];
  const userId = setup.payload.data.id;

  const catalog = await call(base, '/api/catalog', cookie);
  assert.equal(catalog.payload.data.taskCosts.chat, 5);
  const points = await call(base, `/api/admin/users/${userId}/points`, cookie, {
    method: 'POST',
    body: JSON.stringify({ delta: 10, reason: '对话计费测试入账' })
  });
  assert.equal(points.response.status, 201);
  const created = await call(base, '/api/projects', cookie, {
    method: 'POST',
    body: JSON.stringify({ name: '对话计费项目', industry: '测试', purpose: '验证' })
  });
  assert.equal(created.response.status, 201);
  const projectId = created.payload.data.id;

  const idempotencyKey = 'chat-charge-success-0001';
  const first = await call(base, `/api/projects/${projectId}/chat`, cookie, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ message: '第一次成功对话' })
  });
  assert.equal(first.response.status, 201);
  const replay = await call(base, `/api/projects/${projectId}/chat`, cookie, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ message: '第一次成功对话' })
  });
  assert.equal(replay.response.status, 201);
  assert.equal(replay.payload.data.assistantMessage.id, first.payload.data.assistantMessage.id);
  assert.equal(providerCalls, 1);

  let store = JSON.parse(await fs.readFile(path.join(temp, 'data', 'store.json'), 'utf8'));
  assert.equal(store.users.find((user) => user.id === userId).pointsBalance, 5);
  assert.equal(store.projects.find((project) => project.id === projectId).aiChat.messages.length, 2);
  assert.equal(store.pointLedger.filter((entry) => entry.type === 'operation_charge' && entry.reason === 'AI 对话扣费').length, 1);

  const failed = await call(base, `/api/projects/${projectId}/chat`, cookie, {
    method: 'POST',
    headers: { 'Idempotency-Key': 'chat-charge-failure-0001' },
    body: JSON.stringify({ message: '触发失败' })
  });
  assert.equal(failed.response.ok, false);
  store = JSON.parse(await fs.readFile(path.join(temp, 'data', 'store.json'), 'utf8'));
  assert.equal(store.users.find((user) => user.id === userId).pointsBalance, 5);
  assert.equal(store.pointLedger.filter((entry) => entry.type === 'operation_refund' && entry.reason === 'AI 对话失败退回').length, 1);

  const second = await call(base, `/api/projects/${projectId}/chat`, cookie, {
    method: 'POST',
    headers: { 'Idempotency-Key': 'chat-charge-success-0002' },
    body: JSON.stringify({ message: '第二次成功对话' })
  });
  assert.equal(second.response.status, 201);
  const insufficient = await call(base, `/api/projects/${projectId}/chat`, cookie, {
    method: 'POST',
    headers: { 'Idempotency-Key': 'chat-charge-insufficient-0001' },
    body: JSON.stringify({ message: '余额不足时不应调用模型' })
  });
  assert.equal(insufficient.response.status, 402);
  assert.equal(insufficient.payload.code, 'INSUFFICIENT_POINTS');
  assert.equal(providerCalls, 3);
});
