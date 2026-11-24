import { networkInterfaces } from 'node:os';

const virtualInterfacePattern = /loopback|virtual|vmware|vbox|hyper-v|vethernet|wsl|docker|tailscale|zerotier/i;

function formatHostname(hostname) {
  return hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
}

export function lanAddresses(interfaces = networkInterfaces()) {
  const addresses = [];
  const physicalAddresses = [];

  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      const ipv4 = entry.family === 'IPv4' || entry.family === 4;
      if (!ipv4 || entry.internal || !entry.address) continue;
      addresses.push(entry.address);
      if (!virtualInterfacePattern.test(name)) physicalAddresses.push(entry.address);
    }
  }

  return [...new Set(physicalAddresses.length ? physicalAddresses : addresses)];
}

export function serviceUrls({ port, host, protocol = 'http', interfaces } = {}) {
  const bindHost = String(host || '').trim() || '0.0.0.0';
  const wildcard = bindHost === '0.0.0.0' || bindHost === '::' || bindHost === '[::]';
  if (!wildcard) return { local: `${protocol}://${formatHostname(bindHost)}:${port}`, network: [] };

  return {
    local: `${protocol}://localhost:${port}`,
    network: lanAddresses(interfaces).map((address) => `${protocol}://${formatHostname(address)}:${port}`)
  };
}

export function logServiceUrls(name, options) {
  const urls = serviceUrls(options);
  console.log(`${name} running at`);
  console.log(`  Local:   ${urls.local}`);
  for (const url of urls.network) console.log(`  Network: ${url}`);
  if (!urls.network.length && String(options?.host || '') === '0.0.0.0') {
    console.log('  Network: no active LAN IPv4 address detected');
  }
}
