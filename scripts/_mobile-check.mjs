import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('D:/suibian/Documents/media-api-console/node_modules/playwright-core');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find((candidate) => candidate.url().includes('workspace.html')) ?? await browser.contexts()[0].newPage();
await page.setViewportSize({ width: 390, height: 844 });
await page.goto('http://localhost:4273/workspace.html', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(700);
const report = await page.evaluate(() => {
  const read = (selector) => {
    const node = document.querySelector(selector);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return { cls: node.className, rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)], bg: style.backgroundColor, overflow: style.overflow, touchAction: style.touchAction };
  };
  return { shell: read('.workspace-shell'), sidebar: read('.sidebar'), nav: read('.nav-list'), active: read('.nav-item.active'), filter: read('.nav-liquid-filter'), indicator: read('.nav-liquid-indicator'), main: read('.main-content'), view: read('.content-view:not(.hidden)'), scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight] };
});
console.log(JSON.stringify(report, null, 2));
await page.screenshot({ path: 'artifacts/mobile-final-overview.png', fullPage: false });
const nav = page.locator('.nav-list');
const items = page.locator('.nav-item');
const before = await page.locator('.nav-item.active').getAttribute('data-view');
const first = await items.nth(0).boundingBox();
const second = await items.nth(1).boundingBox();
if (first && second) {
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(second.x + second.width / 2, second.y + second.height / 2, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(500);
}
const after = await page.locator('.nav-item.active').getAttribute('data-view');
console.log(JSON.stringify({ drag: { before, after }, classes: await nav.getAttribute('class') }));
await browser.close();
