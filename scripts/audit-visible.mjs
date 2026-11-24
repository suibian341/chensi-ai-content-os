import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('D:/suibian/Documents/media-api-console/node_modules/playwright-core');

const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const context = browser.contexts()[0];
const page = await context.newPage();
await page.goto('http://localhost:4273/workspace.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(900);
for (const view of ['overview', 'copy', 'media', 'render', 'account']) {
  await page.locator(`.nav-item[data-view="${view}"]`).click();
  await page.waitForTimeout(900);
  const report = await page.evaluate(() => {
    const rows = [];
    for (const el of document.querySelectorAll('body *')) {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (rect.width < 20 || rect.height < 10 || rect.bottom < 0 || rect.top > innerHeight) continue;
      const match = style.backgroundColor.match(/rgba?\(([^)]+)\)/);
      const values = match ? match[1].split(',').map((value) => Number.parseFloat(value)) : [];
      const alpha = values.length > 3 ? values[3] : (style.backgroundColor.startsWith('rgb(') ? 1 : 0);
      if (alpha > 0.04 && rect.width * rect.height > 15000) {
        rows.push({
          tag: el.tagName.toLowerCase(),
          id: el.id,
          cls: typeof el.className === 'string' ? el.className : '',
          rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
          background: style.backgroundColor,
          opacity: style.opacity,
          backdrop: style.backdropFilter,
        });
      }
    }
    return rows.slice(0, 100);
  });
  if (view === 'copy') {
    const details = await page.evaluate(() => [...document.querySelectorAll('.copy-reference-option')].map((el) => ({
      text: el.innerText,
      children: [...el.children].map((child) => { const r = child.getBoundingClientRect(); return { tag: child.tagName, cls: child.className, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] }; }),
      style: { display: getComputedStyle(el).display, align: getComputedStyle(el).alignItems, padding: getComputedStyle(el).padding, minHeight: getComputedStyle(el).minHeight, maxHeight: getComputedStyle(el).maxHeight },
    })));
    console.log(`COPY DETAILS\n${JSON.stringify(details, null, 2)}`);
  }
  console.log(`VIEW ${view}\n${JSON.stringify(report, null, 2)}`);
}
await browser.close();
