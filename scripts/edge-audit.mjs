import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('D:/suibian/Documents/media-api-console/node_modules/playwright-core');

const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const context = browser.contexts()[0];
const page = context.pages().find((candidate) => candidate.url().includes('workspace.html')) ?? await context.newPage();
await page.goto('http://localhost:4273/workspace.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);

const views = ['overview', 'copy', 'media', 'render', 'account'];
const selectors = [
  '.workspace-shell', '.sidebar', '.sidebar-bottom', '.health-card', '.user-chip', '.main-content', '.topbar', '.content-view:not(.hidden)',
  '.overview-bottom', '.task-panel', '.output-panel', '#latestOutput', '.copy-editor-panel', '.copy-source-controls', '.copy-content', '.copy-value',
  '.image-reference-option', '.reference-image', '.media-library-copy', '.production-direction', '.field-hint', '.permission-picker', '.member-permission-picker',
  '.refresh-button', '[aria-label*=刷新]', '.icon-button', '.logout-button', '#adminLogoutButton', '.nav-list', '.nav-item.active', '.nav-liquid-indicator'
];
for (const view of views) {
  const locator = page.locator(`.nav-item[data-view="${view}"]`);
  if (await locator.count()) await locator.click();
  await page.waitForTimeout(180);
  const report = await page.evaluate((selectors) => {
    const read = (node) => {
      if (!node) return null;
      const s = getComputedStyle(node);
      const r = node.getBoundingClientRect();
      const parent = node.parentElement?.getBoundingClientRect();
      return {
        tag: node.tagName.toLowerCase(), id: node.id, cls: node.className,
        rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) },
        parent: parent ? { x: Math.round(parent.x), y: Math.round(parent.y), width: Math.round(parent.width), height: Math.round(parent.height), right: Math.round(parent.right), bottom: Math.round(parent.bottom) } : null,
        display: s.display, position: s.position, overflow: s.overflow, overflowX: s.overflowX, overflowY: s.overflowY,
        bg: s.backgroundColor, bgImage: s.backgroundImage, opacity: s.opacity, color: s.color, border: s.border,
        whiteSpace: s.whiteSpace, minWidth: s.minWidth, maxWidth: s.maxWidth, flexShrink: s.flexShrink, grid: s.gridTemplateColumns,
      };
    };
    const result = {};
    for (const selector of selectors) result[selector] = read(document.querySelector(selector));
    result.body = read(document.body);
    result.scroll = { innerWidth, innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight };
    return result;
  }, selectors);
  console.log(`VIEW ${view}\n${JSON.stringify(report, null, 2)}`);
  await page.screenshot({ path: `artifacts/audit-${view}.png`, fullPage: false });
}

await page.goto('http://localhost:4273/admin.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
for (const view of ['dashboard', 'users', 'settings']) {
  const locator = page.locator(`.nav-item[data-admin-view="${view}"]`);
  if (await locator.count()) await locator.click();
  await page.waitForTimeout(150);
  const report = await page.evaluate((selectors) => {
    const read = (node) => {
      if (!node) return null;
      const s = getComputedStyle(node); const r = node.getBoundingClientRect(); const p = node.parentElement?.getBoundingClientRect();
      return { tag: node.tagName.toLowerCase(), id: node.id, cls: node.className, rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) }, parent: p ? { width: Math.round(p.width), height: Math.round(p.height), right: Math.round(p.right), bottom: Math.round(p.bottom) } : null, display: s.display, overflow: s.overflow, bg: s.backgroundColor, bgImage: s.backgroundImage, opacity: s.opacity, color: s.color, whiteSpace: s.whiteSpace, minWidth: s.minWidth, maxWidth: s.maxWidth, flexShrink: s.flexShrink, grid: s.gridTemplateColumns };
    };
    const result = {}; for (const selector of selectors) result[selector] = read(document.querySelector(selector));
    result.scroll = { innerWidth, innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight }; return result;
  }, ['.admin-shell', '.sidebar', '.sidebar-bottom', '.health-card', '.user-chip', '.main-content', '.topbar', '.admin-view:not(.hidden)', '.team-member-row', '.permission-picker', '.member-permission-picker', '#adminLogoutButton', '.icon-button', '.nav-list', '.nav-item.active']);
  console.log(`ADMIN ${view}\n${JSON.stringify(report, null, 2)}`);
  await page.screenshot({ path: `artifacts/audit-admin-${view}.png`, fullPage: false });
}
await browser.close();
