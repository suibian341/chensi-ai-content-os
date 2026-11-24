import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('D:/suibian/Documents/media-api-console/node_modules/playwright-core');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const context = browser.contexts()[0];
const page = context.pages().find((candidate) => candidate.url().includes('workspace.html')) ?? await context.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto('http://localhost:4273/workspace.html', { waitUntil: 'networkidle' });
for (const view of ['overview','copy','media','render','account']) {
  await page.locator(`.nav-item[data-view=\"${view}\"]`).click();
  await page.waitForTimeout(600);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(250);
  await page.screenshot({ path: `artifacts/bottom-${view}.png`, fullPage: false });
}
await browser.close();
