import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cancelJianyingCompanionTicket,
  claimJianyingCompanionTicket,
  completeJianyingCompanionTicket,
  createJianyingCompanionTicket,
  jianyingCompanionTicketForContent,
  jianyingCompanionTicketForUser,
  protocolUrlForJianyingTicket,
  stableJianyingUserRef,
  updateJianyingCompanionTicket
} from '../backend/providers/jianying-companion.js';

test('Jianying companion ticket is isolated by user and device', () => {
  const created = createJianyingCompanionTicket({
    action: 'import',
    userId: 'user-a',
    displayName: '用户 A',
    projectId: 'project-a',
    outputId: 'output-a'
  });

  assert.equal(created.ticket.status, 'pending');
  assert.equal('userId' in created.ticket, false);
  assert.equal('userRef' in created.ticket, false);
  assert.equal('tokenHash' in created.ticket, false);
  assert.equal(JSON.stringify(created.ticket).includes('draftRoot'), false);
  assert.equal(jianyingCompanionTicketForUser(created.ticket.id, 'user-b'), null);
  assert.equal(jianyingCompanionTicketForUser(created.ticket.id, 'user-a').id, created.ticket.id);
  assert.equal(claimJianyingCompanionTicket('wrong-token', { deviceId: 'device-a' }), null);

  const claimed = claimJianyingCompanionTicket(created.token, { deviceId: 'device-a', deviceName: '电脑 A' });
  assert.equal(claimed.data.userRef, stableJianyingUserRef('user-a'));
  assert.equal(claimed.data.outputId, 'output-a');
  assert.equal(jianyingCompanionTicketForContent(created.ticket.id, created.token).deviceId, 'device-a');
  assert.throws(
    () => claimJianyingCompanionTicket(created.token, { deviceId: 'device-b' }),
    (error) => error.code === 'JIANYING_TICKET_DEVICE_MISMATCH'
  );
  assert.throws(
    () => completeJianyingCompanionTicket(created.token, { deviceId: 'device-b', success: true }),
    (error) => error.code === 'JIANYING_TICKET_DEVICE_MISMATCH'
  );
  assert.throws(
    () => updateJianyingCompanionTicket(created.token, { deviceId: 'device-b', stage: '下载成片', progress: 50 }),
    (error) => error.code === 'JIANYING_TICKET_DEVICE_MISMATCH'
  );
  const progress = updateJianyingCompanionTicket(created.token, { deviceId: 'device-a', stage: '下载成片', progress: 42 });
  assert.equal(progress.progress, 42);
  assert.equal(progress.progressStage, '下载成片');
  const indeterminate = updateJianyingCompanionTicket(created.token, { deviceId: 'device-a', stage: '生成剪映草稿', progress: null });
  assert.equal(indeterminate.progress, null);

  const completed = completeJianyingCompanionTicket(created.token, {
    deviceId: 'device-a',
    success: true,
    draftName: '测试草稿',
    draftPath: 'C:\\Users\\secret\\Drafts'
  });
  assert.equal(completed.data.status, 'completed');
  assert.equal(completed.data.result.draftName, '测试草稿');
  assert.equal('draftPath' in completed.data.result, false);
  assert.equal(jianyingCompanionTicketForContent(created.ticket.id, created.token), null);
  assert.throws(
    () => completeJianyingCompanionTicket(created.token, { deviceId: 'device-a', success: true }),
    (error) => error.code === 'JIANYING_TICKET_NOT_CLAIMED'
  );
});

test('Jianying companion tickets can be cancelled and expire', async () => {
  const cancelled = createJianyingCompanionTicket({ action: 'bind', userId: 'cancel-user' });
  assert.equal(cancelJianyingCompanionTicket(cancelled.ticket.id, 'other-user'), null);
  assert.equal(cancelJianyingCompanionTicket(cancelled.ticket.id, 'cancel-user').status, 'cancelled');
  assert.throws(
    () => claimJianyingCompanionTicket(cancelled.token, { deviceId: 'device-a' }),
    (error) => error.code === 'JIANYING_TICKET_CONSUMED'
  );

  const expired = createJianyingCompanionTicket({ action: 'bind', userId: 'expired-user' }, { ttlMs: 2 });
  await new Promise((resolve) => setTimeout(resolve, 8));
  assert.throws(
    () => claimJianyingCompanionTicket(expired.token, { deviceId: 'device-a' }),
    (error) => error.code === 'JIANYING_TICKET_EXPIRED'
  );
});

test('Jianying user references and protocol links are stable and encoded', () => {
  assert.equal(stableJianyingUserRef('same-user'), stableJianyingUserRef('same-user'));
  assert.notEqual(stableJianyingUserRef('same-user'), stableJianyingUserRef('other-user'));
  const url = protocolUrlForJianyingTicket('https://example.test/', 'ticket.value+/=');
  assert.equal(url, 'chensi-jianying://run?server=https%3A%2F%2Fexample.test&token=ticket.value%2B%2F%3D');
});
