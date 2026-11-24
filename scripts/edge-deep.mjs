import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('D:/suibian/Documents/media-api-console/node_modules/playwright-core');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const context = browser.contexts()[0];
const page = context.pages().find((candidate) => candidate.url().includes('workspace.html')) ?? await context.newPage();
await page.setViewportSize({ width: 1280, height: 800 });
await page.goto('http://localhost:4273/workspace.html', { waitUntil: 'networkidle' });
for (const view of ['overview', 'copy', 'media', 'render', 'account']) {
  await page.locator(`.nav-item[data-view=\"${view}\"]`).click();
  await page.waitForTimeout(700);
  const result = await page.evaluate(() => {
    const all = [...document.querySelectorAll('body *')];
    const fixed = all.map((el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      if (s.position !== 'fixed' && s.position !== 'sticky') return null;
      return { tag: el.tagName, id: el.id, cls: typeof el.className === 'string' ? el.className : '', rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], bg: s.backgroundColor, image: s.backgroundImage, opacity: s.opacity, z: s.zIndex, pointer: s.pointerEvents, overflow: s.overflow };
    }).filter(Boolean);
    const edge = all.map((el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      if (r.width < 8 || r.height < 8 || s.display === 'none') return null;
      if (r.right <= innerWidth + 1 && r.left >= -1 && r.bottom <= innerHeight + 1 && r.top >= -1) return null;
      return { tag: el.tagName, id: el.id, cls: typeof el.className === 'string' ? el.className : '', rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], overflow: s.overflow, display: s.display };
    }).filter(Boolean).slice(0, 120);
    const samples = [[640,760], [640,790], [640,799], [20,790], [1260,790]].map(([x, y]) => ({
      x, y, stack: document.elementsFromPoint(x, y).slice(0, 8).map((el) => {
        const s = getComputedStyle(el);
        return { tag: el.tagName, id: el.id, cls: typeof el.className === 'string' ? el.className : '', bg: s.backgroundColor, image: s.backgroundImage, pos: s.position, z: s.zIndex, op: s.opacity, pointer: s.pointerEvents };
      })
    }));
    return { fixed, edge, samples, scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight] };
  });
  console.log(`VIEW ${view}`);
  console.log(JSON.stringify(result, null, 2));
}
await browser.close();
