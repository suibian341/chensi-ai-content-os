import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('D:/suibian/Documents/media-api-console/node_modules/playwright-core');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find((candidate) => candidate.url().includes('workspace.html'));
await page.setViewportSize({width:1280,height:800});
await page.goto('http://localhost:4273/workspace.html',{waitUntil:'networkidle'});
for (const view of ['overview','copy','media','render','account']) {
  await page.locator(`.nav-item[data-view="${view}"]`).click();
  await page.waitForTimeout(250);
  const result = await page.evaluate(() => {
    const offenders = [...document.querySelectorAll('body *')].map((el) => {
      const r=el.getBoundingClientRect(), s=getComputedStyle(el);
      if (s.position==='fixed' || s.display==='none' || s.visibility==='hidden') return null;
      if (r.right > innerWidth + 1 || r.left < -1 || r.bottom > document.documentElement.scrollHeight + 1) return {tag:el.tagName,id:el.id,cls:typeof el.className==='string'?el.className:'',rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)],pos:s.position,transform:s.transform,overflow:s.overflow};
      return null;
    }).filter(Boolean).sort((a,b)=>b.rect[0]+b.rect[2]-(a.rect[0]+a.rect[2]));
    return {scroll:[document.documentElement.scrollWidth,document.documentElement.scrollHeight], offenders:offenders.slice(0,20)};
  });
  console.log(view,JSON.stringify(result));
}
await browser.close();
