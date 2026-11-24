import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { cancelPublishingConnectionTasksForPlatform, cancelPublishingConnectionTasksForUser, clearPublishingPlatform, publishVideoToPlatforms, publishingConnectionTask, publishingStatus, startPublishingConnectionTask, submitPublishingConnectionInteraction, submitPublishingConnectionVerification } from '../backend/providers/platform-publish.js';

test('embedded platform publisher maps login state and preserves per-platform results', async (t) => {
  const names = [
    'IP_AGENT_STORAGE_ROOT',
    'IP_AGENT_PROVIDER_SETTINGS_FILE',
    'IP_AGENT_PUBLISH_BRIDGE_PATH',
    'IP_AGENT_PUBLISH_PYTHON_COMMAND',
    'IP_AGENT_PUBLISH_SESSION_ROOT',
    'IP_AGENT_PUBLISH_TEST_CAPTURE',
    'IP_AGENT_PUBLISH_TEST_SCOPE_CAPTURE',
    'IP_AGENT_PUBLISH_TEST_INTERACTION',
    'IP_AGENT_PUBLISH_TEST_INTERACTION_CAPTURE',
    'IP_AGENT_PUBLISH_TEST_VERIFICATION',
    'IP_AGENT_PUBLISH_TEST_VERIFICATION_CAPTURE'
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'chensi-platform-publish-'));
  const videoPath = path.join(temp, 'generated.mp4');
  const bridgePath = path.join(temp, 'mock-bridge.py');
  const capturePath = path.join(temp, 'capture.json');
  const scopeCapturePath = path.join(temp, 'scope-capture.jsonl');
  const verificationCapturePath = path.join(temp, 'verification-capture.json');
  const interactionCapturePath = path.join(temp, 'interaction-capture.json');
  await fs.writeFile(videoPath, Buffer.from('real-video-bytes'));
  await fs.writeFile(bridgePath, `
import json, os, sys, time
payload = json.loads(sys.stdin.read() or '{}')
if payload.get('action') == 'status':
    result = {'success': True, 'dependencies': {'biliup': True}, 'platforms_status': {
        'douyin': {'logged_in': True, 'message': '已登录'},
        'xiaohongshu': {'logged_in': True, 'message': '已登录'},
        'tencent': {'logged_in': False, 'message': '未登录'}
    }}
elif payload.get('action') == 'connect':
    with open(os.environ['IP_AGENT_PUBLISH_TEST_SCOPE_CAPTURE'], 'a', encoding='utf-8') as capture:
        capture.write(json.dumps({
            'session_root': os.environ.get('IP_AGENT_PUBLISH_SESSION_ROOT'),
            'profile_root': os.environ.get('IP_AGENT_PUBLISH_BROWSER_PROFILE_ROOT'),
        }) + '\\n')
    if os.environ.get('IP_AGENT_PUBLISH_TEST_VERIFICATION') == '1':
        print('__CHENSI_PUBLISH_EVENT__' + json.dumps({
            'type': 'verification',
            'methods': [],
            'selectedMethod': '',
            'stage': 'method_required',
            'canResend': False,
            'message': '检测到身份验证，正在读取可用验证方式'
        }), flush=True)
        time.sleep(0.03)
        print('__CHENSI_PUBLISH_EVENT__' + json.dumps({
            'type': 'verification',
            'methods': [{'id': 'sms'}, {'id': 'face'}],
            'selectedMethod': 'sms',
            'stage': 'code_required',
            'canResend': True,
            'phoneHint': '138****1234',
            'message': '验证码已发送'
        }), flush=True)
        control_dir = os.environ['IP_AGENT_PUBLISH_CONTROL_DIR']
        deadline = time.time() + 3
        command = None
        while time.time() < deadline and command is None:
            if os.path.isdir(control_dir):
                files = [name for name in os.listdir(control_dir) if name.startswith('verification-command-')]
                if files:
                    with open(os.path.join(control_dir, files[0]), encoding='utf-8') as source:
                        command = json.load(source)
                    break
            time.sleep(0.02)
        with open(os.environ['IP_AGENT_PUBLISH_TEST_VERIFICATION_CAPTURE'], 'w', encoding='utf-8') as capture:
            json.dump(command, capture)
    elif os.environ.get('IP_AGENT_PUBLISH_TEST_INTERACTION') == '1':
        print('__CHENSI_PUBLISH_EVENT__' + json.dumps({'type': 'qrcode', 'imageDataUrl': 'data:image/png;base64,aGVsbG8='}), flush=True)
        control_dir = os.environ['IP_AGENT_PUBLISH_CONTROL_DIR']
        deadline = time.time() + 3
        opened = False
        interaction = None
        while time.time() < deadline and interaction is None:
            if os.path.isdir(control_dir):
                files = sorted(name for name in os.listdir(control_dir) if name.startswith('browser-command-'))
                for name in files:
                    command_path = os.path.join(control_dir, name)
                    with open(command_path, encoding='utf-8') as source:
                        command = json.load(source)
                    os.remove(command_path)
                    if command.get('action') == 'open_browser':
                        opened = True
                        print('__CHENSI_PUBLISH_EVENT__' + json.dumps({
                            'type': 'browser_frame',
                            'imageDataUrl': 'data:image/jpeg;base64,aGVsbG8=',
                            'width': 1280,
                            'height': 720,
                            'title': '平台登录',
                            'url': 'https://example.test/login',
                            'sequence': 1
                        }), flush=True)
                    elif opened:
                        interaction = command
                        break
            time.sleep(0.02)
        with open(os.environ['IP_AGENT_PUBLISH_TEST_INTERACTION_CAPTURE'], 'w', encoding='utf-8') as capture:
            json.dump(interaction, capture)
    else:
        print('__CHENSI_PUBLISH_EVENT__' + json.dumps({'type': 'qrcode', 'imageDataUrl': 'data:image/png;base64,aGVsbG8='}), flush=True)
        time.sleep(0.15)
    result = {'success': True, 'message': '扫码授权成功'}
elif payload.get('action') == 'publish':
    open(os.environ['IP_AGENT_PUBLISH_TEST_CAPTURE'], 'w', encoding='utf-8').write(json.dumps(payload, ensure_ascii=False))
    result = {'success': True, 'message': '成功发布 1/2 个平台', 'results': {
        'douyin': {'success': True, 'message': '抖音发布成功'},
        'xiaohongshu': {'success': False, 'error': '需要人工确认发布按钮'}
    }}
else:
    result = {'success': True, 'logged_in': True, 'message': 'ok'}
print('__CHENSI_PUBLISH_RESULT__' + json.dumps(result, ensure_ascii=False))
`, 'utf8');
  process.env.IP_AGENT_STORAGE_ROOT = temp;
  process.env.IP_AGENT_PROVIDER_SETTINGS_FILE = path.join(temp, 'provider-settings.json');
  process.env.IP_AGENT_PUBLISH_BRIDGE_PATH = bridgePath;
  process.env.IP_AGENT_PUBLISH_PYTHON_COMMAND = 'python';
  process.env.IP_AGENT_PUBLISH_SESSION_ROOT = path.join(temp, 'sessions');
  process.env.IP_AGENT_PUBLISH_TEST_CAPTURE = capturePath;
  process.env.IP_AGENT_PUBLISH_TEST_SCOPE_CAPTURE = scopeCapturePath;
  process.env.IP_AGENT_PUBLISH_TEST_INTERACTION_CAPTURE = interactionCapturePath;
  process.env.IP_AGENT_PUBLISH_TEST_VERIFICATION_CAPTURE = verificationCapturePath;
  t.after(async () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await fs.rm(temp, { recursive: true, force: true });
  });

  const status = await publishingStatus({ userId: 'user-a' });
  assert.equal(status.find((item) => item.id === 'douyin').loggedIn, true);
  assert.equal(status.find((item) => item.id === 'tencent').loggedIn, false);

  const connectedTasks = [];
  const authTask = await startPublishingConnectionTask('抖音', {
    userId: 'remote-user',
    onConnected: async (task) => { connectedTasks.push(task); }
  });
  let authCurrent = authTask;
  for (let attempt = 0; attempt < 40 && authCurrent.status === 'preparing'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    authCurrent = publishingConnectionTask(authTask.id, { userId: 'remote-user' });
  }
  assert.equal(authCurrent.status, 'waiting_scan');
  assert.match(authCurrent.qrCode, /^data:image\/png;base64,/);
  for (let attempt = 0; attempt < 40 && authCurrent.status !== 'connected'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    authCurrent = publishingConnectionTask(authTask.id, { userId: 'remote-user' });
  }
  assert.equal(authCurrent.status, 'connected');
  assert.equal(authCurrent.qrCode, null);
  assert.equal(publishingConnectionTask(authTask.id, { userId: 'other-user' }), null);
  for (let attempt = 0; attempt < 20 && !connectedTasks.length; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(connectedTasks[0]?.id, authTask.id);

  const secondAuthTask = await startPublishingConnectionTask('抖音', { userId: 'second-remote-user' });
  let secondAuthCurrent = secondAuthTask;
  for (let attempt = 0; attempt < 40 && secondAuthCurrent.status !== 'connected'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    secondAuthCurrent = publishingConnectionTask(secondAuthTask.id, { userId: 'second-remote-user' });
  }
  assert.equal(secondAuthCurrent.status, 'connected');
  const scopes = (await fs.readFile(scopeCapturePath, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(scopes.length, 2);
  assert.notEqual(scopes[0].session_root, scopes[1].session_root);
  assert.equal(path.dirname(scopes[0].profile_root), scopes[0].session_root);
  assert.equal(path.dirname(scopes[1].profile_root), scopes[1].session_root);

  const persistentProfile = path.join(scopes[0].profile_root, 'douyin_publish');
  await fs.mkdir(persistentProfile, { recursive: true });
  await fs.writeFile(path.join(persistentProfile, 'Cookies'), 'server-side-session');
  const cleared = await clearPublishingPlatform('抖音', { userId: 'remote-user' });
  assert.equal(cleared.loggedIn, false);
  assert.equal(cleared.profileCleared, true);
  assert.equal(publishingConnectionTask(authTask.id, { userId: 'remote-user' }).status, 'cancelled');
  await assert.rejects(() => fs.access(persistentProfile), (error) => error.code === 'ENOENT');

  process.env.IP_AGENT_PUBLISH_TEST_VERIFICATION = '1';
  const verificationTask = await startPublishingConnectionTask('抖音', { userId: 'verification-user' });
  let verificationCurrent = verificationTask;
  for (let attempt = 0; attempt < 80 && verificationCurrent.verification?.selectedMethod !== 'sms'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    verificationCurrent = publishingConnectionTask(verificationTask.id, { userId: 'verification-user' });
  }
  assert.equal(verificationCurrent.status, 'waiting_verification');
  assert.equal(verificationCurrent.verification.selectedMethod, 'sms');
  assert.deepEqual(verificationCurrent.verification.methods.map((item) => item.id), ['sms', 'face']);
  assert.equal(await submitPublishingConnectionVerification(verificationTask.id, { code: '123456' }, { userId: 'other-user' }), null);
  verificationCurrent = await submitPublishingConnectionVerification(verificationTask.id, { code: '123456' }, { userId: 'verification-user' });
  assert.equal(verificationCurrent.status, 'waiting_confirm');
  for (let attempt = 0; attempt < 80 && verificationCurrent.status !== 'connected'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    verificationCurrent = publishingConnectionTask(verificationTask.id, { userId: 'verification-user' });
  }
  assert.equal(verificationCurrent.status, 'connected');
  assert.equal(verificationCurrent.verification, null);
  assert.equal(verificationCurrent.remoteBrowser, null);
  const verificationCommand = JSON.parse(await fs.readFile(verificationCapturePath, 'utf8'));
  assert.equal(verificationCommand.action, 'submit_code');
  assert.equal(verificationCommand.code, '123456');
  delete process.env.IP_AGENT_PUBLISH_TEST_VERIFICATION;

  process.env.IP_AGENT_PUBLISH_TEST_INTERACTION = '1';
  const interactionTask = await startPublishingConnectionTask('小红书', { userId: 'interaction-user' });
  let interactionCurrent = interactionTask;
  for (let attempt = 0; attempt < 60 && interactionCurrent.status === 'preparing'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    interactionCurrent = publishingConnectionTask(interactionTask.id, { userId: 'interaction-user' });
  }
  assert.equal(interactionCurrent.status, 'waiting_scan');
  assert.equal(await submitPublishingConnectionInteraction(interactionTask.id, { action: 'open_browser' }, { userId: 'other-user' }), null);
  await submitPublishingConnectionInteraction(interactionTask.id, { action: 'open_browser' }, { userId: 'interaction-user' });
  for (let attempt = 0; attempt < 80 && !interactionCurrent.remoteBrowser?.active; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    interactionCurrent = publishingConnectionTask(interactionTask.id, { userId: 'interaction-user' });
  }
  assert.equal(interactionCurrent.status, 'waiting_interaction');
  assert.match(interactionCurrent.remoteBrowser.frameDataUrl, /^data:image\/jpeg;base64,/);
  assert.equal(interactionCurrent.remoteBrowser.width, 1280);
  await submitPublishingConnectionInteraction(interactionTask.id, { action: 'click', x: 320, y: 240 }, { userId: 'interaction-user' });
  for (let attempt = 0; attempt < 80 && interactionCurrent.status !== 'connected'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    interactionCurrent = publishingConnectionTask(interactionTask.id, { userId: 'interaction-user' });
  }
  assert.equal(interactionCurrent.status, 'connected');
  assert.equal(interactionCurrent.remoteBrowser, null);
  const interactionCommand = JSON.parse(await fs.readFile(interactionCapturePath, 'utf8'));
  assert.equal(interactionCommand.action, 'click');
  assert.equal(interactionCommand.x, 320);
  assert.equal(interactionCommand.y, 240);
  delete process.env.IP_AGENT_PUBLISH_TEST_INTERACTION;

  let cancelledCallbackCount = 0;
  const cancelledPlatformTask = await startPublishingConnectionTask('抖音', {
    userId: 'cancelled-platform-user',
    onConnected: () => { cancelledCallbackCount += 1; }
  });
  const unaffectedTask = await startPublishingConnectionTask('抖音', { userId: 'unaffected-platform-user' });
  const cancelledPlatformTasks = cancelPublishingConnectionTasksForPlatform('抖音', { userId: 'cancelled-platform-user' });
  assert.equal(cancelledPlatformTasks.length, 1);
  assert.equal(cancelledPlatformTasks[0].id, cancelledPlatformTask.id);
  assert.equal(publishingConnectionTask(cancelledPlatformTask.id, { userId: 'cancelled-platform-user' }).status, 'cancelled');
  assert.notEqual(publishingConnectionTask(unaffectedTask.id, { userId: 'unaffected-platform-user' }).status, 'cancelled');
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(cancelledCallbackCount, 0);
  assert.notEqual(publishingConnectionTask(cancelledPlatformTask.id, { userId: 'unaffected-platform-user' }), publishingConnectionTask(cancelledPlatformTask.id, { userId: 'cancelled-platform-user' }));
  const cancelledUserTasks = cancelPublishingConnectionTasksForUser({ userId: 'unaffected-platform-user' });
  assert.ok(cancelledUserTasks.length <= 1);

  const project = {
    copy: { publishTitle: '真实发布标题', tags: ['新品'] },
    assets: [],
    outputs: [{ id: 'output-1', status: 'ready', title: '真实成片', storageKey: 'generated.mp4' }]
  };
  const result = await publishVideoToPlatforms({
    sourceOutputId: 'output-1',
    platforms: ['抖音', '小红书'],
    title: '春季新品介绍',
    tags: ['新品', '护肤'],
    mode: 'immediate'
  }, project, { userId: 'user-a' });

  const uploadBody = JSON.parse(await fs.readFile(capturePath, 'utf8'));
  assert.equal(uploadBody.video_path, videoPath);
  assert.deepEqual(uploadBody.platforms, ['douyin', 'xiaohongshu']);
  assert.equal(result.provider, 'embedded-browser-automation');
  assert.equal(result.output.status, 'partial');
  assert.equal(result.output.successCount, 1);
  assert.equal(result.output.results[1].status, 'waiting_user_action');
});

test('platform publish adapter rejects unsupported draft mode', async () => {
  await assert.rejects(
    () => publishVideoToPlatforms({ sourceOutputId: 'output-1', platforms: ['B站'], title: '测试', mode: 'draft' }, { outputs: [{ id: 'output-1', status: 'ready', storageKey: 'unused.mp4' }], assets: [] }),
    (error) => error.code === 'PUBLISH_DRAFT_UNSUPPORTED'
  );
});
