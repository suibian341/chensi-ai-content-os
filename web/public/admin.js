import { apiFetch, clearAccessToken, createApiError, ensureControlIdentities, resolveApiUrls } from './config.js';

const state = { user: null, dashboard: null, users: [], customers: [], points: [], settings: null, requests: [], audit: [], tickets: [], coupons: [], distribution: null, organizations: [], backgroundMusic: [], backgroundMusicError: '' };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const esc = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
function generatedCouponCode() {
  const token = globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 10) || Math.random().toString(36).slice(2, 12).toUpperCase();
  return `CS-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${token.toUpperCase()}`;
}
const publicFeatureText = (value = '') => String(value ?? '').trim();

const providerGroupOrder = [
  '对象存储与 CDN', 'AI 视频理解模型', 'AI 文本模型', 'AI 对话', 'AI 图片生成', '素材搜索', '语音与声音克隆', '数字人服务', '纯口播数字人',
  '内容解析', '远端剪辑服务', '剪映草稿', '平台发布'
];
const providerGroupMeta = {
  '对象存储与 CDN': { kicker: 'MEDIA STORAGE', description: '生产环境使用私有对象存储保存素材，通过签名地址直传；配置 CDN 后自动用于播放和下载加速。' },
  'AI 视频理解模型': { kicker: 'VIDEO UNDERSTANDING', description: '负责视频拆解和视觉理解；当前保持豆包 Seed Evo 多模态链路。' },
  'AI 文本模型': { kicker: 'TEXT GENERATION', description: '负责 IP 定位、文案、账号汇总和语言处理；配置独立 gpt-5.6-sol 文本模型。' },
  'AI 对话': { kicker: 'PROJECT CHAT', description: '项目助手默认跟随 AI 文本模型，也可单独覆盖模型和接口。' },
  'AI 图片生成': { kicker: 'IMAGE GENERATION', description: '图片生成、画幅和异步任务参数。' },
  '素材搜索': { kicker: 'ASSET SEARCH', description: '在线素材搜索服务的访问凭证。' },
  '语音与声音克隆': { kicker: 'VOICE & CLONING', description: '语音生成、声音克隆和任务状态参数。' },
  '数字人服务': { kicker: 'DIGITAL HUMAN', description: '数字人形象、口播生成和访问参数。' },
  '纯口播数字人': { kicker: 'TALKING PHOTO', description: '配置一张人物图片与文案直接生成自然口播视频的能力。' },
  '内容解析': { kicker: 'CONTENT PARSING', description: '读取并拆解抖音、小红书与视频号公开内容。' },
  '远端剪辑服务': { kicker: 'REMOTE VIDEO', description: '视频剪辑服务的连接地址、密钥和任务参数。' },
  '剪映草稿': { kicker: 'JIAN YING', description: '剪映草稿目录、索引和桥接命令。' },
  '平台发布': { kicker: 'PLATFORM PUBLISH', description: '第三方平台登录态、扫码和发布任务参数。' }
};

async function request(url, options = {}) {
  const response = await apiFetch(url, options);
  const payload = await response.json();
  if (response.status === 401) {
    window.location.replace('/login.html');
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

function setLoading(button, loading, label = '处理中') {
  if (!button) return;
  if (loading) {
    button.dataset.idle = button.innerHTML;
    button.disabled = true;
    button.classList.add('is-loading');
    button.innerHTML = `<span>${esc(label)}</span><span class="loading-dots"><i></i><i></i><i></i></span>`;
  } else {
    button.disabled = false;
    button.classList.remove('is-loading');
    button.innerHTML = button.dataset.idle || button.innerHTML;
  }
}

const statusLabel = (value) => ({ ready: '已验证可用', configured: '已配置待验证', degraded: '最近调用失败', partial: '部分完成', needs_config: '待配置', unavailable: '待接入' }[value] || value);
const dateTime = (value) => value ? new Date(value).toLocaleString('zh-CN') : '—';

function ensureControlNames(root = document) {
  ensureControlIdentities(root);
}

const controlNameObserver = new MutationObserver((records) => {
  for (const record of records) for (const node of record.addedNodes) if (node.nodeType === Node.ELEMENT_NODE) ensureControlNames(node);
});
controlNameObserver.observe(document.body, { childList: true, subtree: true });
ensureControlNames();

function go(view) {
  const titles = { dashboard: '运营总览', users: '客户与账号', tickets: '客服工单', distribution: '分销与卡密', points: '算力管理', requests: '许愿清单', music: '背景音乐库', settings: '项目设置', audit: '审计记录' };
  $$('.nav-item[data-admin-view]').forEach((item) => item.classList.toggle('active', item.dataset.adminView === view));
  $$('.admin-view').forEach((item) => item.classList.toggle('hidden', item.id !== `${view}AdminView`));
  $('#adminPageTitle').textContent = titles[view];
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderDashboard() {
  const data = state.dashboard;
  const metrics = [
    ['用户数', data.stats.users, `${data.stats.activeUsers} 个正常账号`, 'accent-teal'],
    ['项目数', data.stats.projects, '真实工作台项目', ''],
    ['任务数', data.stats.tasks, '成功与失败均计入', ''],
    ['累计发放算力', data.stats.pointsIssued, '以算力流水为准', 'accent-coral'],
    ['企业工作空间', data.stats.organizations || 0, '企业席位与项目协作', ''],
    ['待处理工单', data.stats.openTickets || 0, '客服处理队列', ''],
    ['代理账号', data.stats.agents || 0, '两级关系可追溯', '']
  ];
  $('#adminMetrics').innerHTML = metrics.map(([label, value, note, cls]) => `<article class="metric-card ${cls}"><div class="metric-label">${esc(label)}</div><div class="metric-value">${esc(value)}</div><div class="metric-foot">${esc(note)}</div></article>`).join('');
  const icons = { douyin: '♪', tencent: '◉', xiaohongshu: '◇', kuaishou: '▷', bilibili: '▣', baijiahao: '文' };
  const platforms = data.platforms || [];
  const totals = platforms.reduce((result, item) => ({
    connected: result.connected + Number(item.connectedAccounts || 0),
    published: result.published + Number(item.successfulPublishes || 0),
    pending: result.pending + Number(item.pendingPublishes || 0),
    failed: result.failed + Number(item.failedPublishes || 0),
  }), { connected: 0, published: 0, pending: 0, failed: 0 });
  $('#adminPlatformSummary').textContent = `${totals.connected} 个授权账号 · ${totals.published} 次发布成功`;
  $('#adminPlatformMetrics').innerHTML = platforms.map((item) => `<article class="platform-metric-card"><div class="platform-metric-head"><span class="platform-metric-icon" data-icon="${esc(icons[item.id] || '◇')}" aria-hidden="true"></span><div><strong>${esc(item.name)}</strong><small>${esc(item.totalPublishes || 0)} 次发布记录</small></div></div><div class="platform-success"><strong>${esc(item.successfulPublishes || 0)}</strong><span>发布成功</span></div><div class="platform-detail-grid"><span><strong>${esc(item.connectedAccounts || 0)}</strong><small>已授权</small></span><span><strong>${esc(item.pendingAuthorizations || 0)}</strong><small>待授权</small></span><span><strong>${esc(item.pendingPublishes || 0)}</strong><small>待确认</small></span><span><strong>${esc(item.failedPublishes || 0)}</strong><small>失败</small></span></div></article>`).join('') || '<div class="empty-state">暂无平台运营数据</div>';
}

function renderUsers() {
  const orgByUser = new Map(state.organizations.flatMap((organization) => (organization.members || []).map((member) => [member.userId, organization.name])));
  const orgRecordByUser = new Map(state.organizations.flatMap((organization) => (organization.members || []).map((member) => [member.userId, { organization, member }])));
  const agents = state.users.filter((item) => item.role === 'agent' && item.status === 'active');
  const agentById = new Map(agents.map((item) => [item.id, item]));
  const agentOptions = (user) => `<option value="">不绑定代理</option>${agents.filter((agent) => agent.id !== user.id).map((agent) => `<option value="${esc(agent.id)}" ${user.parentAgentId === agent.id ? 'selected' : ''}>${esc(agent.displayName)} · ${esc(agent.agentCode || agent.account)}</option>`).join('')}`;
  const rows = state.users.map((user) => {
    const membership = orgRecordByUser.get(user.id);
    const isAdmin = user.role === 'admin';
    const isAgent = user.role === 'agent';
    const isMember = user.accountType === 'enterprise_member';
    const accountType = isAdmin ? 'personal' : isAgent ? 'enterprise' : user.accountType;
    const accountTypeOptions = isMember
      ? '<option value="enterprise_member" selected>企业成员</option>'
      : `<option value="personal" ${accountType === 'personal' ? 'selected' : ''}>个人用户</option><option value="enterprise" ${accountType === 'enterprise' ? 'selected' : ''}>企业用户</option>`;
    const accountTypeSelect = `<select data-user-account-type aria-label="${esc(user.displayName)}的账号类型" ${isAdmin || isAgent || isMember ? 'disabled' : ''}>${accountTypeOptions}</select>`;
    const roleSelect = `<select data-user-role aria-label="${esc(user.displayName)}的系统角色" ${isMember ? 'disabled' : ''}><option value="user" ${user.role === 'user' ? 'selected' : ''}>普通账号</option><option value="agent" ${user.role === 'agent' ? 'selected' : ''}>代理</option><option value="admin" ${user.role === 'admin' ? 'selected' : ''}>管理员</option></select>`;
    const typeLabel = isAdmin ? '管理员固定使用个人账号' : isAgent ? '代理固定使用企业账号' : isMember ? '归属与使用上限由企业负责人管理' : '账号类型决定空间归属';
    const points = isMember
      ? `<strong>${esc(user.memberPointsRemaining || 0)}</strong><small>当前可用企业算力</small><small>${esc(membership?.member?.computeUsed || 0)} / ${esc(membership?.member?.computeQuota || 0)} 已用 / 累计上限</small>`
      : `<strong>${esc(user.pointsBalance || 0)}</strong><small>${user.accountType === 'enterprise' || user.role === 'agent' ? '企业总算力' : '个人算力'}</small>`;
    const adjust = isMember ? '' : `<button class="secondary-button small-button" data-adjust-points="${esc(user.id)}" data-adjust-account="${esc(user.pointsAccountType || 'personal')}">调算力</button>`;
    return `<div class="table-row user-row" data-user-row="${esc(user.id)}"><span><strong>${esc(user.displayName)}</strong><small>${esc(user.account)}${user.agentCode ? ` · ${esc(user.agentCode)}` : ''}</small></span><span class="user-account-cell">${accountTypeSelect}${roleSelect}<small>${typeLabel}</small></span><span><select data-user-parent-agent aria-label="${esc(user.displayName)}的上级代理" ${user.role !== 'agent' ? 'disabled' : ''}>${agentOptions(user)}</select><small>${user.parentAgentId ? `上级：${esc(agentById.get(user.parentAgentId)?.displayName || '代理已停用')}` : '—'}</small></span><span><select data-user-status aria-label="${esc(user.displayName)}的账号状态"><option value="active" ${user.status === 'active' ? 'selected' : ''}>正常</option><option value="disabled" ${user.status === 'disabled' ? 'selected' : ''}>停用</option></select></span><span>${points}</span><span><small>${esc(orgByUser.get(user.id) || '—')}</small></span><span class="table-actions"><button class="quiet-button" data-save-user="${esc(user.id)}">保存</button>${adjust}<button class="quiet-button" data-reset-password="${esc(user.id)}">改密码</button><button class="danger-button" data-delete-user="${esc(user.id)}">删除</button></span></div>`;
  }).join('');
  $('#userTable').innerHTML = `<div class="table-row user-row table-head"><span>用户</span><span>账号类型 / 角色</span><span>上级代理</span><span>状态</span><span>算力 / 上限</span><span>企业空间</span><span>操作</span></div>${rows}`;
  renderCustomerProfiles();
}

function renderCustomerProfiles() {
  const records = state.customers.flatMap((record) => record.projects.length ? record.projects.map((project) => ({ ...record, project })) : [{ ...record, project: null }]);
  const profileCount = records.filter((item) => item.project).length;
  $('#customerProfileCount').textContent = `${profileCount} 份档案`;
  const head = '<div class="table-row customer-profile-row table-head"><span>客户</span><span>IP 档案</span><span>门面 / 业务</span><span>客户画像 / 表达风格</span><span>归属</span><span>更新时间</span></div>';
  const rows = records.map(({ user, parentAgent, organizations, project }) => {
    const profile = project?.profile || {};
    return `<div class="table-row customer-profile-row"><span><strong>${esc(user.displayName)}</strong><small>${esc(user.account)}</small></span><span><strong>${esc(project?.name || '尚未创建')}</strong><small>${esc([project?.industry, project?.purpose].filter(Boolean).join(' · ') || '—')}</small></span><span><strong>${esc(profile.identity || '—')}</strong><small>${esc([profile.business, profile.products].filter(Boolean).join(' · ') || '未填写业务资料')}</small></span><span><strong>${esc(profile.customers || '—')}</strong><small>${esc(profile.style || '未填写表达风格')}</small></span><span><strong>${esc(organizations[0]?.name || '个人')}</strong><small>${parentAgent ? `代理：${esc(parentAgent.displayName)}` : '无代理绑定'}</small></span><span><small>${esc(dateTime(project?.updatedAt || user.updatedAt || user.createdAt))}</small></span></div>`;
  }).join('');
  $('#customerProfileTable').innerHTML = head + (rows || '<div class="empty-state">还没有客户资料</div>');
}

function renderPoints() {
  const labels = { positioning: 'IP 定位', video_analysis: '视频拆解（单次）', copy: '文案生成', chat: 'AI 对话（每次成功回复）', account_analysis: '账号级拆解（单次）', image: '图片生成', avatar_create: '形象创建', voice_clone: '声音克隆', voice_preview: '声音试听', digital_human: '数字人素材生成', talking_photo: '数字人口播生成', video: '视频成片（兼容旧配置）', videoPerMinute: '视频成片（每分钟）', video_per_minute: '视频成片（每分钟）', videoMinute: '视频成片（每分钟）', video_minute: '视频成片（每分钟）', publish: '发布包', platform_publish: '平台自动发布', assetUpload: '素材上传（每条）', asset_upload: '素材上传（每条）', backgroundMusicUpload: '我的音乐上传（每条）', background_music_upload: '我的音乐上传（每条）' };
  // Video billing is now configured per minute; keep the legacy flat video
  // price supported by the API but out of the admin form to avoid ambiguity.
  $('#taskCostGrid').innerHTML = Object.entries(state.settings.taskCosts || {})
    .filter(([key]) => key !== 'video')
    .map(([key, value]) => `<label class="field"><span>${esc(labels[key] || key)}</span><input type="number" min="0" step="1" value="${esc(value)}" data-task-cost="${esc(key)}" /></label>`).join('');
  $('#pointLedger').innerHTML = `<div class="table-row ledger-row table-head"><span>算力账户</span><span>变动</span><span>余额 / 上限</span><span>类型</span><span>原因</span><span>时间</span></div>${state.points.map((entry) => `<div class="table-row ledger-row"><span><strong>${esc(entry.organization?.name || entry.user?.displayName || '已删除用户')}</strong><small>${entry.accountType === 'member_limit' ? `成员使用上限 · ${esc(entry.user?.displayName || entry.userId)}` : entry.organizationId ? `企业算力 · 操作人 ${esc(entry.user?.displayName || entry.userId)}` : `个人算力 · ${esc(entry.user?.account || entry.userId)}`}</small></span><span class="point-delta ${entry.delta > 0 ? 'positive' : 'negative'}">${entry.delta > 0 ? '+' : ''}${esc(entry.delta)}</span><span>${esc(entry.balanceAfter)}</span><span>${esc(entry.type)}</span><span><small>${esc(entry.reason || '—')}</small></span><span><small>${esc(dateTime(entry.createdAt))}</small></span></div>`).join('')}`;
}

function renderTickets() {
  const statusOptions = [['open', '待处理'], ['processing', '处理中'], ['resolved', '已解决'], ['closed', '已关闭']];
  const head = '<div class="table-row ticket-admin-row table-head"><span>客户</span><span>工单内容</span><span>提交时间</span><span>状态 / 回复</span><span>操作</span></div>';
  const rows = state.tickets.map((ticket) => `<div class="table-row ticket-admin-row" data-admin-ticket="${esc(ticket.id)}"><span><strong>${esc(ticket.user?.displayName || '未知用户')}</strong><small>${esc(ticket.user?.account || ticket.userId)}</small></span><span><strong>${esc(ticket.subject)}</strong><small>${esc(ticket.category)}</small><small>${esc(ticket.message)}</small></span><span><small>${esc(dateTime(ticket.createdAt))}</small></span><span class="request-status-cell"><select data-ticket-status aria-label="${esc(ticket.subject)}的处理状态">${statusOptions.map(([value, label]) => `<option value="${value}" ${ticket.status === value ? 'selected' : ''}>${label}</option>`).join('')}</select><textarea data-ticket-note aria-label="${esc(ticket.subject)}的处理备注" placeholder="填写处理结果或下一步">${esc(ticket.adminNote || '')}</textarea></span><span><button class="quiet-button" data-save-ticket="${esc(ticket.id)}">保存</button></span></div>`).join('');
  $('#adminTicketTable').innerHTML = head + (rows || '<div class="empty-state">没有客服工单</div>');
}

function renderDistribution() {
  const agents = state.distribution?.agents || [];
  const levelNames = state.settings?.projectConfig?.agentLevels || ['一级代理', '二级代理'];
  $('#agentDistributionList').innerHTML = agents.length ? agents.map((agent) => `<div class="distribution-row"><span class="avatar">${esc(String(agent.displayName || '代').slice(0, 1))}</span><div><strong>${esc(agent.displayName)} · ${esc(levelNames[(agent.level || 1) - 1])}</strong><small>${esc(agent.account)} · 代理码 ${esc(agent.agentCode || '待生成')}</small><small>${agent.parentAgent ? `上级：${esc(agent.parentAgent.displayName)} · ${esc(agent.parentAgent.agentCode || agent.parentAgent.account)}` : '顶级代理'}</small></div><span>${agent.boundUsers || 0} 个下级账号</span></div>`).join('') : '<div class="empty-state">还没有代理账号</div>';
  const packages = state.settings?.projectConfig?.couponPackages || [];
  const packageSelect = $('#couponPackageInput');
  const previousPackage = packageSelect.value;
  packageSelect.innerHTML = packages.filter((item) => item.enabled).map((item) => `<option value="${esc(item.id)}">${esc(item.name)} · ¥${esc(Number(item.priceYuan).toFixed(2))} · ${esc(item.points)} 算力</option>`).join('') || '<option value="">没有可用套餐</option>';
  packageSelect.disabled = !packages.some((item) => item.enabled);
  if (packages.some((item) => item.enabled && item.id === previousPackage)) packageSelect.value = previousPackage;
  syncCouponPackage();
  const coupons = state.coupons || [];
  $('#couponTable').innerHTML = `<div class="table-row coupon-row table-head"><span>卡密</span><span>套餐 / 费用</span><span>权益</span><span>兑换进度</span><span>状态</span><span>操作</span></div>${coupons.map((coupon) => `<div class="table-row coupon-row"><span><strong>${esc(coupon.name)}</strong><small>${esc(coupon.code)}</small></span><span><strong>${esc(coupon.packageName || '自定义')}</strong><small>¥${esc(Number(coupon.priceYuan || 0).toFixed(2))}</small></span><span>${esc(coupon.points)} 算力</span><span>${coupon.redemptions?.length || 0} / ${coupon.maxRedemptions}</span><span>${coupon.status === 'active' ? '可用' : '已停用'}</span><span><button class="quiet-button" data-toggle-coupon="${esc(coupon.id)}">${coupon.status === 'active' ? '停用' : '启用'}</button></span></div>`).join('') || '<div class="empty-state">还没有创建卡密</div>'}`;
  renderCommissionSettings();
}

function syncCouponPackage() {
  const selected = (state.settings?.projectConfig?.couponPackages || []).find((item) => item.id === $('#couponPackageInput').value);
  $('#couponPriceInput').value = selected ? Number(selected.priceYuan).toFixed(2) : '';
  $('#couponPointsInput').value = selected?.points || '';
  $('#createCouponButton').disabled = !selected;
}

function renderCommissionSettings() {
  const config = state.settings?.projectConfig || {};
  const levels = config.agentLevels || ['一级代理', '二级代理'];
  const modes = [['by_payment', '按算力费用实付金额比例'], ['by_points', '按兑换算力折算金额比例'], ['disabled', '暂不参与分润']];
  const packages = config.couponPackages || [];
  $('#commissionSettings').innerHTML = `<div class="commission-rule-grid"><label class="field"><span>算力费用分润模式</span><select data-commission-setting="computeCommissionMode">${modes.map(([value, label]) => `<option value="${value}" ${config.computeCommissionMode === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label class="field"><span>分润规则说明</span><input data-commission-setting="commissionPolicy" value="${esc(config.commissionPolicy || '')}" /></label><label class="field"><span>一级代理名称</span><input data-agent-level="0" value="${esc(levels[0] || '一级代理')}" /></label><label class="field"><span>一级代理分润比例（%）</span><input data-commission-setting="firstLevelCommissionRate" type="number" min="0" max="100" step="0.01" value="${esc(config.firstLevelCommissionRate ?? 0)}" /></label><label class="field"><span>二级代理名称</span><input data-agent-level="1" value="${esc(levels[1] || '二级代理')}" /></label><label class="field"><span>二级代理分润比例（%）</span><input data-commission-setting="secondLevelCommissionRate" type="number" min="0" max="100" step="0.01" value="${esc(config.secondLevelCommissionRate ?? 0)}" /></label></div><div class="package-editor-heading"><div><strong>卡密套餐与费用</strong><small>创建卡密时从以下启用套餐中选择</small></div><button class="secondary-button small-button" type="button" id="addCouponPackageButton">添加套餐</button></div><div class="package-editor-list">${packages.map((item) => `<div class="package-editor-row" data-package-row="${esc(item.id)}"><input data-package-field="name" aria-label="套餐名称" value="${esc(item.name)}" placeholder="套餐名称" /><label><span>售价（元）</span><input data-package-field="priceYuan" aria-label="${esc(item.name)}售价" type="number" min="0" step="0.01" value="${esc(item.priceYuan)}" /></label><label><span>算力</span><input data-package-field="points" aria-label="${esc(item.name)}算力" type="number" min="1" step="1" value="${esc(item.points)}" /></label><label class="package-toggle"><input data-package-field="enabled" type="checkbox" ${item.enabled ? 'checked' : ''} />启用</label><button class="danger-button small-button" type="button" data-delete-package="${esc(item.id)}" aria-label="删除${esc(item.name)}">删除</button></div>`).join('')}</div>`;
}

function renderSettings() {
  const grouped = (state.settings.providers || []).reduce((result, item) => { (result[item.group] ||= []).push(item); return result; }, {});
  const groups = Object.entries(grouped).sort(([first], [second]) => {
    const firstRank = providerGroupOrder.indexOf(first);
    const secondRank = providerGroupOrder.indexOf(second);
    return (firstRank < 0 ? providerGroupOrder.length : firstRank) - (secondRank < 0 ? providerGroupOrder.length : secondRank);
  });
  $('#providerSettings').innerHTML = groups.map(([group, items]) => {
    const meta = providerGroupMeta[group] || { kicker: 'CAPABILITY', description: '功能接入与运行参数。' };
    return `<section class="panel provider-config-panel"><div class="panel-header"><div><div class="section-kicker">${esc(meta.kicker)}</div><h2>${esc(publicFeatureText(group))}</h2><p>${esc(publicFeatureText(meta.description))}</p></div><button class="secondary-button small-button provider-group-save" type="button" data-save-provider-settings disabled>保存全部修改</button></div><div class="provider-field-grid">${items.map((item) => { const concealed = item.secret || item.concealed; const locked = item.locked === true; const editableValue = item.secret ? '' : String(item.displayValue || ''); const statusText = locked ? '系统固定，无法修改' : item.configured ? '当前配置已生效' : '等待配置'; return `<label class="field provider-field${locked ? ' is-locked' : ''}"><span>${esc(publicFeatureText(item.label))} <small class="config-source ${item.configured ? 'configured' : ''}">${esc(item.source)}</small></span><input data-provider-key="${esc(item.key)}" data-provider-secret="${item.secret ? 'true' : 'false'}" data-provider-original="${esc(editableValue)}" type="${concealed ? 'password' : 'text'}" value="${esc(editableValue)}" placeholder="${item.secret && item.configured ? esc(item.displayValue) : '未配置'}" autocomplete="off" ${locked ? 'readonly disabled' : ''} /><small>${statusText}${!locked && item.source === '后台配置' ? ` · <button type="button" class="inline-clear" data-clear-provider="${esc(item.key)}">清除后台值</button>` : ''}</small></label>`; }).join('')}</div></section>`;
  }).join('');
  $('#providerSettings').classList.remove('is-dirty');
  $('#providerSaveStatus').textContent = '已保存';
  $('#providerSaveStatus').classList.remove('is-dirty');
}

function mediaDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function mediaSize(bytes) {
  const size = Math.max(0, Number(bytes) || 0);
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function renderBackgroundMusic() {
  const items = state.backgroundMusic || [];
  $('#backgroundMusicCount').textContent = `${items.length} 首`;
  $('#backgroundMusicAdminList').innerHTML = items.length
    ? items.map((item) => `<article class="background-music-admin-row"><div class="background-music-admin-copy"><strong title="${esc(item.name)}">${esc(item.name)}</strong><small>${mediaDuration(item.durationSeconds)} · ${mediaSize(item.sizeBytes)} · ${dateTime(item.createdAt)}</small></div><audio src="${esc(item.previewUrl)}" controls preload="metadata"></audio><button class="danger-button small-button" type="button" data-delete-background-music="${esc(item.id)}" data-background-music-name="${esc(item.name)}">删除</button></article>`).join('')
    : `<div class="empty-state">${esc(state.backgroundMusicError || '还没有背景音乐，上传后会立即出现在前台视频工坊。')}</div>`;
}

async function refreshBackgroundMusic() {
  try {
    state.backgroundMusic = await request('/api/admin/background-music');
    state.backgroundMusicError = '';
  } catch (error) {
    state.backgroundMusic = [];
    state.backgroundMusicError = error.message;
  }
  renderBackgroundMusic();
}

function adminFileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`读取 ${file.name} 失败`));
    reader.readAsDataURL(file);
  });
}

function renderProjectSettings() {
  const config = state.settings.projectConfig || {};
  $('#projectSettings').innerHTML = `<label class="field"><span>项目名称</span><input data-project-setting="projectName" value="${esc(config.projectName || '辰思AI')}" /></label><label class="field"><span>Logo 文本</span><input data-project-setting="logoText" value="${esc(config.logoText || '辰思')}" /></label><label class="field"><span>个人 IP 档案位</span><input data-project-setting="personalIpSlots" type="number" min="1" value="${esc(config.personalIpSlots || 3)}" /></label><label class="field"><span>企业默认席位</span><input data-project-setting="defaultEnterpriseSeats" type="number" min="1" value="${esc(config.defaultEnterpriseSeats || 5)}" /></label><label class="field field-span-2"><span>分润规则</span><input data-project-setting="commissionPolicy" value="${esc(config.commissionPolicy || '')}" /></label><label class="field field-span-2"><span>算力规则</span><input data-project-setting="pointsRule" value="${esc(config.pointsRule || '')}" /></label>`;
  renderCopyCheckSettings();
  renderSpeechLanguageSettings();
  renderAssistantPresetSettings();
}

function renderAssistantPresetSettings() {
  const config = state.settings?.projectConfig || {};
  const presets = config.assistantPresets || [];
  const defaultId = config.defaultAssistantPresetId || presets.find((item) => item.enabled !== false)?.id || '';
  $('#assistantPresetSettings').innerHTML = `<div class="assistant-preset-default"><label class="field"><span>默认角色</span><select data-assistant-default>${presets.filter((item) => item.enabled !== false).map((item) => `<option value="${esc(item.id)}" ${item.id === defaultId ? 'selected' : ''}>${esc(item.name)}</option>`).join('') || '<option value="">暂无启用角色</option>'}</select></label><small>用户进入 AI 对话时会优先使用该角色，仍可在工作台临时切换。</small></div><div class="assistant-preset-list">${presets.map((item) => `<article class="assistant-preset-row" data-assistant-preset="${esc(item.id)}"><div class="assistant-preset-fields"><label class="field"><span>角色名称</span><input data-assistant-field="name" value="${esc(item.name)}" maxlength="40" /></label><label class="field"><span>简短说明</span><input data-assistant-field="description" value="${esc(item.description || '')}" maxlength="200" /></label><label class="field field-span-2"><span>系统提示词</span><textarea data-assistant-field="systemPrompt" rows="4" maxlength="6000">${esc(item.systemPrompt)}</textarea></label></div><div class="assistant-preset-actions"><label class="package-toggle"><input data-assistant-field="enabled" type="checkbox" ${item.enabled !== false ? 'checked' : ''} />启用</label><button class="danger-button small-button" type="button" data-delete-assistant-preset="${esc(item.id)}">删除</button></div></article>`).join('') || '<div class="empty-state">还没有角色预设，请添加一个。</div>'}</div>`;
  window.uiSelect?.refresh(document.querySelector('[data-assistant-default]'));
}

function renderCopyCheckSettings() {
  const check = state.settings.projectConfig?.copyCheck || { originalityThreshold: 65, repeatedPhraseMinLength: 8, rules: [] };
  const rules = check.rules || [];
  $('#copyCheckSettings').innerHTML = `<div class="copy-check-thresholds"><label class="field"><span>本地文案相似度阈值（%）</span><input data-copy-threshold type="number" min="0" max="100" step="1" value="${esc(check.originalityThreshold)}" /><small>达到阈值时标记为需复核</small></label><label class="field"><span>完整重复句最短长度</span><input data-copy-phrase-length type="number" min="4" max="100" step="1" value="${esc(check.repeatedPhraseMinLength)}" /><small>按去除标点后的字符数判断</small></label></div><div class="package-editor-heading"><div><strong>违规词分类与建议</strong><small>词语可用中文逗号、英文逗号或换行分隔</small></div><button class="secondary-button small-button" type="button" id="addCopyRuleButton">添加规则</button></div><div class="rule-editor-list">${rules.map((rule) => `<div class="rule-editor-row" data-copy-rule="${esc(rule.id)}"><label><span>风险分类</span><input data-rule-field="category" value="${esc(rule.category)}" /></label><label><span>风险词</span><textarea data-rule-field="terms" rows="1">${esc((rule.terms || []).join('，'))}</textarea></label><label><span>修改建议</span><textarea data-rule-field="suggestion" rows="1">${esc(rule.suggestion || '')}</textarea></label><label class="package-toggle"><input data-rule-field="enabled" type="checkbox" ${rule.enabled !== false ? 'checked' : ''} />启用</label><button class="danger-button small-button" type="button" data-delete-copy-rule="${esc(rule.id)}">删除</button></div>`).join('')}</div>`;
}

function renderSpeechLanguageSettings() {
  const languages = state.settings.projectConfig?.speechLanguages || [];
  $('#speechLanguageSettings').innerHTML = languages.map((language) => `<label class="language-capability"><input type="checkbox" data-speech-language="${esc(language.id)}" ${language.enabled !== false ? 'checked' : ''} /><span><strong>${esc(language.label)}</strong><small>${esc(language.description || (language.mode === 'direct' ? '直接口播' : 'AI 转换后口播'))} · ${language.enabled !== false ? '已启用' : '已停用'}</small></span></label>`).join('');
}

function renderCustomRequests() {
  const statusOptions = [
    ['submitted', '待评估'], ['evaluating', '评估中'], ['approved', '方案已确认'],
    ['developing', '开发中'], ['blocked', '等待外部能力'], ['rejected', '暂不支持']
  ];
  const head = '<div class="table-row template-request-row table-head"><span>客户 / 项目</span><span>功能名称</span><span>联系方式</span><span>功能效果与交付要求</span><span>处理状态 / 备注</span><span>操作</span></div>';
  const rows = state.requests.map((item) => `<div class="table-row template-request-row" data-custom-request="${esc(item.projectId)}:${esc(item.id)}"><span><strong>${esc(item.owner?.displayName || '未知客户')}</strong><small>${esc(item.owner?.account || '—')}</small><small>${esc(item.projectName)}</small></span><span><strong>${esc(item.name)}</strong></span><span><small>${esc(item.contact || '历史记录未填写')}</small></span><span><small>${esc(item.requirement || '未填写功能效果与交付要求')}</small></span><span class="request-status-cell"><select data-request-status aria-label="${esc(item.name)}的处理状态">${statusOptions.map(([value, label]) => `<option value="${value}" ${item.status === value || (item.status === 'draft' && value === 'submitted') ? 'selected' : ''}>${label}</option>`).join('')}</select><textarea data-request-note aria-label="${esc(item.name)}的评估备注" placeholder="填写评估结论或下一步">${esc(item.adminNote || '')}</textarea></span><span><button class="quiet-button" data-save-request="${esc(item.projectId)}:${esc(item.id)}">保存</button></span></div>`).join('');
  $('#customRequestTable').innerHTML = head + (rows || '<div class="empty-state">还没有用户提交功能建议</div>');
}

function renderAudit() {
  const users = new Map(state.users.map((item) => [item.id, item]));
  $('#auditTable').innerHTML = `<div class="table-row audit-row table-head"><span>操作人</span><span>操作</span><span>对象</span><span>详情</span><span>时间</span></div>${state.audit.map((item) => `<div class="table-row audit-row"><span>${esc(users.get(item.actorId)?.displayName || item.actorId || '系统')}</span><span><strong>${esc(item.action)}</strong></span><span>${esc(item.targetType)} · ${esc(item.targetId)}</span><span><small>${esc(JSON.stringify(item.details || {}))}</small></span><span><small>${esc(dateTime(item.createdAt))}</small></span></div>`).join('')}`;
}

async function refreshUsersAndPoints() {
  [state.users, state.customers, state.points, state.distribution, state.organizations] = await Promise.all([request('/api/admin/users'), request('/api/admin/customers'), request('/api/admin/points'), request('/api/admin/distribution'), request('/api/admin/organizations')]);
  renderUsers();
  renderPoints();
  renderDistribution();
}

$$('.nav-item[data-admin-view]').forEach((button) => button.addEventListener('click', async () => {
  const view = button.dataset.adminView;
  const hasUnsavedProviderChanges = !$('#settingsAdminView')?.classList.contains('hidden') && view !== 'settings' && $('#providerSettings')?.classList.contains('is-dirty');
  go(view);
  if (hasUnsavedProviderChanges) toast('服务配置尚未保存，当前草稿已保留');
  try {
    if (view === 'tickets') {
      state.tickets = await request('/api/admin/tickets');
      renderTickets();
    } else if (view === 'distribution') {
      [state.settings, state.coupons, state.distribution] = await Promise.all([
        request('/api/admin/settings'),
        request('/api/admin/coupons'),
        request('/api/admin/distribution')
      ]);
      renderDistribution();
    } else if (view === 'points') {
      [state.settings, state.points] = await Promise.all([request('/api/admin/settings'), request('/api/admin/points')]);
      renderPoints();
    } else if (view === 'users') {
      [state.users, state.customers, state.organizations] = await Promise.all([
        request('/api/admin/users'),
        request('/api/admin/customers'),
        request('/api/admin/organizations')
      ]);
      renderUsers();
    } else if (view === 'dashboard') {
      state.dashboard = await request('/api/admin/dashboard');
      renderDashboard();
    } else if (view === 'music') {
      await refreshBackgroundMusic();
    }
  } catch (error) {
    toast(error.message);
  }
}));

$('#createUserForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#createUserButton');
  setLoading(button, true, '创建中');
  try {
    await request('/api/admin/users', { method: 'POST', body: JSON.stringify({ displayName: $('#newUserName').value, account: $('#newUserAccount').value, password: $('#newUserPassword').value, accountType: $('#newUserRole').value }) });
    $('#newUserName').value = ''; $('#newUserAccount').value = ''; $('#newUserPassword').value = '';
    await refreshUsersAndPoints();
    toast('用户已创建');
  } catch (error) { toast(error.message); } finally { setLoading(button, false); }
});

$('#uploadBackgroundMusicButton').addEventListener('click', async (event) => {
  const file = $('#backgroundMusicFileInput').files?.[0];
  if (!file) return toast('请先选择背景音乐文件');
  const extension = file.name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || '';
  const mimeType = file.type || ({ '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.opus': 'audio/opus', '.flac': 'audio/flac' }[extension] || '');
  if (!mimeType.startsWith('audio/')) return toast('只能上传支持的音频文件');
  if (file.size > 50 * 1024 * 1024) return toast('背景音乐不能超过 50 MB');
  const button = event.currentTarget;
  setLoading(button, true, '上传中');
  try {
    const data = await adminFileToDataUrl(file);
    await request('/api/admin/background-music', {
      method: 'POST',
      timeoutMs: 5 * 60_000,
      body: JSON.stringify({ name: file.name, mimeType, data }),
    });
    $('#backgroundMusicFileInput').value = '';
    await refreshBackgroundMusic();
    toast('背景音乐已上传并同步到视频工坊');
  } catch (error) {
    toast(error.message);
  } finally {
    setLoading(button, false);
  }
});

document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-delete-background-music]');
  if (!button) return;
  const confirmed = await window.uiDialog.confirm({
    title: '删除背景音乐',
    message: `删除“${button.dataset.backgroundMusicName}”后，前台将不能再选择。`,
    confirmLabel: '删除',
    danger: true,
  });
  if (!confirmed) return;
  setLoading(button, true, '删除中');
  try {
    await request(`/api/admin/background-music/${encodeURIComponent(button.dataset.deleteBackgroundMusic)}`, { method: 'DELETE' });
    await refreshBackgroundMusic();
    toast('背景音乐已删除并从视频工坊移除');
  } catch (error) {
    toast(error.message);
    setLoading(button, false);
  }
});

document.addEventListener('click', async (event) => {
  const addAssistant = event.target.closest('#addAssistantPresetButton');
  if (addAssistant) {
    const current = state.settings?.projectConfig?.assistantPresets || [];
    const next = [...current, { id: `assistant-${Date.now()}`, name: '新角色', description: '', systemPrompt: '你是一名项目助手。请结合当前项目资料，给出准确、可执行的建议。', enabled: true }];
    state.settings.projectConfig.assistantPresets = next;
    renderAssistantPresetSettings();
    document.querySelector('.assistant-preset-row:last-of-type input')?.focus();
    return;
  }
  const deleteAssistant = event.target.closest('[data-delete-assistant-preset]');
  if (deleteAssistant) {
    const current = state.settings?.projectConfig?.assistantPresets || [];
    if (current.length <= 1) return toast('至少保留一个 AI 对话角色');
    const row = deleteAssistant.closest('[data-assistant-preset]');
    state.settings.projectConfig.assistantPresets = current.filter((item) => item.id !== row.dataset.assistantPreset);
    renderAssistantPresetSettings();
    return;
  }
  const save = event.target.closest('[data-save-user]');
  if (save) {
    const row = save.closest('[data-user-row]');
    setLoading(save, true, '保存中');
    try {
      await request(`/api/admin/users/${save.dataset.saveUser}`, { method: 'PATCH', body: JSON.stringify({ accountType: row.querySelector('[data-user-account-type]').value, role: row.querySelector('[data-user-role]').value, status: row.querySelector('[data-user-status]').value, parentAgentId: row.querySelector('[data-user-parent-agent]').value || null }) });
      await refreshUsersAndPoints(); toast('用户已更新');
    } catch (error) { toast(error.message); setLoading(save, false); }
  }
  const adjust = event.target.closest('[data-adjust-points]');
  if (adjust) {
    const result = await window.uiDialog.ask({
      kicker: '算力账户调整',
      title: '调整用户算力',
      message: '个人用户调整个人算力，企业用户调整企业总算力。正数增加，负数扣除，本次操作会写入审计记录。',
      confirmText: '确认调整',
      returnFocus: adjust,
      fields: [
        { name: 'delta', label: '算力变动', type: 'number', value: '100', step: 1, integer: true, required: true, invalidMessage: '请输入非零整数', validate: (value, input) => input.valueAsNumber === 0 ? '变动不能为 0' : '' },
        { name: 'reason', label: '调整原因', value: '后台人工调整', required: true, placeholder: '说明本次调整原因' }
      ]
    });
    if (!result) return;
    const delta = Number(result.delta);
    const reason = result.reason;
    setLoading(adjust, true, '处理中');
    try {
      await request(`/api/admin/users/${adjust.dataset.adjustPoints}/points`, { method: 'POST', body: JSON.stringify({ delta, reason }) });
      await refreshUsersAndPoints(); toast('算力已调整');
    } catch (error) { toast(error.message); setLoading(adjust, false); }
  }
  const reset = event.target.closest('[data-reset-password]');
  if (reset) {
    const result = await window.uiDialog.ask({
      kicker: '账号安全',
      title: '重置用户密码',
      message: '设置至少 8 位的新密码。更新后用户需要使用新密码登录。',
      confirmText: '更新密码',
      returnFocus: reset,
      fields: [{ name: 'password', label: '新密码', type: 'password', minLength: 8, required: true, autocomplete: 'new-password', placeholder: '至少 8 位字符' }]
    });
    if (!result) return;
    const password = result.password;
    setLoading(reset, true, '处理中');
    try {
      await request(`/api/admin/users/${reset.dataset.resetPassword}`, { method: 'PATCH', body: JSON.stringify({ password }) });
      toast('密码已更新');
    } catch (error) { toast(error.message); } finally { setLoading(reset, false); }
  }
  const clear = event.target.closest('[data-clear-provider]');
  if (clear) {
    const confirmed = await window.uiDialog.confirm({
      title: '清除后台配置值',
      message: '清除后，如果服务器存在对应环境变量，系统会自动回退使用环境变量。',
      confirmText: '清除配置',
      tone: 'danger',
      returnFocus: clear
    });
    if (!confirmed) return;
    try {
      await request('/api/admin/settings/providers', { method: 'PUT', body: JSON.stringify({ values: { [clear.dataset.clearProvider]: '' } }) });
      state.settings = await request('/api/admin/settings');
      renderSettings(); toast('后台配置值已清除');
    } catch (error) { toast(error.message); }
  }
  const deleteUser = event.target.closest('[data-delete-user]');
  if (deleteUser) {
    const confirmed = await window.uiDialog.confirm({
      title: '删除用户',
      message: '账号会被软删除并立即退出所有会话，相关审计记录仍会保留。',
      confirmText: '删除用户',
      tone: 'danger',
      returnFocus: deleteUser
    });
    if (!confirmed) return;
    setLoading(deleteUser, true, '删除中');
    try {
      await request(`/api/admin/users/${deleteUser.dataset.deleteUser}`, { method: 'DELETE' });
      await refreshUsersAndPoints();
      toast('用户已删除');
    } catch (error) { toast(error.message); setLoading(deleteUser, false); }
  }
  const saveRequest = event.target.closest('[data-save-request]');
  if (saveRequest) {
    const [projectId, requestId] = saveRequest.dataset.saveRequest.split(':');
    const row = saveRequest.closest('[data-custom-request]');
    setLoading(saveRequest, true, '保存中');
    try {
      await request(`/api/admin/custom-template-requests/${projectId}/${requestId}`, { method: 'PATCH', body: JSON.stringify({ status: row.querySelector('[data-request-status]').value, adminNote: row.querySelector('[data-request-note]').value }) });
      state.requests = await request('/api/admin/custom-template-requests');
      renderCustomRequests();
      toast('许愿状态已更新');
    } catch (error) { toast(error.message); setLoading(saveRequest, false); }
  }
  const saveTicket = event.target.closest('[data-save-ticket]');
  if (saveTicket) {
    const row = saveTicket.closest('[data-admin-ticket]');
    setLoading(saveTicket, true, '保存中');
    try {
      await request(`/api/admin/tickets/${saveTicket.dataset.saveTicket}`, { method: 'PATCH', body: JSON.stringify({ status: row.querySelector('[data-ticket-status]').value, adminNote: row.querySelector('[data-ticket-note]').value }) });
      state.tickets = await request('/api/admin/tickets'); renderTickets(); toast('工单已更新');
    } catch (error) { toast(error.message); setLoading(saveTicket, false); }
  }
  const toggleCoupon = event.target.closest('[data-toggle-coupon]');
  if (toggleCoupon) {
    const coupon = state.coupons.find((item) => item.id === toggleCoupon.dataset.toggleCoupon);
    if (!coupon) return;
    setLoading(toggleCoupon, true, '更新中');
    try {
      await request(`/api/admin/coupons/${coupon.id}`, { method: 'PATCH', body: JSON.stringify({ status: coupon.status === 'active' ? 'disabled' : 'active' }) });
      state.coupons = await request('/api/admin/coupons'); renderDistribution(); toast('卡密状态已更新');
    } catch (error) { toast(error.message); setLoading(toggleCoupon, false); }
  }
});

$('#createCouponButton').addEventListener('click', async (event) => {
  const packageId = $('#couponPackageInput').value;
  const manualCode = $('#couponCodeInput').value.trim();
  const code = manualCode || generatedCouponCode();
  const points = Number($('#couponPointsInput').value);
  if (!packageId) return toast('请先配置并选择一个可用卡密套餐');
  if (!points) return toast('请先选择有效套餐');
  setLoading(event.currentTarget, true, '创建中');
  try {
    await request('/api/admin/coupons', { method: 'POST', body: JSON.stringify({ name: $('#couponNameInput').value, code, packageId, maxRedemptions: Number($('#couponMaxInput').value || 1) }) });
    $('#couponNameInput').value = ''; $('#couponCodeInput').value = ''; $('#couponMaxInput').value = '1';
    state.coupons = await request('/api/admin/coupons'); renderDistribution(); toast('卡密已创建');
  } catch (error) { toast(error.message); } finally { setLoading(event.currentTarget, false); }
});

$('#couponPackageInput').addEventListener('change', syncCouponPackage);

document.addEventListener('click', (event) => {
  if (event.target.closest('#addCouponPackageButton')) {
    state.settings.projectConfig.couponPackages.push({ id: `package_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, name: '新卡密套餐', priceYuan: 0, points: 1000, enabled: true });
    renderCommissionSettings();
  }
  const remove = event.target.closest('[data-delete-package]');
  if (remove) {
    if ((state.settings.projectConfig.couponPackages || []).length <= 1) return toast('至少保留一个卡密套餐');
    state.settings.projectConfig.couponPackages = state.settings.projectConfig.couponPackages.filter((item) => item.id !== remove.dataset.deletePackage);
    renderCommissionSettings();
  }
  if (event.target.closest('#addCopyRuleButton')) {
    state.settings.projectConfig.copyCheck.rules.push({ id: `rule_${Date.now()}`, category: '自定义风险', terms: ['待填写'], suggestion: '请人工复核并修改', enabled: true });
    renderCopyCheckSettings();
  }
  const removeRule = event.target.closest('[data-delete-copy-rule]');
  if (removeRule) {
    if ((state.settings.projectConfig.copyCheck.rules || []).length <= 1) return toast('至少保留一组违规词规则');
    state.settings.projectConfig.copyCheck.rules = state.settings.projectConfig.copyCheck.rules.filter((item) => item.id !== removeRule.dataset.deleteCopyRule);
    renderCopyCheckSettings();
  }
});

$('#saveCommissionSettingsButton').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const firstRate = Number($('[data-commission-setting="firstLevelCommissionRate"]').value);
  const secondRate = Number($('[data-commission-setting="secondLevelCommissionRate"]').value);
  if (firstRate + secondRate > 100) return toast('一级与二级代理分润比例合计不能超过 100%');
  const couponPackages = $$('[data-package-row]').map((row) => ({
    id: row.dataset.packageRow,
    name: row.querySelector('[data-package-field="name"]').value.trim(),
    priceYuan: Number(row.querySelector('[data-package-field="priceYuan"]').value),
    points: Number(row.querySelector('[data-package-field="points"]').value),
    enabled: row.querySelector('[data-package-field="enabled"]').checked
  }));
  if (couponPackages.some((item) => !item.name || !Number.isFinite(item.priceYuan) || item.priceYuan < 0 || !Number.isInteger(item.points) || item.points < 1)) return toast('请完整填写有效的套餐名称、售价和算力');
  setLoading(button, true, '保存中');
  try {
    const values = {
      computeCommissionMode: $('[data-commission-setting="computeCommissionMode"]').value,
      commissionPolicy: $('[data-commission-setting="commissionPolicy"]').value.trim(),
      firstLevelCommissionRate: firstRate,
      secondLevelCommissionRate: secondRate,
      agentLevels: $$('[data-agent-level]').map((input) => input.value.trim()),
      couponPackages
    };
    await request('/api/admin/settings/project', { method: 'PUT', body: JSON.stringify(values) });
    [state.settings, state.distribution] = await Promise.all([
      request('/api/admin/settings'),
      request('/api/admin/distribution')
    ]);
    renderDistribution();
    toast('分润配置已保存并生效');
  } catch (error) { toast(error.message); } finally { setLoading(button, false); }
});

$('#saveTaskCostsButton').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  setLoading(button, true, '保存中');
  try {
    const values = Object.fromEntries($$('[data-task-cost]').map((input) => [input.dataset.taskCost, Number(input.value)]));
    state.settings.taskCosts = await request('/api/admin/settings/task-costs', { method: 'PUT', body: JSON.stringify(values) });
    renderPoints(); toast('任务价格已保存');
  } catch (error) { toast(error.message); } finally { setLoading(button, false); }
});

async function saveProviderSettings(button) {
  const changedInputs = $$('[data-provider-key].is-dirty');
  if (!changedInputs.length) return toast('当前没有需要保存的服务配置');
  setLoading(button, true, '保存中');
  try {
    const values = {};
    changedInputs.forEach((input) => {
      values[input.dataset.providerKey] = input.value.trim();
    });
    await request('/api/admin/settings/providers', { method: 'PUT', body: JSON.stringify({ values }) });
    state.settings = await request('/api/admin/settings');
    state.dashboard = await request('/api/admin/dashboard');
    renderSettings(); renderDashboard(); toast('功能配置已保存并生效');
  } catch (error) { toast(error.message); } finally {
    setLoading(button, false);
    const isDirty = Boolean($('[data-provider-key].is-dirty'));
    $$('[data-save-provider-settings]').forEach((saveButton) => { saveButton.disabled = !isDirty; });
  }
}

document.addEventListener('input', (event) => {
  if (!event.target.matches('[data-provider-key]')) return;
  const input = event.target;
  input.classList.toggle('is-dirty', input.value !== input.dataset.providerOriginal);
  input.closest('.provider-field')?.classList.toggle('is-dirty', input.classList.contains('is-dirty'));
  const isDirty = Boolean($('[data-provider-key].is-dirty'));
  $('#providerSettings').classList.toggle('is-dirty', isDirty);
  $('#providerSaveStatus').textContent = isDirty ? '有未保存修改' : '已保存';
  $('#providerSaveStatus').classList.toggle('is-dirty', isDirty);
  $$('[data-save-provider-settings]').forEach((button) => { button.disabled = !isDirty; });
});

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-save-provider-settings]');
  if (button) saveProviderSettings(button);
});

window.addEventListener('beforeunload', (event) => {
  if (!$('#providerSettings')?.classList.contains('is-dirty')) return;
  event.preventDefault();
  event.returnValue = '';
});

$('#saveProjectSettingsButton').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  setLoading(button, true, '保存中');
  try {
    const values = Object.fromEntries($$('[data-project-setting]').map((input) => [input.dataset.projectSetting, input.type === 'number' ? Number(input.value) : input.value.trim()]));
    const originalityThreshold = Number($('[data-copy-threshold]').value);
    const repeatedPhraseMinLength = Number($('[data-copy-phrase-length]').value);
    const rules = $$('[data-copy-rule]').map((row) => ({
      id: row.dataset.copyRule,
      category: row.querySelector('[data-rule-field="category"]').value.trim(),
      terms: row.querySelector('[data-rule-field="terms"]').value.split(/[,，\n]+/).map((item) => item.trim()).filter(Boolean),
      suggestion: row.querySelector('[data-rule-field="suggestion"]').value.trim(),
      enabled: row.querySelector('[data-rule-field="enabled"]').checked
    }));
    if (!Number.isFinite(originalityThreshold) || originalityThreshold < 0 || originalityThreshold > 100) return toast('相似度阈值必须在 0% 到 100% 之间');
    if (!Number.isInteger(repeatedPhraseMinLength) || repeatedPhraseMinLength < 4 || repeatedPhraseMinLength > 100) return toast('重复句长度必须是 4 到 100 的整数');
    if (rules.some((rule) => !rule.category || !rule.terms.length)) return toast('请完整填写每组规则的分类和风险词');
    values.copyCheck = { originalityThreshold, repeatedPhraseMinLength, rules };
    values.speechLanguages = $$('[data-speech-language]').map((input) => ({ id: input.dataset.speechLanguage, enabled: input.checked }));
    const presetRows = $$('[data-assistant-preset]');
    values.assistantPresets = presetRows.map((row) => ({
      id: row.dataset.assistantPreset,
      name: row.querySelector('[data-assistant-field="name"]').value.trim(),
      description: row.querySelector('[data-assistant-field="description"]').value.trim(),
      systemPrompt: row.querySelector('[data-assistant-field="systemPrompt"]').value.trim(),
      enabled: row.querySelector('[data-assistant-field="enabled"]').checked
    }));
    values.defaultAssistantPresetId = $('[data-assistant-default]')?.value || '';
    if (!values.assistantPresets.length || values.assistantPresets.some((item) => !item.name || !item.systemPrompt)) return toast('请完整填写每个 AI 对话角色的名称和系统提示词');
    if (!values.assistantPresets.some((item) => item.enabled)) return toast('至少启用一个 AI 对话角色');
    state.settings.projectConfig = await request('/api/admin/settings/project', { method: 'PUT', body: JSON.stringify(values) });
    state.dashboard = await request('/api/admin/dashboard');
    renderProjectSettings(); renderDashboard(); toast('项目基础设置与能力规则已保存');
  } catch (error) { toast(error.message); } finally { setLoading(button, false); }
});

$('#adminLogoutButton').addEventListener('click', async () => {
  await request('/api/auth/logout', { method: 'POST', body: '{}' }).catch(() => {});
  clearAccessToken();
  window.location.replace('/login.html');
});

async function boot() {
  state.user = await request('/api/auth/me');
  if (state.user.role !== 'admin') return window.location.replace('/workspace.html');
  $('#adminName').textContent = state.user.displayName;
  $('#adminAccountName').textContent = state.user.account;
  $('#adminAccountCompute').textContent = `${state.user.pointsBalance || 0}`;
  $('#adminAvatar').textContent = String(state.user.displayName || '管').slice(0, 1);
  [state.dashboard, state.users, state.customers, state.points, state.settings, state.requests, state.audit, state.tickets, state.coupons, state.distribution, state.organizations] = await Promise.all([
    request('/api/admin/dashboard'), request('/api/admin/users'), request('/api/admin/customers'), request('/api/admin/points'), request('/api/admin/settings'), request('/api/admin/custom-template-requests'), request('/api/admin/audit'), request('/api/admin/tickets'), request('/api/admin/coupons'), request('/api/admin/distribution'), request('/api/admin/organizations')
  ]);
  renderDashboard(); renderUsers(); renderPoints(); renderSettings(); renderProjectSettings(); renderCustomRequests(); renderTickets(); renderDistribution(); renderAudit();
  await refreshBackgroundMusic();
}

boot().catch((error) => toast(error.message));
