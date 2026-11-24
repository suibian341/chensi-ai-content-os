import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('D:/suibian/Documents/media-api-console/node_modules/playwright-core');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find(p=>p.url().includes('workspace.html'));
await page.goto('http://localhost:4273/workspace.html',{waitUntil:'networkidle'});
const result=await page.evaluate(()=>{const sels=['.copy-editor-panel','.overview-bottom','#teamMembersPanel','.sidebar','.topbar','.hero-panel','.metric-card','.image-reference-option','.production-direction','.render-asset-picker'];const out={};for(const sel of sels){const n=document.querySelector(sel);if(!n)continue;out[sel]={style:n.getAttribute('style'),class:n.className,attrs:[...n.attributes].map(a=>[a.name,a.value]),before:getComputedStyle(n,'::before').cssText,after:getComputedStyle(n,'::after').cssText};}return out;});
console.log(JSON.stringify(result,null,2)); await browser.close();
