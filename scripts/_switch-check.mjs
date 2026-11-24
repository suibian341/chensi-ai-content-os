import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('D:/suibian/Documents/media-api-console/node_modules/playwright-core');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find((candidate) => candidate.url().includes('workspace.html')) ?? await browser.contexts()[0].newPage();
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto('http://localhost:4273/workspace.html', { waitUntil: 'networkidle' });
await page.locator('.nav-item[data-view="media"]').click();
await page.waitForTimeout(600);
const switches = page.locator('input.optical-switch');
const count = await switches.count();
let result = { count };
if (count) {
  let target = switches.first();
  const visible = [];
  for (let index = 0; index < count; index += 1) {
    const candidate = switches.nth(index);
    const candidateBox = await candidate.boundingBox();
    if (candidateBox && candidateBox.width > 0 && candidateBox.height > 0) visible.push({ index, checked: await candidate.isChecked(), box: candidateBox });
    if (candidateBox && candidateBox.width > 0 && candidateBox.height > 0 && !(await candidate.isChecked())) { target = candidate; break; }
  }
  const box = await target.boundingBox();
  const before = await target.isChecked();
  if (box) {
    await page.mouse.move(box.x + box.width * .2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * .85, box.y + box.height / 2, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(250);
  }
  result = { count, visible, before, after: await target.isChecked(), className: await target.getAttribute('class'), progress: await target.evaluate((e) => getComputedStyle(e).getPropertyValue('--switch-progress')) };
}
console.log(JSON.stringify(result, null, 2));
await browser.close();
