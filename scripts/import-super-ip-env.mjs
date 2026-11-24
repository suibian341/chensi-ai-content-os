import { promises as fs } from 'node:fs';
import path from 'node:path';

const sourcePath = process.argv[2];
const destinationPath = path.resolve(process.argv[3] || 'backend/.env');

if (!sourcePath) {
  console.error('用法：node scripts/import-super-ip-env.mjs <历史项目 .env 路径> [目标 .env 路径]');
  process.exitCode = 1;
} else {
  const mappings = {
    VOLCENGINE_ARK_BASE_URL: 'IP_AGENT_LLM_BASE_URL',
    VOLCENGINE_ARK_API_KEY: 'IP_AGENT_LLM_API_KEY',
    VOLCENGINE_ARK_MODEL: 'IP_AGENT_LLM_MODEL',
    VOLCENGINE_TTS_API_KEY: 'IP_AGENT_VOLCENGINE_VOICE_API_KEY',
    VOLCENGINE_VOICE_CLONE_ENDPOINT: 'IP_AGENT_VOLCENGINE_VOICE_CLONE_ENDPOINT',
    VOLCENGINE_VOICE_STATUS_ENDPOINT: 'IP_AGENT_VOLCENGINE_VOICE_STATUS_ENDPOINT',
    VOLCENGINE_VOICE_CLONE_LANGUAGE: 'IP_AGENT_VOLCENGINE_VOICE_LANGUAGE',
    VOLCENGINE_VOICE_DEMO_TEXT: 'IP_AGENT_VOLCENGINE_VOICE_DEMO_TEXT',
    VOLCENGINE_VOICE_SAMPLE_MAX_BYTES: 'IP_AGENT_VOLCENGINE_VOICE_MAX_BYTES',
    SKYHUMAN_API_BASE_URL: 'IP_AGENT_SKYHUMAN_BASE_URL',
    SKYHUMAN_API_TOKEN: 'IP_AGENT_SKYHUMAN_API_TOKEN'
  };

  function parse(content) {
    const values = new Map();
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      else value = value.replace(/\s+#.*$/, '').trim();
      values.set(match[1], value);
    }
    return values;
  }

  const source = parse(await fs.readFile(path.resolve(sourcePath), 'utf8'));
  const existing = await fs.readFile(destinationPath, 'utf8').then(parse).catch(() => new Map());
  const imported = [];
  for (const [sourceName, destinationName] of Object.entries(mappings)) {
    const value = source.get(sourceName);
    if (!value || existing.get(destinationName)) continue;
    existing.set(destinationName, value);
    imported.push(destinationName);
  }
  const lines = [...existing.entries()].map(([name, value]) => `${name}=${JSON.stringify(value)}`);
  await fs.writeFile(destinationPath, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  console.log(`已迁移 ${imported.length} 项配置：${imported.join(', ') || '无新增项'}`);
}
