import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('D:/suibian/Documents/media-api-console/node_modules/playwright-core');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const context = browser.contexts()[0];
const page = context.pages().find((candidate) => candidate.url().includes('workspace.html')) ?? await context.newPage();
await page.setViewportSize({ width: 1280, height: 800 });
await page.goto('http://localhost:4273/workspace.html', { waitUntil: 'networkidle' });
for (const view of ['copy','media','render','account']) {
  await page.locator(`.nav-item[data-view="${view}"]`).click();
  await page.waitForTimeout(500);
  const rows = await page.evaluate(() => [...document.querySelectorAll('.content-view:not(.hidden) *')].map(el => {
    const r=el.getBoundingClientRect(), s=getComputedStyle(el); if(r.width<20||r.height<15||r.right<0||r.bottom<0||r.left>innerWidth||r.top>innerHeight)return null;
    const m=s.backgroundColor.match(/rgba?\\([^)]*[, ]([0-9.]+)\\)/); const a=m?Number(m[1]):(s.backgroundColor.startsWith('rgb')?1:0);
    if(a<.3)return null; return {tag:el.tagName,id:el.id,cls:typeof el.className==='string'?el.className:'',text:(el.textContent||'').trim().replace(/\\s+/g,' ').slice(0,70),rect:[r.x,r.y,r.width,r.height].map(v=>Math.round(v)),bg:s.backgroundColor,opacity:s.opacity,border:s.border};
  }).filter(Boolean).sort((a,b)=>{const aa=b.rect[2]*b.rect[3],bb=a.rect[2]*a.rect[3]; return aa-bb;}));
  console.log(`VIEW ${view}\\n`+JSON.stringify(rows.slice(0,80),null,2));
}
await browser.close();
