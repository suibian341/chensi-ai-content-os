import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = path.resolve(process.env.IP_AGENT_DATA_DIR || path.join(projectRoot, 'runtime-data'));
const storeFile = path.join(dataDir, 'store.json');
const envFile = path.join(projectRoot, 'backend', '.env');
const credentialFile = path.join(projectRoot, '后端调用凭证.env');

function setEnvValue(content, name, value) {
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, 'm');
  if (pattern.test(content)) return content.replace(pattern, line);
  return `${content.replace(/\s*$/, '')}\n${line}\n`;
}

async function atomicWrite(file, content, mode) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, content, { encoding: 'utf8', mode });
  await fs.rename(temp, file);
  await fs.chmod(file, mode).catch(() => {});
}

const store = JSON.parse(await fs.readFile(storeFile, 'utf8'));
const admins = (store.users || []).filter((user) => user.role === 'admin' && user.status === 'active' && !user.deletedAt);
if (admins.length !== 1) {
  throw new Error(`Expected exactly one active admin account, found ${admins.length}.`);
}

const key = `chensi_live_${randomBytes(32).toString('base64url')}`;
const hash = createHash('sha256').update(key).digest('hex');
let env = await fs.readFile(envFile, 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error));
env = setEnvValue(env, 'IP_AGENT_BACKEND_API_KEY_SHA256', hash);
env = setEnvValue(env, 'IP_AGENT_BACKEND_API_USER_ID', admins[0].id);
await atomicWrite(envFile, env, 0o600);

const credential = [
  '# Backend API credential - keep secret',
  'BACKEND_API_BASE=http://localhost:4280/api/v1',
  `BACKEND_API_KEY=${key}`,
  'BACKEND_API_AUTH_HEADER=X-API-Key',
  ''
].join('\n');
await atomicWrite(credentialFile, credential, 0o600);

console.log(JSON.stringify({
  configured: true,
  userId: admins[0].id,
  fingerprint: hash.slice(0, 12),
  credentialFile: path.basename(credentialFile)
}));
