import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildJianyingWebPackage } from './jianying.js';

const exportsById = new Map();
const readyTtlMs = 2 * 60 * 60_000;
const failedTtlMs = 15 * 60_000;

function publicExport(record) {
  if (!record) return null;
  return {
    id: record.id,
    status: record.status,
    stage: record.stage,
    error: record.error,
    errorCode: record.errorCode,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
    manifest: record.status === 'ready' ? {
      ...record.package.manifest,
      id: record.id,
      sourcePaths: record.package.sourcePaths,
      expiresAt: record.expiresAt
    } : null
  };
}

async function removePackage(record) {
  if (!record?.package?.packageRoot) return;
  const packageRoot = record.package.packageRoot;
  record.package = null;
  await fs.rm(packageRoot, { recursive: true, force: true }).catch(() => {});
}

function cleanExpired() {
  const now = Date.now();
  for (const [id, record] of exportsById) {
    if (Date.parse(record.expiresAt || '') > now) continue;
    record.status = 'expired';
    exportsById.delete(id);
    void removePackage(record);
  }
}

async function prepare(record, output, project) {
  try {
    const prepared = await buildJianyingWebPackage(output, project, {
      onStage(stage) {
        if (record.status !== 'preparing') return;
        record.stage = String(stage || '准备剪映草稿');
        record.updatedAt = new Date().toISOString();
      }
    });
    if (record.status !== 'preparing') {
      await fs.rm(prepared.packageRoot, { recursive: true, force: true }).catch(() => {});
      return;
    }
    record.package = prepared;
    record.status = 'ready';
    record.stage = '清单已就绪';
    record.updatedAt = new Date().toISOString();
    record.expiresAt = new Date(Date.now() + readyTtlMs).toISOString();
  } catch (error) {
    record.status = 'failed';
    record.stage = '草稿清单生成失败';
    record.error = String(error?.message || error || '剪映草稿清单生成失败').slice(0, 500);
    record.errorCode = String(error?.code || 'JIANYING_WEB_EXPORT_FAILED');
    record.updatedAt = new Date().toISOString();
    record.expiresAt = new Date(Date.now() + failedTtlMs).toISOString();
  }
}

export function startJianyingWebExport({ userId, project, output }) {
  cleanExpired();
  const normalizedUserId = String(userId || '');
  const normalizedOutputId = String(output?.id || '');
  const reusable = [...exportsById.values()].find((item) => item.userId === normalizedUserId
    && item.outputId === normalizedOutputId && ['preparing', 'ready'].includes(item.status));
  if (reusable) return publicExport(reusable);
  const userRecords = [...exportsById.values()]
    .filter((item) => item.userId === normalizedUserId)
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  while (userRecords.length >= 3) {
    const oldest = userRecords.shift();
    oldest.status = 'cancelled';
    exportsById.delete(oldest.id);
    void removePackage(oldest);
  }
  const allRecords = [...exportsById.values()].sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  while (allRecords.length >= 30) {
    const oldest = allRecords.shift();
    oldest.status = 'cancelled';
    exportsById.delete(oldest.id);
    void removePackage(oldest);
  }
  const now = new Date().toISOString();
  const record = {
    id: randomUUID(),
    userId: normalizedUserId,
    projectId: String(project?.id || ''),
    outputId: normalizedOutputId,
    status: 'preparing',
    stage: '准备剪映草稿',
    error: null,
    errorCode: null,
    package: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.now() + readyTtlMs).toISOString()
  };
  exportsById.set(record.id, record);
  void prepare(record, output, project);
  return publicExport(record);
}

export function jianyingWebExportForUser(id, userId) {
  cleanExpired();
  const record = exportsById.get(String(id || ''));
  if (!record || record.userId !== String(userId || '')) return null;
  return publicExport(record);
}

export function jianyingWebExportFileForUser(id, userId, rel) {
  cleanExpired();
  const record = exportsById.get(String(id || ''));
  if (!record || record.userId !== String(userId || '') || record.status !== 'ready' || !record.package) return null;
  const normalizedRel = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const file = record.package.files.get(normalizedRel);
  if (!file) return null;
  const resolved = path.resolve(file.filePath);
  const draftRoot = path.resolve(record.package.draftPath);
  if (resolved !== draftRoot && !resolved.startsWith(`${draftRoot}${path.sep}`)) return null;
  return { ...file, filePath: resolved };
}

export async function finishJianyingWebExport(id, userId, { cancelled = false } = {}) {
  cleanExpired();
  const record = exportsById.get(String(id || ''));
  if (!record || record.userId !== String(userId || '')) return null;
  record.status = cancelled ? 'cancelled' : 'completed';
  record.stage = cancelled ? '已取消' : '已导入剪映';
  record.updatedAt = new Date().toISOString();
  record.expiresAt = record.updatedAt;
  exportsById.delete(record.id);
  await removePackage(record);
  return publicExport(record);
}
