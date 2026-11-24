import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('D:/suibian/Documents/media-api-console/node_modules/playwright-core');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const context = browser.contexts()[0];
const page = context.pages().find((candidate) => candidate.url().includes('workspace.html')) ?? await context.newPage();
await page.setViewportSize({ width: 1280, height: 800 });
await page.goto('http://localhost:4273/workspace.html', { waitUntil: 'networkidle' });
for (const view of ['overview','strategy','benchmark','copy','media','render','publish','library','assets','account','support','templates','history']) {
  await page.locator(`.nav-item[data-view="${view}"]`).click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: `artifacts/full-${view}.png`, fullPage: true });
}
await browser.close();
