import { spawn } from 'node:child_process';

const services = [
  { name: 'API', child: spawn(process.execPath, ['backend/server.js'], { stdio: 'inherit', windowsHide: true }) },
  { name: 'Web', child: spawn(process.execPath, ['web/server.js'], { stdio: 'inherit', windowsHide: true }) }
];

let stopping = false;
function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const service of services) service.child.kill();
  process.exitCode = exitCode;
}

for (const service of services) {
  service.child.once('error', (error) => {
    console.error(`[${service.name}] 启动失败：${error.message}`);
  });
  service.child.once('exit', (code, signal) => {
    if (stopping) return;
    const reason = signal ? `收到 ${signal}` : `退出码 ${code ?? 0}`;
    console.error(`[${service.name}] 服务已停止（${reason}）。如果是端口占用，请检查 API_PORT/WEB_PORT。`);
    stop(code || 1);
  });
}

process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
