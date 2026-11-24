import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('D:/suibian/Documents/media-api-console/node_modules/playwright-core');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find((candidate) => candidate.url().includes('workspace.html'));
await page.goto('http://localhost:4273/workspace.html', { waitUntil: 'networkidle' });
await page.locator('.nav-item[data-view="overview"]').click();
await page.waitForTimeout(500);
await page.evaluate(() => { document.body.style.setProperty('background-color','transparent','important'); document.documentElement.style.setProperty('background-color','#d5eaf4','important'); });
await page.screenshot({ path: 'artifacts/test-transparent-overview.png', fullPage: true });
console.log('ambient', await page.evaluate(() => {
  const e=document.querySelector('.liquid-ambient'), s=getComputedStyle(e);
  return {rect:[e.getBoundingClientRect().x,e.getBoundingClientRect().y,e.getBoundingClientRect().width,e.getBoundingClientRect().height],z:s.zIndex,pos:s.position,bg:s.backgroundImage,opacity:s.opacity};
}));
for (const y of [100, 500, 700]) {
  await page.evaluate((scrollY) => window.scrollTo(0, scrollY), 900);
  console.log(y, await page.evaluate((pointY) => document.elementsFromPoint(500, pointY).slice(0,8).map((el) => {
    const r=el.getBoundingClientRect(), s=getComputedStyle(el);
    return {tag:el.tagName,id:el.id,cls:typeof el.className==='string'?el.className:'',rect:[r.x,r.y,r.width,r.height],bg:s.backgroundColor,img:s.backgroundImage,pos:s.position,z:s.zIndex,opacity:s.opacity};
  }), y));
}
await browser.close();
