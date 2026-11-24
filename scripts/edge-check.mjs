import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('D:/suibian/Documents/media-api-console/node_modules/playwright-core');

const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const context = browser.contexts()[0];
const page = context.pages().find((candidate) => candidate.url().includes('workspace.html')) ?? await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`);
});

await page.goto('http://localhost:4273/workspace.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const navigationChecks = [];
for (const view of ['overview', 'strategy', 'benchmark', 'copy', 'media', 'render', 'publish', 'library', 'assets', 'account', 'support', 'templates', 'history']) {
  await page.locator(`.nav-item[data-view="${view}"]`).click();
  await page.waitForTimeout(120);
  navigationChecks.push(await page.evaluate((expectedView) => ({
    expectedView,
    activeView: document.querySelector('.nav-item.active')?.dataset.view ?? null,
    visibleView: [...document.querySelectorAll('.content-view')].find((node) => !node.classList.contains('hidden'))?.id ?? null,
  }), view));
}
await page.locator('.nav-item[data-view="strategy"]').click();
await page.waitForTimeout(500);

const report = await page.evaluate(() => ({
  title: document.title,
  language: document.documentElement.lang,
  bodyChildren: document.body.children.length,
  visibleViews: [...document.querySelectorAll('.content-view')]
    .filter((view) => !view.classList.contains('hidden'))
    .map((view) => view.id),
  navigation: [...document.querySelectorAll('.nav-item')].map((button) => button.dataset.view),
  activeNavigation: document.querySelector('.nav-item.active')?.dataset.view ?? null,
  liquidScripts: [...document.scripts]
    .map((script) => script.src)
    .filter((src) => src.includes('liquid') || src.includes('optical')),
  glassNodes: document.querySelectorAll('[data-liquid-glass], .liquid-glass, .optical-glass').length,
  liquidNavigation: (() => {
    const nav = document.querySelector('.nav-list');
    const indicator = nav?.querySelector('.nav-liquid-indicator');
    if (!nav || !indicator) return null;
    const style = getComputedStyle(indicator);
    const rect = indicator.getBoundingClientRect();
    return {
      ready: nav.dataset.liquidNavReady === 'true',
      classes: nav.className,
      display: style.display,
      opacity: style.opacity,
      transform: style.transform,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      opticalLayers: indicator.children.length,
    };
  })(),
  malformedTextarea: document.querySelector('#copyLibraryTextInput')?.getAttribute('placeholder'),
  mojibake: /[\uFFFD]|[\uE000-\uF8FF]/.test(document.body.textContent),
  bodyText: document.body.innerText.slice(0, 800),
  auth: (() => {
    const node = document.querySelector('.auth-shell');
    if (!node) return null;
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return { display: style.display, visibility: style.visibility, opacity: style.opacity, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, html: node.innerHTML.slice(0, 300) };
  })(),
  workspace: (() => {
    const node = document.querySelector('.workspace-shell');
    if (!node) return null;
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return { display: style.display, visibility: style.visibility, opacity: style.opacity, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
  })(),
  layers: [
    ['auth-shell', '.auth-shell'],
    ['auth-brand', '.auth-brand'],
    ['auth-form-panel', '.auth-form-panel'],
    ['auth-title', '#authTitle'],
  ].map(([name, selector]) => {
    const node = document.querySelector(selector);
    if (!node) return { name, missing: true };
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return { name, color: style.color, background: style.backgroundColor, zIndex: style.zIndex, filter: style.filter, transform: style.transform, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
  }),
  elementAtCenter: document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.className,
}));

console.log(JSON.stringify({ report: { ...report, navigationChecks }, errors }, null, 2));
await page.screenshot({ path: 'artifacts/edge-workspace-recovery.png', fullPage: false });
await browser.close();
