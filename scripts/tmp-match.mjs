import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('D:/suibian/Documents/media-api-console/node_modules/playwright-core');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find((p) => p.url().includes('workspace.html')) ?? await browser.contexts()[0].newPage();
await page.goto('http://localhost:4273/workspace.html',{waitUntil:'networkidle'}); await page.waitForTimeout(700);
await page.locator('.nav-item[data-view="strategy"]').click(); await page.waitForTimeout(200);
const out=await page.evaluate(()=>{
  const sels=['.profile-panel','.positioning-panel','.panel','.result-block','.copy-editor-panel']; const out={};
  for(const sel of sels){const el=document.querySelector(sel); const arr=[]; for(const ss of document.styleSheets){let rules;try{rules=ss.cssRules}catch{continue} for(const r of rules){if(!r.selectorText) continue; let matches=false; try{matches=el.matches(r.selectorText)}catch{} if(matches && r.style.background) arr.push({href:ss.href,selector:r.selectorText,bg:r.style.background,imp:r.style.getPropertyPriority('background'),css:r.style.cssText});}} out[sel]={computed:getComputedStyle(el).background,arr};}
  return out;
});
console.log(JSON.stringify(out,null,2)); await browser.close();
