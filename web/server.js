import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logServiceUrls } from '../scripts/network-urls.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const vendorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'gsap', 'dist');
const port = Number(process.env.WEB_PORT || 4273);
const host = String(process.env.WEB_HOST || '0.0.0.0').trim() || '0.0.0.0';
const apiBaseUrl = String(process.env.WEB_API_BASE_URL || '').trim().replace(/\/$/, '');
const apiProxyHost = String(process.env.WEB_API_PROXY_HOST || '127.0.0.1').trim() || '127.0.0.1';
const apiProxyPort = Number(process.env.WEB_API_PROXY_PORT || 4280);
const extraConnectSources = String(process.env.WEB_CSP_CONNECT_SRC || '').trim().split(/\s+/).filter(Boolean);
const providerSettingsPath = path.resolve(process.env.IP_AGENT_PROVIDER_SETTINGS_FILE || path.join(root, '..', '..', 'backend', 'data', 'provider-settings.json'));
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function configuredStorageSources() {
  let overrides = {};
  try { overrides = JSON.parse(readFileSync(providerSettingsPath, 'utf8')) || {}; } catch {}
  const deployment = {};
  for (const envPath of [path.join(root, '..', '..', 'backend', '.env'), path.join(root, '..', '..', '.env')]) {
    try {
      for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const match = line.match(/^\s*(ALIYUN_(?:OSS_(?:ENDPOINT|PUBLIC_ENDPOINT)|CDN_DOMAIN))\s*=\s*(.*?)\s*$/);
        if (match) deployment[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
      }
    } catch {}
  }
  const configured = (name) => String(overrides[name] || process.env[name] || deployment[name] || '').trim();
  const sources = new Set(['https://*.aliyuncs.com']);
  for (const raw of [configured('ALIYUN_OSS_ENDPOINT'), configured('ALIYUN_OSS_PUBLIC_ENDPOINT'), configured('ALIYUN_CDN_DOMAIN')]) {
    if (!raw) continue;
    try {
      const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      sources.add(url.origin);
    } catch {}
  }
  return [...sources];
}

function securityHeaders(req) {
  const hostname = String(req.headers.host || 'localhost').split(':')[0].replace(/[^a-zA-Z0-9.:[\]-]/g, '') || 'localhost';
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const isTrustedOrigin = forwardedProto === 'https' || hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  const apiSources = apiBaseUrl ? [apiBaseUrl] : [`http://${hostname}:4280`, `https://${hostname}:4280`];
  const storageSources = configuredStorageSources();
  const connectSources = ["'self'", ...apiSources, ...storageSources, ...extraConnectSources].join(' ');
  const headers = {
    'Content-Security-Policy': `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: ${apiSources.join(' ')}; media-src 'self' blob: ${apiSources.join(' ')} ${storageSources.join(' ')}; connect-src ${connectSources}`,
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  };
  // COOP is only honored on potentially trustworthy origins. Omitting it for
  // an HTTP LAN preview avoids a misleading browser warning while preserving
  // the isolation policy on localhost and HTTPS deployments.
  if (isTrustedOrigin) headers['Cross-Origin-Opener-Policy'] = 'same-origin';
  return headers;
}

function proxyApiRequest(req, res, url, secureHeaders) {
  return new Promise((resolve) => {
    const forwardedHeaders = { ...req.headers };
    // Keep the public host so the API can validate same-origin browser requests
    // and generate links that point back through the tunnel.
    forwardedHeaders.host = req.headers.host || `${apiProxyHost}:${apiProxyPort}`;
    forwardedHeaders['x-forwarded-host'] = req.headers.host || forwardedHeaders.host;
    forwardedHeaders['x-forwarded-proto'] = String(req.headers['x-forwarded-proto'] || 'http');
    const priorForwardedFor = String(req.headers['x-forwarded-for'] || '').trim();
    const remoteAddress = String(req.socket.remoteAddress || '').trim();
    forwardedHeaders['x-forwarded-for'] = [priorForwardedFor, remoteAddress].filter(Boolean).join(', ');

    const upstream = http.request({
      host: apiProxyHost,
      port: apiProxyPort,
      method: req.method,
      path: `${url.pathname}${url.search}`,
      headers: forwardedHeaders,
    }, (upstreamResponse) => {
      const responseHeaders = { ...upstreamResponse.headers, ...secureHeaders };
      res.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
      upstreamResponse.pipe(res);
      upstreamResponse.once('end', resolve);
    });
    upstream.once('error', (error) => {
      if (!res.headersSent) {
        res.writeHead(502, {
          ...secureHeaders,
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({
          ok: false,
          error: 'API service is unavailable',
          code: 'API_PROXY_UNAVAILABLE',
          details: error.message,
        }));
      } else {
        res.destroy(error);
      }
      resolve();
    });
    req.once('aborted', () => upstream.destroy());
    res.once('close', () => {
      if (!res.writableEnded) upstream.destroy();
    });
    req.pipe(upstream);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const secureHeaders = securityHeaders(req);
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    await proxyApiRequest(req, res, url, secureHeaders);
    return;
  }
  if (url.pathname === '/runtime-config.js') {
    res.writeHead(200, { ...secureHeaders, 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`window.CHENSI_API_BASE_URL = ${JSON.stringify(apiBaseUrl)};`);
    return;
  }
  if (url.pathname === '/favicon.ico') {
    res.writeHead(204, { ...secureHeaders, 'Cache-Control': 'public, max-age=86400' });
    res.end();
    return;
  }
  // GSAP is installed locally so animation remains self-hosted under the strict CSP.
  if (url.pathname === '/vendor/gsap.min.js' || url.pathname === '/vendor/ScrollTrigger.min.js') {
    const vendorFile = path.resolve(vendorRoot, path.basename(url.pathname));
    try {
      const content = await fs.readFile(vendorFile);
      const cacheControl = url.searchParams.has('v')
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=86400, immutable';
      res.writeHead(200, { ...secureHeaders, 'Content-Type': mimeTypes['.js'], 'Cache-Control': cacheControl });
      res.end(content);
    } catch {
      res.writeHead(404, { ...secureHeaders, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    }
    return;
  }
  const requested = url.pathname === '/' ? '/index.html' : url.pathname === '/workspace' ? '/workspace.html' : url.pathname;
  const relative = path.normalize(requested).replace(/^([.][.][\\/])+/, '').replace(/^[\\/]+/, '');
  const filePath = path.resolve(root, relative);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    res.writeHead(403, secureHeaders).end();
    return;
  }
  try {
    const content = await fs.readFile(filePath);
    const hasVersion = url.searchParams.has('v');
    const extension = path.extname(filePath);
    const isAppCode = extension === '.js' || extension === '.css';
    const cacheControl = extension === '.html'
      ? 'no-store'
      : isAppCode
        ? hasVersion
          ? 'public, max-age=31536000, immutable'
          : 'no-cache'
        : hasVersion
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=300';
    const etag = isAppCode ? `"${createHash('sha256').update(content).digest('base64url')}"` : null;
    const responseHeaders = {
      ...secureHeaders,
      'Content-Type': mimeTypes[extension] || 'application/octet-stream',
      'Cache-Control': cacheControl,
      ...(etag ? { ETag: etag } : {})
    };
    if (etag && req.headers['if-none-match'] === etag) {
      res.writeHead(304, responseHeaders);
      res.end();
      return;
    }
    res.writeHead(200, {
      ...responseHeaders
    });
    res.end(content);
  } catch {
    res.writeHead(404, { ...secureHeaders, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
});

server.listen(port, host, () => {
  logServiceUrls('Chensi Web', { port, host });
});
