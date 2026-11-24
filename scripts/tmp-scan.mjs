import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('D:/suibian/Documents/media-api-console/node_modules/playwright-core');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find((p) => p.url().includes('workspace.html')) ?? await browser.contexts()[0].newPage();
await page.setViewportSize({ width: 1280, height: 800 });
await page.goto('http://localhost:4273/workspace.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
const views = ['overview','strategy','benchmark','copy','media','render','publish','library','assets','account','support','templates','history'];
for (const view of views) {
  await page.locator(`.nav-item[data-view="${view}"]`).click();
  await page.waitForTimeout(100);
  const result = await page.evaluate(() => {
    const rows = [];
    for (const el of document.querySelectorAll('body.workspace-page *')) {
      const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
      if (r.width < 4 || r.height < 4 || r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) continue;
      const bg = s.backgroundColor;
      const m = bg.match(/rgba?\(([^)]+)\)/); let alpha = 0;
      if (m) { const parts = m[1].split(',').map(v => Number.parseFloat(v.trim())); alpha = parts.length > 3 ? parts[3] : 1; }
      if (alpha >= .30 || /255,\s*255,\s*255/.test(bg) || s.backgroundImage !== 'none') {
        rows.push({tag:el.tagName.toLowerCase(), id:el.id, cls:typeof el.className === 'string' ? el.className : '', rect:[r.x,r.y,r.width,r.height].map(v=>Math.round(v)), bg, alpha, bgi:s.backgroundImage.slice(0,120), pseudo:getComputedStyle(el,'::before').backgroundColor});
      }
    }
    return {rows: rows.sort((a,b)=>b.alpha-a.alpha).slice(0,80), inline:[...document.querySelectorAll('[style*="background"]')].map(el=>({tag:el.tagName.toLowerCase(),id:el.id,cls:typeof el.className==='string'?el.className:'',style:el.getAttribute('style')})).slice(0,80)};
  });
  console.log(`VIEW ${view}\n${JSON.stringify(result,null,2)}`);
}
await browser.close();
