import test from 'node:test';
import assert from 'node:assert/strict';
import { lanAddresses, serviceUrls } from '../scripts/network-urls.mjs';

const interfaces = {
  'vEthernet (WSL)': [{ address: '172.29.16.1', family: 'IPv4', internal: false }],
  'WLAN 3': [{ address: '192.168.0.98', family: 'IPv4', internal: false }],
  Loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true }]
};

test('LAN URLs prefer physical adapters and include the wildcard listener port', () => {
  assert.deepEqual(lanAddresses(interfaces), ['192.168.0.98']);
  assert.deepEqual(serviceUrls({ host: '0.0.0.0', port: 4273, interfaces }), {
    local: 'http://localhost:4273',
    network: ['http://192.168.0.98:4273']
  });
});

test('an explicit host only reports that host', () => {
  assert.deepEqual(serviceUrls({ host: '127.0.0.1', port: 4280, interfaces }), {
    local: 'http://127.0.0.1:4280',
    network: []
  });
});
