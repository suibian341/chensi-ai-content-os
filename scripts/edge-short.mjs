import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('D:/suibian/Documents/media-api-console/node_modules/playwright-core');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const context = browser.contexts()[0];
const page = context.pages().find((candidate) => candidate.url().includes('workspace.html')) ?? await context.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto('http://localhost:4273/workspace.html', { waitUntil: 'networkidle' });
const views = ['overview','strategy','benchmark','copy','media','render','publish','library','assets','account','support','templates','history'];
for (const view of views) {
  await page.locator(`.nav-item[data-view="${view}"]`).click();
  await page.waitForTimeout(450);
  const data = await page.evaluate(() => {
    const alpha = (v) => { const m = v.match(/rgba?\([^)]*,\s*([0-9.]+)\)/); return m ? Number(m[1]) : (v === 'transparent' || v === 'rgba(0, 0, 0, 0)' ? 0 : v.startsWith('rgb') ? 1 : 0); };
    const visible = [...document.querySelectorAll('body *')].map((el) => {
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || r.width < 8 || r.height < 8) return null;
      return {el, r, s};
    }).filter(Boolean);
    const strong = visible.filter(({r,s}) => r.width > innerWidth * .7 && r.height >= 15 && r.top < innerHeight && r.bottom > 0 && alpha(s.backgroundColor) > .42)
      .map(({el,r,s}) => ({tag:el.tagName,id:el.id,cls:typeof el.className==='string'?el.className:'',rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)],bg:s.backgroundColor,image:s.backgroundImage,pos:s.position,z:s.zIndex,op:s.opacity})).slice(0,30);
    const overflow = visible.filter(({r}) => r.left < -1 || r.right > innerWidth + 1).map(({el,r,s}) => ({tag:el.tagName,id:el.id,cls:typeof el.className==='string'?el.className:'',rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)],overflow:s.overflow})).slice(0,30);
    const targets = ['.user-chip','#logoutButton','#refreshButton','.health-card','.image-reference-picker','.image-reference-option','.production-direction','.team-member-form','.team-member-row','#teamMembersPanel','.copy-source-controls','.copy-value','.script-box','.nav-item.active','.nav-liquid-filter','.nav-liquid-indicator'];
    const selected = Object.fromEntries(targets.map((sel) => { const el=document.querySelector(sel); if(!el)return [sel,null]; const r=el.getBoundingClientRect(),s=getComputedStyle(el); return [sel,{rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)],bg:s.backgroundColor,border:s.border,opacity:s.opacity,display:s.display,grid:s.gridTemplateColumns,overflow:s.overflow,text:(el.textContent||'').trim().replace(/\s+/g,' ').slice(0,80)}]; }));
    return {strong,overflow,selected,scroll:[document.documentElement.scrollWidth,document.documentElement.scrollHeight]};
  });
  console.log(`VIEW ${view}`);
  console.log(JSON.stringify(data));
}
await browser.close();
