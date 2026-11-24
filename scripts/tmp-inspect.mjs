import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('D:/suibian/Documents/media-api-console/node_modules/playwright-core');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const context = browser.contexts()[0];
const page = context.pages().find((candidate) => candidate.url().includes('workspace.html')) ?? await context.newPage();
await page.goto('http://localhost:4273/workspace.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(1300);
const out = await page.evaluate(() => {
  const selectors = [
    '.workspace-shell', '.sidebar', '.sidebar::before', '.nav-list', '.nav-list::before',
    '.topbar', '.hero-panel', '.hero-console', '.workflow-strip', '.metric-card', '.feature-card',
    '.overview-bottom', '.overview-bottom > .panel', '.copy-editor-panel', '.copy-source-controls',
    '.copy-draft-field', '.copy-reference-option', '.copy-value', '.copy-compliance',
    '#teamMembersPanel', '#teamMembersPanel::before', '.team-member-form', '.team-member-row',
    '.image-reference-picker', '.image-reference-option', '.image-reference-option img',
    '.production-direction', '.render-asset-picker', '.render-asset-option', '.health-card', '.user-chip',
    '#logoutButton', '#adminEntry', '#refreshButton'
  ];
  const pseudo = (node, p) => { const s = getComputedStyle(node, p); return { content:s.content, background:s.background, backgroundColor:s.backgroundColor, opacity:s.opacity, filter:s.filter, boxShadow:s.boxShadow, border:s.border, display:s.display, transform:s.transform }; };
  const result = {};
  for (const selector of selectors) {
    if (selector.includes('::')) continue;
    const node = document.querySelector(selector); if (!node) { result[selector] = null; continue; }
    const r = node.getBoundingClientRect(); const s = getComputedStyle(node);
    result[selector] = { className:node.className, rect:[r.x,r.y,r.width,r.height].map(v=>Math.round(v*10)/10), bg:s.background, bgc:s.backgroundColor, opacity:s.opacity, filter:s.filter, backdrop:s.backdropFilter, border:s.border, boxShadow:s.boxShadow, display:s.display, overflow:s.overflow, grid:s.gridTemplateColumns, minWidth:s.minWidth, maxWidth:s.maxWidth, whiteSpace:s.whiteSpace, pseudoBefore:pseudo(node,'::before'), pseudoAfter:pseudo(node,'::after') };
  }
  result.scroll = { x: document.documentElement.scrollWidth, y: document.documentElement.scrollHeight, inner:[innerWidth,innerHeight] };
  return result;
});
console.log(JSON.stringify(out,null,2));
await browser.close();
