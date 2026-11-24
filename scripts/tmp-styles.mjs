import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('D:/suibian/Documents/media-api-console/node_modules/playwright-core');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find(p=>p.url().includes('workspace.html'));
await page.goto('http://localhost:4273/workspace.html',{waitUntil:'networkidle'});
const result=await page.evaluate(()=>{const sels=['body','.app-shell','.workspace-shell','.main-content','.sidebar','.sidebar::before','.topbar','.hero-panel','.hero-panel::before','.hero-panel::after','.metric-card','.metric-card::before','.metric-card::after','.overview-bottom','.task-panel','.output-panel','.copy-editor-panel','.copy-editor-panel::before','.copy-source-controls','.copy-value','.script-box','#teamMembersPanel','.team-member-form','.team-member-row','.image-reference-option','.production-direction','.render-asset-picker'];const out={};for(const sel of sels){const [base,pseudo]=sel.split('::');const n=document.querySelector(base);if(!n){out[sel]=null;continue;}const s=getComputedStyle(n,pseudo?`::${pseudo}`:undefined);out[sel]={bg:s.backgroundColor,bgi:s.backgroundImage,opacity:s.opacity,filter:s.filter,backdrop:s.backdropFilter,shadow:s.boxShadow,border:s.border,position:s.position,display:s.display,transform:s.transform};}return out;});
console.log(JSON.stringify(result,null,2));
await browser.close();
