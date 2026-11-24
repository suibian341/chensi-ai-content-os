import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('D:/suibian/Documents/media-api-console/node_modules/playwright-core');

const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const context = browser.contexts()[0];
const page = context.pages().find((candidate) => candidate.url().includes('workspace.html')) ?? await context.newPage();
await page.goto('http://localhost:4273/workspace.html', { waitUntil: 'networkidle' });
const views = ['overview', 'copy', 'media', 'render', 'account'];
for (const view of views) {
  await page.locator(`.nav-item[data-view="${view}"]`).click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: `artifacts/settled-${view}.png`, fullPage: false });
  const report = await page.evaluate(() => {
    const selectors = ['.content-view:not(.hidden)', '.overview-bottom', '.copy-editor-panel', '.copy-value', '.script-box', '.image-reference-picker', '.image-reference-option', '.production-direction', '#teamMembersPanel', '.team-member-form', '.team-member-row', '.health-card', '.user-chip', '#refreshButton', '.nav-item.active', '.nav-liquid-filter', '.nav-liquid-indicator'];
    const result = {};
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (!node) { result[selector] = null; continue; }
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      result[selector] = {
        className: node.className,
        rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
        background: style.backgroundColor,
        opacity: style.opacity,
        border: style.border,
        overflow: style.overflow,
        grid: style.gridTemplateColumns,
        whiteSpace: style.whiteSpace,
      };
    }
    result.scroll = [document.documentElement.scrollWidth, document.documentElement.scrollHeight];
    return result;
  });
  console.log(`VIEW ${view} ${JSON.stringify(report)}`);
}
await browser.close();
