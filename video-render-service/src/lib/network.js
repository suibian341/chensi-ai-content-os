import { networkInterfaces } from 'node:os';

function formatHost(host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

export function serviceAccessUrls({ host, port, interfaces = networkInterfaces() }) {
  const wildcard = host === '0.0.0.0' || host === '::' || host === '::0';
  if (!wildcard) return [{ scope: 'configured', url: `http://${formatHost(host)}:${port}` }];

  const urls = [{ scope: 'local', url: `http://127.0.0.1:${port}` }];
  const seen = new Set(urls.map((item) => item.url));
  for (const records of Object.values(interfaces || {})) {
    for (const record of records || []) {
      const family = typeof record.family === 'string' ? record.family : record.family === 4 ? 'IPv4' : '';
      if (family !== 'IPv4' || record.internal || !record.address) continue;
      const url = `http://${record.address}:${port}`;
      if (seen.has(url)) continue;
      seen.add(url);
      urls.push({ scope: 'lan', url });
    }
  }
  return urls;
}
