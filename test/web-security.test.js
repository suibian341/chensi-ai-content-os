import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { promises as fs } from 'node:fs';

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test('web server emits browser security headers and does not persist bearer tokens', async (t) => {
  const port = await freePort();
  const child = spawn(process.execPath, ['web/server.js'], {
    cwd: path.resolve('.'),
    env: { ...process.env, WEB_HOST: '127.0.0.1', WEB_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('web server start timeout')), 5_000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('running at')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => reject(new Error(`web server exited ${code}`)));
  });

  const response = await fetch(`http://127.0.0.1:${port}/login.html`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(response.headers.get('content-security-policy'), /img-src[^;]*https:/);
  assert.equal(response.headers.get('cache-control'), 'no-store');

  const homeResponse = await fetch(`http://127.0.0.1:${port}/`);
  const homeSource = await homeResponse.text();
  assert.equal(homeResponse.status, 200);
  assert.match(homeSource, /<h1 id="homeTitle">辰思 AI<\/h1>/);
  assert.match(homeSource, /href="\/workspace\.html">进入工作台/);

  const workspaceResponse = await fetch(`http://127.0.0.1:${port}/workspace`);
  const workspaceSource = await workspaceResponse.text();
  assert.equal(workspaceResponse.status, 200);
  assert.match(workspaceSource, /class="brand-lockup workspace-home-link" href="\/"/);

  const configSource = await fs.readFile('web/public/config.js', 'utf8');
  assert.doesNotMatch(configSource, /localStorage\.(?:setItem|getItem)/);
  assert.match(configSource, /localStorage\.removeItem/);
});
