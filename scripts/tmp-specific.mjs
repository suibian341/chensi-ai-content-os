import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('D:/suibian/Documents/media-api-console/node_modules/playwright-core');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find((p) => p.url().includes('workspace.html')) ?? await browser.contexts()[0].newPage();
await page.setViewportSize({ width: 1280, height: 800 });
await page.goto('http://localhost:4273/workspace.html', { waitUntil: 'networkidle' }); await page.waitForTimeout(600);
const views = ['overview','strategy','benchmark','copy','media','render','publish','library','assets','account','support','templates','history'];
const selectors = ['.content-view:not(.hidden)', '.overview-bottom', '.task-panel', '.output-panel', '.copy-editor-panel', '.copy-source-controls', '.copy-value', '.profile-panel', '.positioning-panel', '.result-block', '.image-reference-picker', '.image-reference-option', '.production-direction', '.render-asset-picker', '.render-asset-option', '#teamMembersPanel', '.team-member-form', '.team-member-row', '.permission-picker', '.member-permission-picker', '.connection-row', '.platform-card', '.settings-row', '.history-list', '.history-row', '.empty-state', '.sidebar', '.nav-list', '.nav-item:hover'];
for (const view of views) {
  await page.locator(`.nav-item[data-view="${view}"]`).click(); await page.waitForTimeout(120);
  const out = await page.evaluate((selectors) => selectors.map(sel => {
    const el = document.querySelector(sel); if (!el) return {sel,missing:true};
    const s=getComputedStyle(el),r=el.getBoundingClientRect();
    return {sel,tag:el.tagName.toLowerCase(),id:el.id,cls:typeof el.className==='string'?el.className:'',rect:[r.x,r.y,r.width,r.height].map(v=>Math.round(v)),bg:s.backgroundColor,background:s.background,opacity:s.opacity,border:s.border,style:el.getAttribute('style'),before:{display:getComputedStyle(el,'::before').display,bg:getComputedStyle(el,'::before').backgroundColor,bgi:getComputedStyle(el,'::before').backgroundImage,opacity:getComputedStyle(el,'::before').opacity,content:getComputedStyle(el,'::before').content},after:{display:getComputedStyle(el,'::after').display,bg:getComputedStyle(el,'::after').backgroundColor,bgi:getComputedStyle(el,'::after').backgroundImage,opacity:getComputedStyle(el,'::after').opacity,content:getComputedStyle(el,'::after').content}};
  }), selectors);
  console.log(`VIEW ${view}\n${JSON.stringify(out,null,2)}`);
}
await browser.close();
