import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('D:/suibian/Documents/media-api-console/node_modules/playwright-core');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find(p=>p.url().includes('workspace.html'));
await page.goto('http://localhost:4273/workspace.html',{waitUntil:'networkidle'}); await page.waitForTimeout(1000);
const out=await page.evaluate(()=>{const target=document.querySelector('.copy-editor-panel'); const arr=[]; const sheets=[]; for(const ss of document.styleSheets){let rules;try{rules=ss.cssRules}catch{continue} const rows=[...rules].map((r,i)=>({i,sel:r.selectorText||'',css:r.cssText?.slice(0,140)})); sheets.push({href:ss.href,count:rules.length,last:rows.slice(-8)}); for(const r of rules){if(r.selectorText && r.selectorText.includes('copy-editor-panel')){let match=false; try{match=target.matches(r.selectorText)}catch{}; if(match) arr.push({href:ss.href,sel:r.selectorText,bg:r.style.background,important:r.style.getPropertyPriority('background'),order:r.style.cssText});}}} return {style:target.getAttribute('style'),class:target.className,computed:getComputedStyle(target).background,arr,sheets};}); console.log(JSON.stringify(out,null,2)); await browser.close();
