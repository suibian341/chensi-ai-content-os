import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('D:/suibian/Documents/media-api-console/node_modules/playwright-core');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find((candidate) => candidate.url().includes('workspace.html'));
await page.setViewportSize({ width: 1280, height: 800 });
await page.goto('http://localhost:4273/workspace.html', { waitUntil: 'networkidle' });
for (const view of ['overview','copy','media','render','account']) {
  await page.locator(`.nav-item[data-view="${view}"]`).click();
  await page.waitForTimeout(250);
  const rows = await page.evaluate(() => [...document.querySelectorAll('.content-view:not(.hidden) *')].map((el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    if (r.width < 20 || r.height < 15 || r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) return null;
    const m = s.backgroundColor.match(/rgba?\([^)]*[, ]([0-9.]+)\)/);
    const alpha = m ? Number(m[1]) : (s.backgroundColor.startsWith('rgb') ? 1 : 0);
    if (alpha < 0.3) return null;
    return { cls: typeof el.className === 'string' ? el.className : '', id: el.id, text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 35), bg: s.backgroundColor, area: Math.round(r.width * r.height) };
  }).filter(Boolean).sort((a, b) => b.area - a.area));
  console.log(`VIEW ${view}`);
  console.log(JSON.stringify(rows.slice(0, 20), null, 2));
}
await browser.close();
