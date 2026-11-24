import { createRenderService } from './src/server.js';
import { getProviderConfig } from './src/providers/config.js';
import { serviceAccessUrls } from './src/lib/network.js';

const config = getProviderConfig();
if (!config.service.apiKeys.length) {
  console.error('VIDEO_RENDER_API_KEY or VIDEO_RENDER_API_KEYS must be configured');
  process.exitCode = 1;
} else {
  const server = createRenderService({ config });
  server.listen(config.service.port, config.service.host, () => {
    const accessUrls = serviceAccessUrls({ host: config.service.host, port: config.service.port });
    console.log(`[video-render] ${new Date().toISOString()} INFO service.ready bind="${config.service.host}:${config.service.port}" queueConcurrency=${config.service.queueConcurrency} timeoutMs=${config.service.jobTimeoutMs}`);
    for (const item of accessUrls) console.log(`[video-render] ${new Date().toISOString()} INFO service.access scope=${item.scope} url="${item.url}"`);
    console.log(`[video-render] ${new Date().toISOString()} INFO service.capabilities media=${config.media.enabled} transcription=${config.videoEngine.enabled} storage="${config.storage.root}"`);
  });
  const close = () => {
    console.log(`[video-render] ${new Date().toISOString()} INFO service.stopping`);
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
