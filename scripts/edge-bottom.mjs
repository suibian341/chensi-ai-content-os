import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('D:/suibian/Documents/media-api-console/node_modules/playwright-core');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const context = browser.contexts()[0];
const page = context.pages().find((candidate) => candidate.url().includes('workspace.html')) ?? await context.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto('http://localhost:4273/workspace.html', { waitUntil: 'networkidle' });
for (const view of ['overview', 'copy', 'media', 'render', 'account']) {
  await page.locator(`.nav-item[data-view=\"${view}\"]`).click();
  await page.waitForTimeout(500);
  const heights = await page.evaluate(() => ({ h: document.documentElement.scrollHeight, w: document.documentElement.scrollWidth }));
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(300);
  const result = await page.evaluate(() => {
    const inspectPoint = (x, y) => document.elementsFromPoint(x, y).slice(0, 10).map((el) => {
      const s = getComputedStyle(el); const r = el.getBoundingClientRect();
      return { tag: el.tagName, id: el.id, cls: typeof el.className === 'string' ? el.className : '', rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], bg: s.backgroundColor, image: s.backgroundImage, pos: s.position, z: s.zIndex, opacity: s.opacity, overflow: s.overflow };
    });
    const broad = [...document.querySelectorAll('body *')].map((el) => {
      const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
      if (r.width < innerWidth * .72 || r.height < 12 || s.display === 'none' || s.visibility === 'hidden') return null;
      return { tag: el.tagName, id: el.id, cls: typeof el.className === 'string' ? el.className : '', rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], bg: s.backgroundColor, image: s.backgroundImage, pos: s.position, z: s.zIndex, opacity: s.opacity };
    }).filter(Boolean).filter((x) => x.rect[1] < innerHeight && x.rect[1] + x.rect[3] > 0);
    return { scrollY: scrollY, samples: [[340, 820], [700, 820], [1200, 820], [20, 820]].map(([x, y]) => inspectPoint(x, y)), broad };
  });
  console.log(`VIEW ${view} heights=${JSON.stringify(heights)}\n${JSON.stringify(result, null, 2)}`);
}
await browser.close();
