import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('D:/suibian/Documents/media-api-console/node_modules/playwright-core');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find((candidate) => candidate.url().includes('workspace'));
console.log(JSON.stringify(await page.evaluate(() => {
  const selectors = ['.health-card', '.user-chip', '.sidebar', '#teamMembersPanel', '.nav-liquid-filter'];
  return selectors.map((selector) => {
    const element = document.querySelector(selector);
    if (!element) return { selector, missing: true };
    const style = getComputedStyle(element);
    const rules = [];
    for (const sheet of document.styleSheets) {
      let cssRules;
      try { cssRules = sheet.cssRules; } catch { continue; }
      for (const rule of Array.from(cssRules || [])) {
        if (rule.selectorText && element.matches(rule.selectorText) && (rule.style.background || rule.style.backgroundColor || rule.style.getPropertyValue('--optical-glass-fill'))) {
          rules.push({ href: sheet.href, selector: rule.selectorText, background: rule.style.background, backgroundColor: rule.style.backgroundColor, fill: rule.style.getPropertyValue('--optical-glass-fill'), important: rule.style.getPropertyPriority('background') });
        }
      }
    }
    return { selector, inline: element.getAttribute('style'), background: style.background, backgroundColor: style.backgroundColor, fill: style.getPropertyValue('--optical-glass-fill'), rules: rules.slice(-8) };
  });
}), null, 2));
await browser.close();
