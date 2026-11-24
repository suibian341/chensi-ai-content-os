import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('D:/suibian/Documents/media-api-console/node_modules/playwright-core');

const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const context = browser.contexts()[0];
const page = context.pages().find((candidate) => candidate.url().includes('workspace.html')) ?? await context.newPage();
await page.setViewportSize({ width: 1280, height: 800 });
await page.goto('http://localhost:4273/workspace.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(850);
const views = ['overview', 'strategy', 'benchmark', 'copy', 'media', 'render', 'publish', 'library', 'assets', 'account', 'support', 'templates', 'history'];
for (const view of views) {
  await page.locator(`.nav-item[data-view="${view}"]`).click();
  await page.waitForTimeout(850);
  const rows = await page.evaluate(() => {
    const vh = innerHeight;
    const vw = innerWidth;
    const parseAlpha = (value) => {
      const match = value.match(/rgba?\([^)]*[, ]([0-9.]+)\)/);
      if (!match) return value.startsWith('rgb') ? 1 : 0;
      return Number(match[1]);
    };
    return [...document.querySelectorAll('body *')].map((el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      if (r.width < 8 || r.height < 8 || r.right < 0 || r.bottom < 0 || r.left > vw || r.top > vh) return null;
      const bg = s.backgroundColor;
      const alpha = parseAlpha(bg);
      if (alpha < 0.08 && s.backgroundImage === 'none') return null;
      return {
        tag: el.tagName.toLowerCase(), id: el.id, cls: typeof el.className === 'string' ? el.className : '',
        text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 90),
        rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], bg,
        alpha, image: s.backgroundImage, opacity: s.opacity, position: s.position,
      };
    }).filter(Boolean).sort((a, b) => (b.alpha - a.alpha) || (b.rect[2] * b.rect[3] - a.rect[2] * a.rect[3]));
  });
  console.log(`VIEW ${view}`);
  console.log(JSON.stringify(rows.slice(0, 90), null, 2));
}
await browser.close();
