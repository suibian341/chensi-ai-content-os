import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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

function runTestCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(stderr || `${command} exited ${code}`)));
  });
}

let authCookie = '';

async function api(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, { ...options, headers: { 'Content-Type': 'application/json', ...(authCookie ? { Cookie: authCookie } : {}), ...(options.headers || {}) } });
  const payload = await response.json();
  assert.equal(response.ok, true, payload.error);
  return payload.data;
}

async function apiResponse(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, { ...options, headers: { 'Content-Type': 'application/json', ...(authCookie ? { Cookie: authCookie } : {}), ...(options.headers || {}) } });
  return { response, payload: await response.json() };
}

test('existing HTTP contract works with integrated providers', async (t) => {
  const port = await freePort();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'domestic-ip-server-'));
  const backendApiKey = 'chensi_test_server_integration_key';
  const child = spawn(process.execPath, ['backend/server.js'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      PORT: String(port),
      IP_AGENT_DATA_DIR: path.join(temp, 'data'),
      IP_AGENT_STORAGE_ROOT: path.join(temp, 'storage'),
      IP_AGENT_BACKEND_API_KEY_SHA256: createHash('sha256').update(backendApiKey).digest('hex'),
      IP_AGENT_CUT_DISABLED: '1',
      IP_AGENT_LLM_BASE_URL: '',
      IP_AGENT_LLM_MODEL: '',
      IP_AGENT_IMAGE_BASE_URL: '',
      IP_AGENT_IMAGE_API_KEY: '',
      IP_AGENT_IMAGE_MODEL: '',
      IP_AGENT_SKIP_PROJECT_ENV: '1',
      IP_AGENT_VOLCENGINE_VOICE_API_KEY: '',
      VOLCENGINE_TTS_API_KEY: '',
      IP_AGENT_SKYHUMAN_API_TOKEN: '',
      SKYHUMAN_API_TOKEN: '',
      VOLCENGINE_ARK_BASE_URL: '',
      VOLCENGINE_ARK_API_KEY: '',
      VOLCENGINE_ARK_MODEL: ''
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  t.after(async () => {
    child.kill();
    await fs.rm(temp, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server start timeout')), 5_000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('running at')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => reject(new Error(`server exited ${code}`)));
  });

  const base = `http://127.0.0.1:${port}`;
  const health = await api(base, '/api/health');
  assert.ok(health.providers.some((item) => item.id === 'semantic-search' && item.state === 'ready'));
  assert.ok(health.providers.some((item) => item.id === 'llm' && item.state === 'needs_config'));
  const versionedHealth = await api(base, '/api/v1/health');
  assert.equal(versionedHealth.service, 'chensi-ai-content-os');
  const securityResponse = await fetch(`${base}/api/v1/health`);
  assert.equal(securityResponse.headers.get('x-frame-options'), 'DENY');
  assert.equal(securityResponse.headers.get('x-content-type-options'), 'nosniff');
  assert.match(securityResponse.headers.get('strict-transport-security'), /max-age=/);
  const corsResponse = await fetch(`${base}/api/v1/health`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:4273', 'Access-Control-Request-Method': 'GET' } });
  assert.equal(corsResponse.status, 204);
  assert.equal(corsResponse.headers.get('access-control-allow-origin'), 'http://localhost:4273');
  assert.equal(corsResponse.headers.get('access-control-allow-credentials'), 'true');
  assert.match(corsResponse.headers.get('access-control-allow-headers'), /X-API-Key/i);
  const deniedOrigin = await fetch(`${base}/api/v1/health`, { headers: { Origin: 'https://not-allowed.example' } });
  assert.equal(deniedOrigin.status, 403);

  const setupResponse = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: 'admin@example.com', displayName: '测试管理员', password: 'secure-password' }) });
  assert.equal(setupResponse.status, 201);
  const setupPayload = await setupResponse.json();
  const adminToken = setupPayload.data.accessToken;
  assert.ok(adminToken);
  authCookie = String(setupResponse.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(authCookie.startsWith('ipos_session='));
  const cookieStatus = await api(base, '/api/platform-media/cookie-status');
  assert.ok(['valid', 'browser', 'refreshing', 'invalid', 'locked', 'unconfigured'].includes(cookieStatus.status));
  assert.equal(cookieStatus.state, cookieStatus.status);
  assert.equal(cookieStatus.canRefresh, true);
  assert.equal(typeof cookieStatus.message, 'string');
  assert.equal(Object.hasOwn(cookieStatus, 'content'), false);
  const tikhubVideoStatus = await api(base, '/api/platform-media/status');
  assert.equal(Object.hasOwn(tikhubVideoStatus, 'provider'), false);
  assert.ok(['configured', 'unconfigured'].includes(tikhubVideoStatus.status));
  assert.equal(typeof tikhubVideoStatus.configured, 'boolean');
  const unsupportedCookieBrowser = await apiResponse(base, '/api/admin/platform-media/cookie-refresh', { method: 'POST', body: JSON.stringify({ browser: 'safari' }) });
  assert.equal(unsupportedCookieBrowser.response.status, 400);
  assert.equal(unsupportedCookieBrowser.payload.code, 'PLATFORM_COOKIE_BROWSER_UNSUPPORTED');
  const bearerMeResponse = await fetch(`${base}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(bearerMeResponse.status, 200);
  assert.equal((await bearerMeResponse.json()).data.account, 'admin@example.com');
  const apiKeyMeResponse = await fetch(`${base}/api/v1/auth/me`, { headers: { 'X-API-Key': backendApiKey } });
  assert.equal(apiKeyMeResponse.status, 200);
  assert.equal((await apiKeyMeResponse.json()).data.account, 'admin@example.com');
  const apiKeyBearerResponse = await fetch(`${base}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${backendApiKey}` } });
  assert.equal(apiKeyBearerResponse.status, 200);
  const invalidApiKeyResponse = await fetch(`${base}/api/v1/auth/me`, { headers: { 'X-API-Key': `${backendApiKey}-invalid` } });
  assert.equal(invalidApiKeyResponse.status, 401);
  const adminMe = await api(base, '/api/auth/me');
  assert.equal(adminMe.accountType, 'personal');
  const persistedAfterSetup = JSON.parse(await fs.readFile(path.join(temp, 'data', 'store.json'), 'utf8'));
  persistedAfterSetup.organizations.push({
    id: 'legacy-admin-organization', name: '管理员历史企业空间', ownerId: setupPayload.data.id,
    seatLimit: 5, pointsBalance: 0, pointsUsed: 0, computeUsed: 0,
    members: [{ userId: setupPayload.data.id, role: 'owner', permissions: ['创作', '素材', '发布', '管理'], computeQuota: 0, computeUsed: 0, joinedAt: new Date().toISOString() }],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  });
  await fs.writeFile(path.join(temp, 'data', 'store.json'), JSON.stringify(persistedAfterSetup, null, 2), 'utf8');
  assert.equal(await api(base, '/api/account/organization'), null);
  assert.equal((await api(base, '/api/admin/organizations')).some((item) => item.ownerId === setupPayload.data.id), false);
  const adminOrganizationDenied = await apiResponse(base, '/api/account/organization', { method: 'POST', body: JSON.stringify({ name: '管理员不应创建企业空间' }) });
  assert.equal(adminOrganizationDenied.response.status, 403);
  assert.equal(adminOrganizationDenied.payload.code, 'PERSONAL_TEAM_DISABLED');

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const deniedLogin = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: 'blocked@example.com', password: 'wrong-password' }) });
    assert.equal(deniedLogin.status, 401);
  }
  const limitedLogin = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: 'blocked@example.com', password: 'wrong-password' }) });
  assert.equal(limitedLogin.status, 429);
  assert.equal((await limitedLogin.json()).code, 'LOGIN_RATE_LIMITED');
  assert.ok(Number(limitedLogin.headers.get('retry-after')) > 0);

  const catalog = await api(base, '/api/catalog');
  assert.equal(catalog.taskCosts.chat, 5);
  assert.equal(catalog.requirements.length, 33);
  assert.ok(catalog.requirements.some((item) => item.id === 'ip_slots' && item.status === 'ready'));
  assert.ok(catalog.requirements.some((item) => item.id === 'coupons' && item.status === 'ready'));
  const dashboard = await api(base, '/api/admin/dashboard');
  assert.equal(dashboard.requirements.length, 33);
  assert.ok(dashboard.requirements.some((item) => item.id === 'languages' && item.status === 'unavailable'));
  assert.ok(dashboard.requirements.some((item) => item.id === 'asset_upload' && item.status === 'ready'));
  assert.deepEqual(dashboard.platforms.map((item) => item.name), ['抖音', '视频号', '小红书', '快手', 'B站', '百家号']);
  assert.ok(dashboard.platforms.every((item) => item.totalPublishes === 0 && item.connectedAccounts === 0));
  const settings = await api(base, '/api/admin/settings');
  assert.equal(JSON.stringify(settings).includes('a44b7b44-ba53-46e4-a9bc-28ed04e44330'), false);
  assert.equal(settings.projectConfig.couponPackages.length, 3);
  assert.equal(settings.projectConfig.copyCheck.originalityThreshold, 65);
  assert.equal(settings.projectConfig.speechLanguages.find((item) => item.id === 'zh-CN').enabled, true);
  const commissionConfig = await api(base, '/api/admin/settings/project', {
    method: 'PUT',
    body: JSON.stringify({
      computeCommissionMode: 'by_payment',
      firstLevelCommissionRate: 18,
      secondLevelCommissionRate: 7,
      agentLevels: ['城市合伙人', '推广伙伴'],
      couponPackages: [{ id: 'test_package', name: '测试套餐', priceYuan: 128.5, points: 2000, enabled: true }],
      copyCheck: {
        originalityThreshold: 72,
        repeatedPhraseMinLength: 10,
        rules: [{ id: 'custom_claim', category: '自定义承诺', terms: ['当天见效'], suggestion: '改为真实周期', enabled: true }]
      },
      speechLanguages: settings.projectConfig.speechLanguages
    })
  });
  assert.equal(commissionConfig.firstLevelCommissionRate, 18);
  assert.equal(commissionConfig.couponPackages[0].priceYuan, 128.5);
  assert.equal(commissionConfig.copyCheck.originalityThreshold, 72);
  assert.equal(commissionConfig.copyCheck.rules[0].terms[0], '当天见效');
  const invalidSlots = await apiResponse(base, '/api/admin/settings/project', { method: 'PUT', body: JSON.stringify({ personalIpSlots: 0 }) });
  assert.equal(invalidSlots.response.status, 400);
  assert.match(invalidSlots.payload.error, /正整数/);
  assert.equal(invalidSlots.payload.message, invalidSlots.payload.error);
  assert.equal(invalidSlots.payload.retryable, false);
  assert.match(invalidSlots.payload.requestId, /^req_/);
  assert.equal(invalidSlots.response.headers.get('x-request-id'), invalidSlots.payload.requestId);
  const configuredCoupon = await api(base, '/api/admin/coupons', {
    method: 'POST',
    body: JSON.stringify({ code: 'TEST-PACK-001', packageId: 'test_package', maxRedemptions: 2 })
  });
  assert.equal(configuredCoupon.packageName, '测试套餐');
  assert.equal(configuredCoupon.priceYuan, 128.5);
  assert.equal(configuredCoupon.points, 2000);

  const pointsIdempotencyKey = 'test-admin-points-20260824';
  const adjustedOnce = await api(base, `/api/admin/users/${setupPayload.data.id}/points`, {
    method: 'POST',
    headers: { 'Idempotency-Key': pointsIdempotencyKey },
    body: JSON.stringify({ delta: 100, reason: '幂等测试入账' })
  });
  const adjustedAgain = await api(base, `/api/admin/users/${setupPayload.data.id}/points`, {
    method: 'POST',
    headers: { 'Idempotency-Key': pointsIdempotencyKey },
    body: JSON.stringify({ delta: 100, reason: '幂等测试入账' })
  });
  assert.equal(adjustedAgain.entry.id, adjustedOnce.entry.id);
  assert.equal(adjustedAgain.user.pointsBalance, 100);

  const redeemKey = 'test-coupon-redeem-20260824';
  const redeemedOnce = await api(base, '/api/account/redeem', {
    method: 'POST',
    headers: { 'Idempotency-Key': redeemKey },
    body: JSON.stringify({ code: configuredCoupon.code })
  });
  const redeemedAgain = await api(base, '/api/account/redeem', {
    method: 'POST',
    headers: { 'Idempotency-Key': redeemKey },
    body: JSON.stringify({ code: configuredCoupon.code })
  });
  assert.equal(redeemedAgain.entry.id, redeemedOnce.entry.id);
  assert.equal(redeemedAgain.balance, redeemedOnce.balance);

  const personalUser = await api(base, '/api/admin/users', { method: 'POST', body: JSON.stringify({ account: 'personal@example.com', displayName: '个人测试用户', password: 'personal-password', accountType: 'personal' }) });
  const personalLogin = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: personalUser.account, password: 'personal-password' }) });
  const personalToken = (await personalLogin.json()).data.accessToken;
  assert.equal(await api(base, '/api/account/organization', { headers: { Authorization: `Bearer ${personalToken}` } }), null);
  const personalOrganizationDenied = await apiResponse(base, '/api/account/organization', { method: 'POST', headers: { Authorization: `Bearer ${personalToken}` }, body: JSON.stringify({ name: '不应创建的个人空间' }) });
  assert.equal(personalOrganizationDenied.response.status, 403);
  assert.equal(personalOrganizationDenied.payload.code, 'PERSONAL_TEAM_DISABLED');
  const personalProject = await api(base, '/api/projects', { method: 'POST', headers: { Authorization: `Bearer ${personalToken}` }, body: JSON.stringify({ name: '账号切换项目', industry: '测试', purpose: '验证空间迁移' }) });
  assert.equal(personalProject.organizationId, null);
  const convertedEnterpriseUser = await api(base, `/api/admin/users/${personalUser.id}`, { method: 'PATCH', body: JSON.stringify({ accountType: 'enterprise' }) });
  assert.equal(convertedEnterpriseUser.accountType, 'enterprise');
  const convertedOrganization = await api(base, '/api/account/organization', { headers: { Authorization: `Bearer ${personalToken}` } });
  assert.equal(convertedOrganization.ownerId, personalUser.id);
  assert.equal((await api(base, '/api/projects', { headers: { Authorization: `Bearer ${personalToken}` } })).find((item) => item.id === personalProject.id).organizationId, convertedOrganization.id);
  const convertedPersonalUser = await api(base, `/api/admin/users/${personalUser.id}`, { method: 'PATCH', body: JSON.stringify({ accountType: 'personal' }) });
  assert.equal(convertedPersonalUser.accountType, 'personal');
  assert.equal(await api(base, '/api/account/organization', { headers: { Authorization: `Bearer ${personalToken}` } }), null);
  assert.equal((await api(base, '/api/projects', { headers: { Authorization: `Bearer ${personalToken}` } })).find((item) => item.id === personalProject.id).organizationId, null);

  const primaryEnterprise = await api(base, '/api/admin/users', { method: 'POST', body: JSON.stringify({ account: 'primary-agent@example.com', displayName: '一级测试代理', password: 'agent-password', accountType: 'enterprise' }) });
  const primaryAgent = await api(base, `/api/admin/users/${primaryEnterprise.id}`, { method: 'PATCH', body: JSON.stringify({ role: 'agent' }) });
  assert.equal(primaryAgent.accountType, 'enterprise');
  const secondaryEnterprise = await api(base, '/api/admin/users', { method: 'POST', body: JSON.stringify({ account: 'secondary-agent@example.com', displayName: '二级测试代理', password: 'agent-password', accountType: 'enterprise' }) });
  const secondaryAgent = await api(base, `/api/admin/users/${secondaryEnterprise.id}`, { method: 'PATCH', body: JSON.stringify({ role: 'agent', parentAgentId: primaryAgent.id }) });
  assert.equal(secondaryAgent.parentAgentId, primaryAgent.id);

  const enterpriseLogin = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: secondaryAgent.account, password: 'agent-password' }) });
  const enterpriseToken = (await enterpriseLogin.json()).data.accessToken;
  const organization = await api(base, '/api/account/organization', { headers: { Authorization: `Bearer ${enterpriseToken}` } });
  assert.equal(organization.members.length, 1);
  assert.equal(organization.ownerId, secondaryAgent.id);
  const persistedWithEnterprises = JSON.parse(await fs.readFile(path.join(temp, 'data', 'store.json'), 'utf8'));
  const primaryOrganizationRecord = persistedWithEnterprises.organizations.find((item) => item.ownerId === primaryAgent.id);
  primaryOrganizationRecord.members.push({ userId: secondaryAgent.id, role: 'member', permissions: ['创作'], computeQuota: 10, computeUsed: 0, joinedAt: new Date().toISOString() });
  await fs.writeFile(path.join(temp, 'data', 'store.json'), JSON.stringify(persistedWithEnterprises, null, 2), 'utf8');
  assert.equal((await api(base, '/api/account/organization', { headers: { Authorization: `Bearer ${enterpriseToken}` } })).id, organization.id);
  assert.equal((await api(base, '/api/admin/organizations')).find((item) => item.id === primaryOrganizationRecord.id).members.some((item) => item.userId === secondaryAgent.id), false);
  const adjustedEnterprise = await api(base, `/api/admin/users/${secondaryAgent.id}/points`, { method: 'POST', body: JSON.stringify({ delta: 100, reason: '企业测试入账' }) });
  assert.equal(adjustedEnterprise.pointsAccount.accountType, 'organization');
  assert.equal(adjustedEnterprise.pointsAccount.balance, 100);
  const organizationWithMember = await api(base, '/api/account/organization/members', { method: 'POST', headers: { Authorization: `Bearer ${enterpriseToken}` }, body: JSON.stringify({ account: 'member@example.com', displayName: '素材成员', password: 'member-password', permissions: ['素材'], computeQuota: 10 }) });
  const memberUser = organizationWithMember.members.find((item) => item.role === 'member').user;
  assert.equal(memberUser.accountType, 'enterprise_member');
  assert.equal(memberUser.parentAgentId, secondaryAgent.id);
  assert.deepEqual(organizationWithMember.members.find((item) => item.userId === memberUser.id).permissions, ['素材']);
  const adminMemberLimitDenied = await apiResponse(base, `/api/admin/users/${memberUser.id}/points`, { method: 'POST', body: JSON.stringify({ delta: 5, reason: '管理员不应调整成员上限' }) });
  assert.equal(adminMemberLimitDenied.response.status, 403);
  assert.equal(adminMemberLimitDenied.payload.code, 'ENTERPRISE_MEMBER_POINTS_OWNER_MANAGED');
  assert.equal(organizationWithMember.members.find((item) => item.userId === memberUser.id).computeQuota, 10);

  const project = await api(base, '/api/projects', { method: 'POST', headers: { Authorization: `Bearer ${enterpriseToken}` }, body: JSON.stringify({ name: '接口测试', industry: '制造业', purpose: '获客' }) });
  assert.equal(project.organizationId, organization.id);
  assert.ok(project.autoEditCategories.some((item) => item.name === '产品'));
  const unsupportedPlatformLink = await apiResponse(base, `/api/projects/${project.id}/benchmarks`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${enterpriseToken}` },
    body: JSON.stringify({ url: 'https://example.com/video.mp4', platform: '其他' })
  });
  assert.equal(unsupportedPlatformLink.response.status, 400);
  assert.equal(unsupportedPlatformLink.payload.code, 'PLATFORM_LINK_UNSUPPORTED');
  const customAssetCategory = await api(base, `/api/projects/${project.id}/asset-categories`, { method: 'POST', body: JSON.stringify({ name: '产品细节特写' }) });
  assert.equal(customAssetCategory.name, '产品细节特写');
  const duplicateAssetCategory = await apiResponse(base, `/api/projects/${project.id}/asset-categories`, { method: 'POST', body: JSON.stringify({ name: ' 产品细节特写 ' }) });
  assert.equal(duplicateAssetCategory.response.status, 409);
  assert.equal(duplicateAssetCategory.payload.code, 'ASSET_CATEGORY_EXISTS');
  const chatState = await api(base, `/api/projects/${project.id}/chat`);
  assert.equal(chatState.messages.length, 0);
  assert.ok(chatState.presets.some((item) => item.id === 'content-strategist'));
  assert.equal(JSON.stringify(chatState.presets).includes('systemPrompt'), false);
  assert.equal(chatState.model.configured, false);
  await api(base, `/api/projects/${project.id}/chat`, { method: 'PATCH', body: JSON.stringify({ presetId: 'copy-coauthor' }) });
  assert.equal((await api(base, `/api/projects/${project.id}/chat`)).activePresetId, 'copy-coauthor');
  const chatWithoutModel = await apiResponse(base, `/api/projects/${project.id}/chat`, { method: 'POST', body: JSON.stringify({ message: '测试对话' }) });
  assert.equal(chatWithoutModel.response.status, 503);
  assert.equal(chatWithoutModel.payload.code, 'CHAT_NOT_CONFIGURED');
  const manualCopy = await api(base, '/api/copies', {
    method: 'POST',
    body: JSON.stringify({ projectId: project.id, title: '手工测试文案', mode: 'standard', text: '这是第一版正文。' })
  });
  assert.equal(manualCopy.manual, true);
  assert.equal(manualCopy.content.script, '这是第一版正文。');
  const copyDetail = await api(base, `/api/copies/${manualCopy.id}`);
  assert.equal(copyDetail.title, '手工测试文案');
  const updatedCopy = await api(base, `/api/copies/${manualCopy.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ title: '编辑后的问答文案', mode: 'qa', text: '问题一\n回答一' })
  });
  assert.deepEqual(updatedCopy.content.qaScript, ['问题一', '回答一']);
  assert.ok(updatedCopy.updatedAt);
  assert.ok((await api(base, `/api/copies?projectId=${project.id}`)).some((item) => item.id === manualCopy.id));
  await api(base, `/api/copies/${manualCopy.id}`, { method: 'DELETE' });
  assert.equal((await api(base, `/api/copies?projectId=${project.id}`)).some((item) => item.id === manualCopy.id), false);
  await api(base, '/api/admin/settings/project', {
    method: 'PUT',
    body: JSON.stringify({ speechLanguages: commissionConfig.speechLanguages.map((item) => ({ id: item.id, enabled: item.id === 'en-US' ? false : item.enabled })) })
  });
  const disabledLanguage = await apiResponse(base, `/api/projects/${project.id}/generate`, { method: 'POST', body: JSON.stringify({ kind: 'digital_human', avatarId: 'avatar-test', voiceId: 'voice-test', script: '测试文案', language: 'en-US', consent: true }) });
  assert.equal(disabledLanguage.response.status, 409);
  assert.equal(disabledLanguage.payload.code, 'SPEECH_LANGUAGE_DISABLED');
  const customers = await api(base, '/api/admin/customers');
  const memberCustomer = customers.find((item) => item.user.id === memberUser.id);
  assert.equal(memberCustomer.parentAgent.id, secondaryAgent.id);
  assert.ok(memberCustomer.organizations.some((item) => item.id === organization.id));
  const memberLogin = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: 'member@example.com', password: 'member-password' }) });
  const memberToken = (await memberLogin.json()).data.accessToken;
  const memberMe = await api(base, '/api/auth/me', { headers: { Authorization: `Bearer ${memberToken}` } });
  assert.equal(memberMe.personalPointsBalance, 0);
  assert.equal(memberMe.pointsBalance, 10);
  assert.equal(memberMe.enterprisePointsBalance, 100);
  assert.equal(memberMe.pointsAccountName, '企业成员可用算力');
  assert.equal(memberMe.memberPointsLimit, 10);
  assert.equal(memberMe.memberPointsRemaining, 10);
  const emptiedEnterprise = await api(base, `/api/admin/users/${secondaryAgent.id}/points`, { method: 'POST', body: JSON.stringify({ delta: -100, reason: '企业零余额鉴权测试' }) });
  assert.equal(emptiedEnterprise.pointsAccount.balance, 0);
  const limitAtZeroBalance = await api(base, `/api/account/organization/members/${memberUser.id}`, { method: 'PATCH', headers: { Authorization: `Bearer ${enterpriseToken}` }, body: JSON.stringify({ computeQuota: 50 }) });
  assert.equal(limitAtZeroBalance.pointsBalance, 0);
  const memberAtZeroBalance = await api(base, '/api/auth/me', { headers: { Authorization: `Bearer ${memberToken}` } });
  assert.equal(memberAtZeroBalance.pointsBalance, 0);
  assert.equal(memberAtZeroBalance.memberPointsLimit, 50);
  assert.equal(memberAtZeroBalance.memberPointsRemaining, 0);
  await api(base, `/api/admin/users/${secondaryAgent.id}/points`, { method: 'POST', body: JSON.stringify({ delta: 2, reason: '成员素材计费测试入账' }) });
  const deniedProfile = await fetch(`${base}/api/v1/projects/${project.id}/profile`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${memberToken}` }, body: JSON.stringify({ identity: '无权修改' }) });
  assert.equal(deniedProfile.status, 403);
  assert.equal((await deniedProfile.json()).code, 'PROJECT_PERMISSION_REQUIRED');
  const allowedAsset = await fetch(`${base}/api/v1/projects/${project.id}/assets`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${memberToken}` }, body: JSON.stringify({ name: '成员素材.txt', kind: '其他', mimeType: 'text/plain', data: Buffer.from('member-asset').toString('base64') }) });
  assert.equal(allowedAsset.status, 201);
  const ownerAdjustedMemberLimit = await api(base, `/api/account/organization/members/${memberUser.id}`, { method: 'PATCH', headers: { Authorization: `Bearer ${enterpriseToken}` }, body: JSON.stringify({ permissions: ['创作', '素材'], computeQuota: 15 }) });
  assert.equal(ownerAdjustedMemberLimit.pointsBalance, 0);

  const secondProject = await api(base, '/api/projects', {
    method: 'POST',
    headers: { Authorization: `Bearer ${enterpriseToken}` },
    body: JSON.stringify({ name: '账号媒体跨项目测试', industry: '制造业', purpose: '内容生产' })
  });
  const accountMediaStorePath = path.join(temp, 'data', 'store.json');
  const accountMediaStore = JSON.parse(await fs.readFile(accountMediaStorePath, 'utf8'));
  const ownerAvatarId = 'avatar_owner_account_scope';
  const ownerVoiceId = 'voice_owner_account_scope';
  const memberAvatarId = 'avatar_member_account_scope';
  const memberVoiceId = 'voice_member_account_scope';
  const ownerAvatarPreviewId = 'asset_owner_avatar_preview';
  const ownerVoicePreviewId = 'asset_owner_voice_preview';
  const ownerAvatarStorageKey = `${project.id}/account-media/${ownerAvatarPreviewId}.jpg`;
  const ownerVoiceStorageKey = `${project.id}/account-media/${ownerVoicePreviewId}.mp3`;
  const ownerAvatarPreviewPath = path.join(temp, 'storage', ...ownerAvatarStorageKey.split('/'));
  const ownerVoicePreviewPath = path.join(temp, 'storage', ...ownerVoiceStorageKey.split('/'));
  await fs.mkdir(path.dirname(ownerAvatarPreviewPath), { recursive: true });
  await fs.writeFile(ownerAvatarPreviewPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  await fs.writeFile(ownerVoicePreviewPath, Buffer.from('account-voice-preview'));
  accountMediaStore.accountMedia ||= { avatars: [], voices: [], assets: [] };
  accountMediaStore.accountMedia.avatars.unshift(
    { id: ownerAvatarId, avatarId: ownerAvatarId, ownerUserId: secondaryAgent.id, sourceProjectId: project.id, name: '负责人数字人', status: 'ready', previewImageAssetId: ownerAvatarPreviewId, createdAt: new Date().toISOString() },
    { id: memberAvatarId, avatarId: memberAvatarId, ownerUserId: memberUser.id, sourceProjectId: project.id, name: '成员数字人', status: 'ready', previewImageAssetId: null, createdAt: new Date().toISOString() }
  );
  accountMediaStore.accountMedia.voices.unshift(
    { id: ownerVoiceId, engineVoiceId: ownerVoiceId, ownerUserId: secondaryAgent.id, sourceProjectId: project.id, name: '负责人音色', status: 'ready', previewAssetId: ownerVoicePreviewId, createdAt: new Date().toISOString() },
    { id: memberVoiceId, engineVoiceId: memberVoiceId, ownerUserId: memberUser.id, sourceProjectId: project.id, name: '成员音色', status: 'ready', previewAssetId: null, createdAt: new Date().toISOString() }
  );
  accountMediaStore.accountMedia.assets.unshift(
    { id: ownerAvatarPreviewId, ownerUserId: secondaryAgent.id, mediaType: 'avatars', mediaId: ownerAvatarId, name: '负责人数字人预览.jpg', mimeType: 'image/jpeg', storageKey: ownerAvatarStorageKey, sizeBytes: 4, createdAt: new Date().toISOString() },
    { id: ownerVoicePreviewId, ownerUserId: secondaryAgent.id, mediaType: 'voices', mediaId: ownerVoiceId, name: '负责人音色试听.mp3', mimeType: 'audio/mpeg', storageKey: ownerVoiceStorageKey, sizeBytes: 21, createdAt: new Date().toISOString() }
  );
  accountMediaStore.jobs.unshift(
    { id: 'owner-private-media-task', projectId: project.id, kind: 'avatar_create', userId: secondaryAgent.id, status: 'success', progress: 100, result: { type: 'avatar_create', avatar: { id: ownerAvatarId } }, createdAt: new Date().toISOString() },
    { id: 'member-private-media-task', projectId: project.id, kind: 'voice_clone', userId: memberUser.id, status: 'success', progress: 100, result: { type: 'voice_clone', voice: { id: memberVoiceId } }, createdAt: new Date().toISOString() }
  );
  await fs.writeFile(accountMediaStorePath, JSON.stringify(accountMediaStore, null, 2), 'utf8');

  const ownerFirstProject = await api(base, `/api/projects/${project.id}`, { headers: { Authorization: `Bearer ${enterpriseToken}` } });
  const ownerSecondProject = await api(base, `/api/projects/${secondProject.id}`, { headers: { Authorization: `Bearer ${enterpriseToken}` } });
  assert.deepEqual(ownerFirstProject.avatars.map((item) => item.id), [ownerAvatarId]);
  assert.deepEqual(ownerSecondProject.avatars.map((item) => item.id), [ownerAvatarId]);
  assert.deepEqual(ownerFirstProject.voices.map((item) => item.id), [ownerVoiceId]);
  assert.equal(ownerFirstProject.avatars[0].scope, 'account');
  assert.equal(ownerFirstProject.avatars[0].previewUrl, `/api/account-media/avatars/${ownerAvatarId}/preview`);
  assert.equal(ownerFirstProject.assets.some((item) => [ownerAvatarPreviewId, ownerVoicePreviewId].includes(item.id)), false);
  assert.equal(ownerFirstProject.assets.some((item) => item.name === '成员素材.txt'), true);
  assert.equal(ownerSecondProject.assets.some((item) => item.name === '成员素材.txt'), false);

  const memberProjectView = await api(base, `/api/projects/${project.id}`, { headers: { Authorization: `Bearer ${memberToken}` } });
  assert.deepEqual(memberProjectView.avatars.map((item) => item.id), [memberAvatarId]);
  assert.deepEqual(memberProjectView.voices.map((item) => item.id), [memberVoiceId]);
  const ownerTasks = await api(base, `/api/projects/${project.id}/tasks`, { headers: { Authorization: `Bearer ${enterpriseToken}` } });
  const memberTasks = await api(base, `/api/projects/${project.id}/tasks`, { headers: { Authorization: `Bearer ${memberToken}` } });
  assert.equal(ownerTasks.some((item) => item.id === 'owner-private-media-task'), true);
  assert.equal(ownerTasks.some((item) => item.id === 'member-private-media-task'), false);
  assert.equal(memberTasks.some((item) => item.id === 'owner-private-media-task'), false);
  assert.equal(memberTasks.some((item) => item.id === 'member-private-media-task'), true);
  assert.equal((await fetch(`${base}/api/tasks/owner-private-media-task`, { headers: { Authorization: `Bearer ${memberToken}` } })).status, 404);

  const scopedCopy = await api(base, '/api/copies', {
    method: 'POST',
    headers: { Authorization: `Bearer ${enterpriseToken}` },
    body: JSON.stringify({ projectId: project.id, title: '仅项目一文案', mode: 'standard', text: '项目一独立文案内容。' })
  });
  assert.ok((await api(base, `/api/copies?projectId=${project.id}`, { headers: { Authorization: `Bearer ${enterpriseToken}` } })).some((item) => item.id === scopedCopy.id));
  assert.equal((await api(base, `/api/copies?projectId=${secondProject.id}`, { headers: { Authorization: `Bearer ${enterpriseToken}` } })).some((item) => item.id === scopedCopy.id), false);

  const ownerAvatarPreview = await fetch(`${base}/api/account-media/avatars/${ownerAvatarId}/preview`, { headers: { Authorization: `Bearer ${enterpriseToken}` } });
  assert.equal(ownerAvatarPreview.status, 200);
  assert.match(ownerAvatarPreview.headers.get('content-type'), /^image\/jpeg/);
  const memberDeniedOwnerPreview = await fetch(`${base}/api/account-media/avatars/${ownerAvatarId}/preview`, { headers: { Authorization: `Bearer ${memberToken}` } });
  assert.equal(memberDeniedOwnerPreview.status, 404);

  const guessedAvatar = await apiResponse(base, `/api/projects/${project.id}/generate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${enterpriseToken}` },
    body: JSON.stringify({ kind: 'digital_human', avatarId: memberAvatarId, voiceId: ownerVoiceId, script: '不能调用成员数字人', language: 'zh-CN', consent: true })
  });
  assert.equal(guessedAvatar.response.status, 404);
  assert.equal(guessedAvatar.payload.code, 'ACCOUNT_AVATAR_NOT_FOUND');
  const guessedVoice = await apiResponse(base, `/api/projects/${project.id}/generate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${enterpriseToken}` },
    body: JSON.stringify({ kind: 'voice_preview', voiceId: memberVoiceId })
  });
  assert.equal(guessedVoice.response.status, 404);
  assert.equal(guessedVoice.payload.code, 'ACCOUNT_VOICE_NOT_FOUND');

  await api(base, `/api/projects/${secondProject.id}/avatars/${ownerAvatarId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${enterpriseToken}` } });
  assert.equal((await api(base, `/api/projects/${project.id}`, { headers: { Authorization: `Bearer ${enterpriseToken}` } })).avatars.some((item) => item.id === ownerAvatarId), false);
  assert.equal((await fetch(`${base}/api/account-media/avatars/${ownerAvatarId}/preview`, { headers: { Authorization: `Bearer ${enterpriseToken}` } })).status, 404);

  await api(base, '/api/admin/settings/task-costs', { method: 'PUT', body: JSON.stringify({ image: 1 }) });
  const zeroEnterpriseBalanceDenied = await apiResponse(base, `/api/projects/${project.id}/generate`, { method: 'POST', headers: { Authorization: `Bearer ${memberToken}` }, body: JSON.stringify({ kind: 'image', prompt: '企业零余额鉴权测试' }) });
  assert.equal(zeroEnterpriseBalanceDenied.response.status, 402);
  assert.equal(zeroEnterpriseBalanceDenied.payload.code, 'INSUFFICIENT_ENTERPRISE_POINTS');
  await api(base, `/api/admin/users/${secondaryAgent.id}/points`, { method: 'POST', body: JSON.stringify({ delta: 100, reason: '恢复企业鉴权测试余额' }) });
  await api(base, '/api/admin/settings/task-costs', { method: 'PUT', body: JSON.stringify({ image: 0 }) });
  await api(base, '/api/admin/settings/task-costs', { method: 'PUT', body: JSON.stringify({ image: 16 }) });
  const memberLimitDenied = await apiResponse(base, `/api/projects/${project.id}/generate`, { method: 'POST', headers: { Authorization: `Bearer ${memberToken}` }, body: JSON.stringify({ kind: 'image', prompt: '额度测试' }) });
  assert.equal(memberLimitDenied.response.status, 402);
  assert.equal(memberLimitDenied.payload.code, 'MEMBER_COMPUTE_QUOTA_EXCEEDED');
  const ledgerSizeBeforeLimitChange = (await api(base, '/api/admin/points')).length;
  const extendedMemberLimit = await api(base, `/api/account/organization/members/${memberUser.id}`, { method: 'PATCH', headers: { Authorization: `Bearer ${enterpriseToken}` }, body: JSON.stringify({ computeQuota: 200 }) });
  assert.equal(extendedMemberLimit.pointsBalance, 100);
  assert.equal((await api(base, '/api/admin/points')).length, ledgerSizeBeforeLimitChange);
  await api(base, '/api/admin/settings/task-costs', { method: 'PUT', body: JSON.stringify({ image: 101 }) });
  const enterpriseBalanceDenied = await apiResponse(base, `/api/projects/${project.id}/generate`, { method: 'POST', headers: { Authorization: `Bearer ${memberToken}` }, body: JSON.stringify({ kind: 'image', prompt: '企业余额测试' }) });
  assert.equal(enterpriseBalanceDenied.response.status, 402);
  assert.equal(enterpriseBalanceDenied.payload.code, 'INSUFFICIENT_ENTERPRISE_POINTS');
  await api(base, '/api/admin/settings/task-costs', { method: 'PUT', body: JSON.stringify({ image: 0 }) });
  const enterpriseRedeem = await api(base, '/api/account/redeem', { method: 'POST', headers: { Authorization: `Bearer ${memberToken}`, 'Idempotency-Key': 'member-enterprise-redeem-20260902' }, body: JSON.stringify({ code: configuredCoupon.code }) });
  assert.equal(enterpriseRedeem.accountType, 'organization');
  assert.equal(enterpriseRedeem.balance, 2100);
  const missingFeatureContact = await apiResponse(base, `/api/projects/${project.id}/custom-templates`, {
    method: 'POST',
    body: JSON.stringify({ name: '批量生成选题', requirement: '支持按行业批量生成选题，并可导出表格' })
  });
  assert.equal(missingFeatureContact.response.status, 400);
  assert.equal(missingFeatureContact.payload.error, '请填写联系方式');
  const customRequest = await api(base, `/api/projects/${project.id}/custom-templates`, {
    method: 'POST',
    body: JSON.stringify({ name: '批量生成选题', contact: '13800138000', requirement: '支持按行业批量生成选题，并可导出表格' })
  });
  assert.equal(customRequest.status, 'submitted');
  assert.equal(customRequest.contact, '13800138000');
  assert.equal(Object.hasOwn(customRequest, 'referenceUrl'), false);
  assert.equal(Object.hasOwn(customRequest, 'access'), false);
  const customRequests = await api(base, '/api/admin/custom-template-requests');
  assert.equal(customRequests[0].projectId, project.id);
  assert.equal(customRequests[0].contact, '13800138000');
  const updatedRequest = await api(base, `/api/admin/custom-template-requests/${project.id}/${customRequest.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'evaluating', adminNote: '等待客户补充字体授权' })
  });
  assert.equal(updatedRequest.status, 'evaluating');
  assert.equal(updatedRequest.adminNote, '等待客户补充字体授权');
  const positioning = await apiResponse(base, `/api/projects/${project.id}/positioning`, { method: 'POST', body: '{}' });
  assert.equal(positioning.response.status, 503);
  assert.equal(positioning.payload.code, 'LLM_NOT_CONFIGURED');

  const asset = await api(base, `/api/projects/${project.id}/assets`, {
    method: 'POST',
    body: JSON.stringify({ name: '轴承产品展示.txt', kind: '产品', mimeType: 'text/plain', data: Buffer.from('asset-bytes').toString('base64') })
  });
  assert.equal(asset.sizeBytes, 11);
  const content = await fetch(`${base}${asset.accessUrl}`, { headers: { Cookie: authCookie } });
  assert.equal(await content.text(), 'asset-bytes');
  assert.equal(content.headers.get('cache-control'), 'private, max-age=300, must-revalidate');
  assert.match(content.headers.get('vary'), /Cookie/);
  const assetEtag = content.headers.get('etag');
  assert.match(assetEtag, /^"[a-f0-9]{64}"$/);
  const cachedContent = await fetch(`${base}${asset.accessUrl}`, { headers: { Cookie: authCookie, 'If-None-Match': assetEtag } });
  assert.equal(cachedContent.status, 304);
  assert.equal(await cachedContent.text(), '');
  const partial = await fetch(`${base}${asset.accessUrl}`, { headers: { Cookie: authCookie, Range: 'bytes=0-4', 'If-Range': assetEtag } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), 'bytes 0-4/11');
  assert.equal(await partial.text(), 'asset');
  const stalePartial = await fetch(`${base}${asset.accessUrl}`, { headers: { Cookie: authCookie, Range: 'bytes=0-4', 'If-Range': '"stale"' } });
  assert.equal(stalePartial.status, 200);
  assert.equal(await stalePartial.text(), 'asset-bytes');

  const directBytes = Buffer.from('direct-upload-bytes');
  const uploadTicket = await api(base, `/api/projects/${project.id}/assets/uploads`, {
    method: 'POST',
    body: JSON.stringify({ name: '浏览器直传.txt', kind: '其他', mimeType: 'text/plain', sizeBytes: directBytes.length })
  });
  assert.equal(uploadTicket.driver, 'local');
  const directPut = await fetch(`${base}${uploadTicket.uploadUrl}`, {
    method: 'PUT',
    headers: { Cookie: authCookie, 'Content-Type': 'text/plain' },
    body: directBytes
  });
  assert.equal(directPut.status, 204);
  const directAsset = await api(base, `/api/projects/${project.id}/assets/uploads/${uploadTicket.uploadId}/complete`, {
    method: 'POST',
    body: JSON.stringify({ token: uploadTicket.token })
  });
  assert.equal(directAsset.sizeBytes, directBytes.length);
  assert.match(directAsset.storageKey, /^users\/.+\/projects\/.+\/assets\//);
  const directContent = await fetch(`${base}${directAsset.accessUrl}`, { headers: { Cookie: authCookie } });
  assert.equal(await directContent.text(), directBytes.toString());

  const posterVideoPath = path.join(temp, 'poster-source.mp4');
  await runTestCommand('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x568:d=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', posterVideoPath
  ]);
  const videoAsset = await api(base, `/api/projects/${project.id}/assets`, {
    method: 'POST',
    body: JSON.stringify({ name: 'poster-source.mp4', kind: '场景', autoEditCategory: '产品', mimeType: 'video/mp4', data: (await fs.readFile(posterVideoPath)).toString('base64') })
  });
  assert.equal(videoAsset.autoEditCategory, '产品');
  const uploadedBenchmark = await api(base, `/api/projects/${project.id}/benchmarks`, {
    method: 'POST',
    body: JSON.stringify({ assetId: videoAsset.id, title: videoAsset.name, platform: '其他' })
  });
  assert.equal(uploadedBenchmark.platform, '手动上传');
  assert.equal(uploadedBenchmark.sourceType, 'uploaded_file');
  const recategorizedVideoAsset = await api(base, `/api/projects/${project.id}/assets/${videoAsset.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ autoEditCategory: '案例' })
  });
  assert.equal(recategorizedVideoAsset.autoEditCategory, '案例');
  assert.equal(recategorizedVideoAsset.kind, '案例');
  const customCategorizedVideoAsset = await api(base, `/api/projects/${project.id}/assets/${videoAsset.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ autoEditCategory: customAssetCategory.name })
  });
  assert.equal(customCategorizedVideoAsset.autoEditCategory, customAssetCategory.name);
  const renamedAssetCategory = await api(base, `/api/projects/${project.id}/asset-categories/${customAssetCategory.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: '产品功能细节' })
  });
  assert.equal(renamedAssetCategory.name, '产品功能细节');
  assert.equal(renamedAssetCategory.affectedAssetIds.includes(videoAsset.id), true);
  assert.equal((await api(base, `/api/projects/${project.id}`)).assets.find((item) => item.id === videoAsset.id).autoEditCategory, '产品功能细节');
  const deletedAssetCategory = await api(base, `/api/projects/${project.id}/asset-categories/${customAssetCategory.id}`, { method: 'DELETE' });
  assert.equal(deletedAssetCategory.reassignedCategory, '未分类');
  assert.equal((await api(base, `/api/projects/${project.id}`)).assets.find((item) => item.id === videoAsset.id).autoEditCategory, '未分类');
  const groupingVideoData = (await fs.readFile(posterVideoPath)).toString('base64');
  for (const name of ['工厂流程_001.mp4', '工厂流程_002.mp4']) {
    await api(base, `/api/projects/${project.id}/assets`, {
      method: 'POST',
      body: JSON.stringify({ name, kind: '场景', mimeType: 'video/mp4', data: groupingVideoData })
    });
  }
  const organizedProject = await api(base, `/api/projects/${project.id}/asset-categories/organize`, { method: 'POST', body: '{}' });
  assert.ok(organizedProject.autoEditCategories.some((item) => item.name === '工厂流程' && item.assetCount === 2));
  assert.equal(organizedProject.assets.filter((item) => item.autoEditCategory === '工厂流程').length, 2);
  const posterResponse = await fetch(`${base}/api/assets/${videoAsset.id}/poster`, { headers: { Cookie: authCookie } });
  assert.equal(posterResponse.status, 200);
  assert.match(posterResponse.headers.get('content-type'), /^image\/jpeg/);
  assert.equal(posterResponse.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  const posterEtag = posterResponse.headers.get('etag');
  const posterBytes = Buffer.from(await posterResponse.arrayBuffer());
  assert.ok(posterBytes.length > 100);
  assert.deepEqual([...posterBytes.subarray(0, 2)], [0xff, 0xd8]);
  const cachedPoster = await fetch(`${base}/api/assets/${videoAsset.id}/poster`, { headers: { Cookie: authCookie, 'If-None-Match': posterEtag } });
  assert.equal(cachedPoster.status, 304);

  const outputBytes = Buffer.from('0123456789-video-output');
  const outputId = 'out_http_range_test';
  const outputStorageKey = `${project.id}/generated/http-range-test.mp4`;
  const outputFile = path.join(temp, 'storage', ...outputStorageKey.split('/'));
  await fs.mkdir(path.dirname(outputFile), { recursive: true });
  await fs.writeFile(outputFile, outputBytes);
  const subtitleStorageKey = `${project.id}/generated/http-range-test-subtitles.ass`;
  const subtitleFile = path.join(temp, 'storage', ...subtitleStorageKey.split('/'));
  await fs.writeFile(subtitleFile, '[Script Info]\n[Events]\nDialogue: 0,0:00:00.00,0:00:01.00,TiTok Adaptive,,0,0,0,,测试\n', 'utf8');
  const persistedStorePath = path.join(temp, 'data', 'store.json');
  const persistedStore = JSON.parse(await fs.readFile(persistedStorePath, 'utf8'));
  persistedStore.projects.find((item) => item.id === project.id).outputs.unshift({ id: outputId, storageKey: outputStorageKey, filename: 'http-range-test.mp4', subtitleStorageKey, subtitleFilename: 'http-range-test-subtitles.ass', subtitleFormat: 'ass', status: 'ready', createdAt: new Date().toISOString() });
  await fs.writeFile(persistedStorePath, JSON.stringify(persistedStore, null, 2), 'utf8');
  const outputRange = await fetch(`${base}/api/outputs/${outputId}/content`, { headers: { Cookie: authCookie, Range: 'bytes=2-7' } });
  assert.equal(outputRange.status, 206);
  assert.equal(outputRange.headers.get('content-range'), `bytes 2-7/${outputBytes.length}`);
  assert.equal(outputRange.headers.get('cache-control'), 'private, max-age=300, must-revalidate');
  const outputEtag = outputRange.headers.get('etag');
  assert.equal(await outputRange.text(), '234567');
  const cachedOutput = await fetch(`${base}/api/outputs/${outputId}/content`, { headers: { Cookie: authCookie, 'If-None-Match': outputEtag } });
  assert.equal(cachedOutput.status, 304);
  const subtitleResponse = await fetch(`${base}/api/outputs/${outputId}/subtitles`, { headers: { Cookie: authCookie } });
  assert.equal(subtitleResponse.status, 200);
  assert.match(subtitleResponse.headers.get('content-type'), /^text\/x-ass/);
  assert.match(await subtitleResponse.text(), /TiTok Adaptive/);

  const search = await api(base, `/api/projects/${project.id}/assets/search?q=${encodeURIComponent('轴承展示')}&limit=5`);
  assert.equal(search.items[0].id, asset.id);

  const taskKey = 'test-image-task-20260824';
  const task = await api(base, `/api/projects/${project.id}/generate`, { method: 'POST', headers: { 'Idempotency-Key': taskKey }, body: JSON.stringify({ kind: 'image', prompt: '产品图' }) });
  const duplicateTask = await api(base, `/api/projects/${project.id}/generate`, { method: 'POST', headers: { 'Idempotency-Key': taskKey }, body: JSON.stringify({ kind: 'image', prompt: '产品图' }) });
  assert.equal(duplicateTask.id, task.id);
  let current = task;
  for (let attempt = 0; attempt < 20 && !['success', 'failed'].includes(current.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    current = await api(base, `/api/tasks/${task.id}`);
  }
  assert.equal(current.status, 'failed');
  assert.equal(current.error.code, 'IMAGE_NOT_CONFIGURED');
  assert.equal(current.error.retryable, false);
  assert.equal(current.canRetry, true);

  const retryResponse = await apiResponse(base, `/api/projects/${project.id}/tasks/${task.id}/retry`, { method: 'POST', headers: { 'Idempotency-Key': 'test-image-retry-20260824' }, body: '{}' });
  assert.equal(retryResponse.response.status, 202);
  assert.equal(retryResponse.payload.data.retryOfTaskId, task.id);
  assert.equal(retryResponse.payload.data.attempt, 2);
  const tasksAfterRetry = await api(base, `/api/projects/${project.id}/tasks`);
  assert.equal(tasksAfterRetry.some((item) => item.id === task.id), false);
  assert.equal(tasksAfterRetry.some((item) => item.id === retryResponse.payload.data.id), true);

  const publishTask = await api(base, `/api/projects/${project.id}/generate`, { method: 'POST', body: JSON.stringify({ kind: 'publish', platforms: ['抖音'] }) });
  let publishCurrent = publishTask;
  for (let attempt = 0; attempt < 20 && !['success', 'failed'].includes(publishCurrent.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    publishCurrent = await api(base, `/api/tasks/${publishTask.id}`);
  }
  assert.equal(publishCurrent.status, 'failed');
  assert.equal(publishCurrent.error.code, 'PUBLISH_VIDEO_REQUIRED');

  const refreshed = await api(base, `/api/projects/${project.id}`);
  assert.equal(refreshed.generatedImages.length, 0);
  assert.equal(refreshed.publishPackages.length, 0);
  assert.equal(refreshed.positioning, null);

  await api(base, `/api/projects/${project.id}/assets/${asset.id}`, { method: 'DELETE' });
  const deletedContent = await fetch(`${base}${asset.accessUrl}`, { headers: { Cookie: authCookie } });
  assert.equal(deletedContent.status, 404);
  await api(base, `/api/projects/${project.id}/assets/${videoAsset.id}`, { method: 'DELETE' });
  const deletedPoster = await fetch(`${base}/api/assets/${videoAsset.id}/poster`, { headers: { Cookie: authCookie } });
  assert.equal(deletedPoster.status, 404);

  await api(base, `/api/admin/users/${memberUser.id}`, { method: 'PATCH', body: JSON.stringify({ password: 'member-password-rotated' }) });
  const revokedMemberSession = await fetch(`${base}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${memberToken}` } });
  assert.equal(revokedMemberSession.status, 401);
  await api(base, `/api/admin/users/${memberUser.id}`, { method: 'DELETE' });
  const organizationAfterAdminDelete = (await api(base, '/api/admin/organizations')).find((item) => item.id === organization.id);
  assert.equal(organizationAfterAdminDelete.members.some((item) => item.userId === memberUser.id), false);
  assert.equal((await api(base, '/api/admin/users')).some((item) => item.id === memberUser.id), false);
  const storeAfterMemberDelete = JSON.parse(await fs.readFile(path.join(temp, 'data', 'store.json'), 'utf8'));
  assert.equal(storeAfterMemberDelete.accountMedia.avatars.some((item) => item.ownerUserId === memberUser.id), false);
  assert.equal(storeAfterMemberDelete.accountMedia.voices.some((item) => item.ownerUserId === memberUser.id), false);
  assert.equal(storeAfterMemberDelete.accountMedia.assets.some((item) => item.ownerUserId === memberUser.id), false);
});
