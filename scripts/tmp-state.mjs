import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('D:/suibian/Documents/media-api-console/node_modules/playwright-core');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find((candidate) => candidate.url().includes('workspace.html'));
console.log(await page.evaluate(() => {
  const q = document.querySelector('.quality-pill');
  const a = document.querySelector('.liquid-ambient');
  return {
    href: [...document.styleSheets].map((sheet) => sheet.href).filter(Boolean),
    quality: q ? getComputedStyle(q).backgroundColor : null,
    before: getComputedStyle(document.body, '::before').position,
    ambient: a ? { position: getComputedStyle(a).position, height: a.getBoundingClientRect().height } : null
  };
}));
console.log(await page.evaluate(() => [...document.querySelectorAll('*')].flatMap((el) => {
  const r = el.getBoundingClientRect();
  return ['::before','::after'].map((pseudo) => {
    const s = getComputedStyle(el,pseudo);
    if (r.width < 500 || r.height < 500 || s.backgroundImage === 'none' || s.display === 'none') return null;
    return { tag: el.tagName, id: el.id, cls: typeof el.className === 'string' ? el.className : '', pseudo, rect: [r.x,r.y,r.width,r.height], pos:s.position, h:s.height, bg:s.backgroundColor, image:s.backgroundImage.slice(0,120), z:s.zIndex };
  });
}).filter(Boolean)));
console.log(await page.evaluate(() => {
  const out=[];
  for (const sheet of document.styleSheets) {
    let rules=[];
    try { rules=[...sheet.cssRules]; } catch { continue; }
    const walk=(rs)=>{ for(const r of rs){ if(r.cssRules) walk([...r.cssRules]); else if(r.selectorText?.includes('quality-pill')) out.push({href:sheet.href, selector:r.selectorText, css:r.style.cssText}); } };
    walk(rules);
  }
  return out;
}));
console.log(await page.evaluate(() => {
  const q=document.querySelector('.quality-pill');
  return q ? {style:q.getAttribute('style'), parent:q.parentElement?.className, matches:q.matches('body.workspace-page .quality-pill'), body:document.body.className} : null;
}));
console.log(await page.evaluate(() => [...document.querySelectorAll('body *')].map(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return {tag:el.tagName,id:el.id,cls:typeof el.className==='string'?el.className:'',rect:[r.x,r.y,r.width,r.height],pos:s.position,display:s.display,vis:s.visibility}}).filter(x=>x.rect[1]+x.rect[3]>1500&&x.display!=='none').sort((a,b)=>b.rect[1]+b.rect[3]-a.rect[1]-a.rect[3]).slice(0,30)));
console.log(await page.evaluate(() => [...document.querySelectorAll('body *')].map(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return {tag:el.tagName,id:el.id,cls:typeof el.className==='string'?el.className:'',rect:[r.x,r.y,r.width,r.height],bg:s.backgroundColor,img:s.backgroundImage,pos:s.position,z:s.zIndex}}).filter(x=>x.rect[2]>700 && x.rect[3]>700 && x.pos!=='static')));
console.log(await page.evaluate(() => ['.main-content','.content-area','.workspace-main','.workspace-shell','.sidebar','.content-view:not(.hidden)'].map(sel=>{const e=document.querySelector(sel);if(!e)return{sel};const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {sel,rect:[r.x,r.y,r.width,r.height],bg:s.backgroundColor,img:s.backgroundImage,opacity:s.opacity,overflow:s.overflow,pos:s.position}})));
console.log(await page.evaluate(() => [...document.querySelector('body').children].map(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return {tag:el.tagName,id:el.id,cls:el.className,rect:[r.x,r.y,r.width,r.height],bg:s.backgroundColor,img:s.backgroundImage,pos:s.position,z:s.zIndex,overflow:s.overflow}})));
console.log(await page.evaluate(() => [...document.querySelector('body').children].filter(el=>el.id||el.className).slice(0,12).map(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return {tag:el.tagName,id:el.id,cls:el.className,rect:[r.x,r.y,r.width,r.height],bg:s.backgroundColor,img:s.backgroundImage,pos:s.position,z:s.zIndex,overflow:s.overflow}})));
console.log(await page.evaluate(() => { window.scrollTo(0,1000); return document.elementsFromPoint(100,100).slice(0,12).map(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return {tag:el.tagName,id:el.id,cls:typeof el.className==='string'?el.className:'',rect:[r.x,r.y,r.width,r.height],bg:s.backgroundColor,img:s.backgroundImage,pos:s.position,z:s.zIndex,opacity:s.opacity}}); }));
console.log(await page.evaluate(() => document.elementsFromPoint(500,100).slice(0,12).map(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return {tag:el.tagName,id:el.id,cls:typeof el.className==='string'?el.className:'',rect:[r.x,r.y,r.width,r.height],bg:s.backgroundColor,img:s.backgroundImage,pos:s.position,z:s.zIndex,opacity:s.opacity}})));
console.log(await page.evaluate(() => document.elementsFromPoint(500,700).slice(0,12).map(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return {tag:el.tagName,id:el.id,cls:typeof el.className==='string'?el.className:'',rect:[r.x,r.y,r.width,r.height],bg:s.backgroundColor,img:s.backgroundImage,pos:s.position,z:s.zIndex,opacity:s.opacity}})));
await page.locator('.nav-item[data-view="overview"]').click();
await page.waitForTimeout(400);
await page.evaluate(() => window.scrollTo(0, 900));
console.log(await page.evaluate(() => document.elementsFromPoint(500,100).slice(0,12).map(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return {tag:el.tagName,id:el.id,cls:typeof el.className==='string'?el.className:'',rect:[r.x,r.y,r.width,r.height],bg:s.backgroundColor,img:s.backgroundImage,pos:s.position,z:s.zIndex,opacity:s.opacity}})));
await browser.close();
