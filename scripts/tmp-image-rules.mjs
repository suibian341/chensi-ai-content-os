import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('D:/suibian/Documents/media-api-console/node_modules/playwright-core');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find(p => p.url().includes('workspace.html'));
await page.goto('http://localhost:4273/workspace.html', { waitUntil: 'networkidle' });
await page.locator('.nav-item[data-view=media]').click();
await page.waitForTimeout(500);
const out = await page.evaluate(() => {
  const target = document.querySelector('.image-reference-option');
  const matches = [];
  for (const ss of document.styleSheets) {
    let rules;
    try { rules = ss.cssRules; } catch { continue; }
    for (const r of rules) {
      if (!r.selectorText || !target.matches(r.selectorText)) continue;
      matches.push({ href: ss.href, selector: r.selectorText, css: r.style.cssText });
    }
  }
  const s = getComputedStyle(target);
  return { className: target.className, outer: target.outerHTML, computed: { background: s.background, grid: s.gridTemplateColumns, minHeight: s.minHeight, padding: s.padding }, matches };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
