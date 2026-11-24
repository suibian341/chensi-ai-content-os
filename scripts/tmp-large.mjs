import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('D:/suibian/Documents/media-api-console/node_modules/playwright-core');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const context = browser.contexts()[0];
const page = context.pages().find((candidate) => candidate.url().includes('workspace.html')) ?? await context.newPage();
await page.setViewportSize({ width: 1280, height: 800 });
await page.goto('http://localhost:4273/workspace.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(650);
const views = ['overview','strategy','benchmark','copy','media','render','publish','library','assets','account','support','templates','history'];
for (const view of views) {
  await page.locator(`.nav-item[data-view="${view}"]`).click();
  await page.waitForTimeout(120);
  const data = await page.evaluate(() => {
    const parseAlpha = (value) => {
      const match = String(value).match(/rgba?\\(([^)]+)\\)/i);
      if (!match) return 0;
      const parts = match[1].split(',').map((v) => Number.parseFloat(v.trim()));
      return parts.length > 3 ? (Number.isFinite(parts[3]) ? parts[3] : 1) : 1;
    };
    const rows = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width < innerWidth * .45 || r.height < 36) continue;
      const s = getComputedStyle(el);
      const bgAlpha = parseAlpha(s.backgroundColor);
      const before = getComputedStyle(el, '::before');
      const after = getComputedStyle(el, '::after');
      const beforeAlpha = parseAlpha(before.backgroundColor);
      const afterAlpha = parseAlpha(after.backgroundColor);
      if (bgAlpha > .08 || beforeAlpha > .08 || afterAlpha > .08 || s.backgroundImage !== 'none') {
        rows.push({ tag: el.tagName.toLowerCase(), id: el.id, cls: String(el.className || '').slice(0, 120), rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], bg: s.backgroundColor, bgi: s.backgroundImage, before: { display: before.display, bg: before.backgroundColor, image: before.backgroundImage, content: before.content }, after: { display: after.display, bg: after.backgroundColor, image: after.backgroundImage, content: after.content }, opacity: s.opacity, pos: s.position });
      }
    }
    return { scroll: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }, rows };
  });
  console.log(`VIEW ${view}\n${JSON.stringify(data, null, 2)}`);
}
await browser.close();
