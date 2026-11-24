import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const tickets = new Map();
const activeStatuses = new Set(['pending', 'claimed']);
const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'expired']);
const defaultTtlMs = 10 * 60_000;
const retentionMs = 60 * 60_000;

function tokenHash(value) {
  return createHash('sha256').update(String(value || '')).digest();
}

function tokenMatches(value, expected) {
  const actual = tokenHash(value);
  return Buffer.isBuffer(expected) && actual.length === expected.length && timingSafeEqual(actual, expected);
}

function cleanTickets(now = Date.now()) {
  for (const [id, ticket] of tickets) {
    const expiresAt = Date.parse(ticket.expiresAt);
    if (activeStatuses.has(ticket.status) && Number.isFinite(expiresAt) && expiresAt <= now) {
      ticket.status = 'expired';
      ticket.message = '本机操作凭证已过期，请在网页中重新操作';
      ticket.updatedAt = new Date(now).toISOString();
      ticket.completedAt = ticket.updatedAt;
    }
    const completedAt = Date.parse(ticket.completedAt || ticket.updatedAt || ticket.createdAt);
    if (terminalStatuses.has(ticket.status) && Number.isFinite(completedAt) && now - completedAt > retentionMs) tickets.delete(id);
  }
}

function ticketMessage(action, status) {
  if (status === 'pending') return action === 'bind' ? '等待本机剪映助手响应' : '等待本机剪映助手开始导入';
  if (status === 'claimed') return action === 'bind' ? '正在本机选择剪映草稿目录' : '正在本机生成剪映草稿';
  if (status === 'completed') return action === 'bind' ? '本机剪映已绑定' : '剪映草稿已导入';
  if (status === 'cancelled') return '本机操作已取消';
  if (status === 'expired') return '本机操作凭证已过期，请重试';
  return action === 'bind' ? '绑定本机剪映失败' : '导入剪映失败';
}

export function stableJianyingUserRef(userId) {
  return createHash('sha256').update(`chensi-jianying-user:${String(userId || '')}`).digest('base64url').slice(0, 24);
}

export function createJianyingCompanionTicket(input = {}, options = {}) {
  cleanTickets();
  const action = input.action === 'bind' ? 'bind' : 'import';
  const userId = String(input.userId || '').trim();
  if (!userId) throw Object.assign(new Error('剪映本机操作缺少用户身份'), { code: 'JIANYING_USER_REQUIRED', status: 400 });
  const now = Date.now();
  const ttlMs = Math.max(1, Number(options.ttlMs || defaultTtlMs));
  const id = randomUUID();
  const secret = randomBytes(32).toString('base64url');
  const token = `${id}.${secret}`;
  const ticket = {
    id,
    action,
    userId,
    userRef: stableJianyingUserRef(userId),
    displayName: String(input.displayName || '').slice(0, 100),
    projectId: input.projectId ? String(input.projectId) : null,
    outputId: input.outputId ? String(input.outputId) : null,
    tokenHash: tokenHash(token),
    status: 'pending',
    message: ticketMessage(action, 'pending'),
    progress: null,
    progressStage: null,
    deviceId: null,
    deviceName: null,
    result: null,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    completedAt: null,
  };
  tickets.set(id, ticket);
  return { ticket: publicJianyingCompanionTicket(ticket), token };
}

export function publicJianyingCompanionTicket(ticket) {
  if (!ticket) return null;
  return {
    id: ticket.id,
    action: ticket.action,
    status: ticket.status,
    message: ticket.message,
    progress: Number.isFinite(ticket.progress) ? ticket.progress : null,
    progressStage: ticket.progressStage || null,
    deviceId: ticket.deviceId,
    deviceName: ticket.deviceName,
    result: ticket.result ? { ...ticket.result } : null,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    expiresAt: ticket.expiresAt,
    completedAt: ticket.completedAt,
  };
}

export function jianyingCompanionTicketForUser(ticketId, userId) {
  cleanTickets();
  const ticket = tickets.get(String(ticketId || ''));
  if (!ticket || ticket.userId !== String(userId || '')) return null;
  return publicJianyingCompanionTicket(ticket);
}

export function claimJianyingCompanionTicket(token, device = {}) {
  cleanTickets();
  const id = String(token || '').split('.', 1)[0];
  const ticket = tickets.get(id);
  if (!ticket || !tokenMatches(token, ticket.tokenHash)) return null;
  if (ticket.status === 'expired') throw Object.assign(new Error(ticket.message), { code: 'JIANYING_TICKET_EXPIRED', status: 410 });
  if (terminalStatuses.has(ticket.status)) throw Object.assign(new Error('本机操作凭证已经使用，请从网页重新发起'), { code: 'JIANYING_TICKET_CONSUMED', status: 409 });
  const deviceId = String(device.deviceId || '').trim().slice(0, 160);
  if (!deviceId) throw Object.assign(new Error('本机剪映助手缺少设备标识'), { code: 'JIANYING_DEVICE_ID_REQUIRED', status: 400 });
  if (ticket.deviceId && ticket.deviceId !== deviceId) {
    throw Object.assign(new Error('该操作已经由另一台电脑接收'), { code: 'JIANYING_TICKET_DEVICE_MISMATCH', status: 409 });
  }
  ticket.deviceId = deviceId;
  ticket.deviceName = String(device.deviceName || 'Windows 电脑').trim().slice(0, 100) || 'Windows 电脑';
  ticket.status = 'claimed';
  ticket.message = ticketMessage(ticket.action, ticket.status);
  ticket.progress = null;
  ticket.progressStage = ticket.action === 'bind' ? '选择草稿目录' : '准备下载成片';
  ticket.updatedAt = new Date().toISOString();
  return {
    ticket,
    data: {
      id: ticket.id,
      action: ticket.action,
      userRef: ticket.userRef,
      displayName: ticket.displayName,
      projectId: ticket.projectId,
      outputId: ticket.outputId,
      expiresAt: ticket.expiresAt,
    },
  };
}

export function updateJianyingCompanionTicket(token, input = {}) {
  cleanTickets();
  const id = String(token || '').split('.', 1)[0];
  const ticket = tickets.get(id);
  if (!ticket || !tokenMatches(token, ticket.tokenHash)) return null;
  if (ticket.status !== 'claimed') throw Object.assign(new Error('本机操作没有处于处理状态'), { code: 'JIANYING_TICKET_NOT_CLAIMED', status: 409 });
  const deviceId = String(input.deviceId || '').trim();
  if (!deviceId || ticket.deviceId !== deviceId) {
    throw Object.assign(new Error('本机设备与操作凭证不匹配'), { code: 'JIANYING_TICKET_DEVICE_MISMATCH', status: 409 });
  }
  const hasProgress = input.progress !== null && input.progress !== undefined && input.progress !== '';
  const progress = Number(input.progress);
  ticket.progress = hasProgress && Number.isFinite(progress) && progress >= 0 ? Math.min(99, Math.round(progress)) : null;
  ticket.progressStage = String(input.stage || '').trim().slice(0, 100) || null;
  ticket.message = ticket.progressStage || ticket.message;
  ticket.updatedAt = new Date().toISOString();
  return publicJianyingCompanionTicket(ticket);
}

export function completeJianyingCompanionTicket(token, input = {}) {
  cleanTickets();
  const id = String(token || '').split('.', 1)[0];
  const ticket = tickets.get(id);
  if (!ticket || !tokenMatches(token, ticket.tokenHash)) return null;
  if (ticket.status === 'expired') throw Object.assign(new Error(ticket.message), { code: 'JIANYING_TICKET_EXPIRED', status: 410 });
  if (ticket.status !== 'claimed') throw Object.assign(new Error('本机操作没有处于可完成状态'), { code: 'JIANYING_TICKET_NOT_CLAIMED', status: 409 });
  const deviceId = String(input.deviceId || '').trim();
  if (!deviceId || ticket.deviceId !== deviceId) {
    throw Object.assign(new Error('本机设备与操作凭证不匹配'), { code: 'JIANYING_TICKET_DEVICE_MISMATCH', status: 409 });
  }
  const success = input.success === true;
  ticket.status = success ? 'completed' : input.cancelled === true ? 'cancelled' : 'failed';
  ticket.message = String(input.message || input.error || ticketMessage(ticket.action, ticket.status)).slice(0, 300);
  ticket.result = {
    draftName: String(input.draftName || '').slice(0, 160) || null,
    durationSeconds: Math.max(0, Number(input.durationSeconds || 0)),
    subtitleCount: Math.max(0, Math.trunc(Number(input.subtitleCount || 0))),
    library: String(input.library || '').slice(0, 80) || null,
    libraryVersion: String(input.libraryVersion || '').slice(0, 40) || null,
  };
  ticket.progress = success ? 100 : null;
  ticket.progressStage = success ? ticketMessage(ticket.action, ticket.status) : null;
  ticket.updatedAt = new Date().toISOString();
  ticket.completedAt = ticket.updatedAt;
  return { ticket, data: publicJianyingCompanionTicket(ticket) };
}

export function jianyingCompanionTicketForContent(ticketId, token) {
  cleanTickets();
  const ticket = tickets.get(String(ticketId || ''));
  if (!ticket || ticket.action !== 'import' || ticket.status !== 'claimed' || !tokenMatches(token, ticket.tokenHash)) return null;
  return ticket;
}

export function cancelJianyingCompanionTicket(ticketId, userId) {
  cleanTickets();
  const ticket = tickets.get(String(ticketId || ''));
  if (!ticket || ticket.userId !== String(userId || '')) return null;
  if (activeStatuses.has(ticket.status)) {
    ticket.status = 'cancelled';
    ticket.message = ticketMessage(ticket.action, ticket.status);
    ticket.updatedAt = new Date().toISOString();
    ticket.completedAt = ticket.updatedAt;
  }
  return publicJianyingCompanionTicket(ticket);
}

export function protocolUrlForJianyingTicket(apiBaseUrl, token) {
  const base = new URL(String(apiBaseUrl || ''));
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('剪映本机助手服务地址无效');
  base.pathname = base.pathname.replace(/\/$/, '');
  base.search = '';
  base.hash = '';
  return `chensi-jianying://run?server=${encodeURIComponent(base.toString().replace(/\/$/, ''))}&token=${encodeURIComponent(token)}`;
}
