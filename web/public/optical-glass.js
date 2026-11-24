const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const supportsSvgBackdrop = CSS.supports('backdrop-filter', 'url("#test")')
  || CSS.supports('-webkit-backdrop-filter', 'url("#test")');

let filterSequence = 0;
let defs = null;

const surfaceSelector = [
  '.workspace-shell .sidebar', '.workspace-page .topbar', '.workspace-page .panel',
  '.workspace-page .workflow-strip', '.workspace-page .metric-card', '.workspace-page .feature-card',
  '.workspace-page .template-card', '.workspace-page .asset-card', '.workspace-page .platform-card',
  '.workspace-page .image-output-card', '.workspace-page .copy-library-item', '.workspace-page .media-library-item',
  '.workspace-page .history-list', '.workspace-page .production-mode-panel', '.workspace-page .profile-panel',
  '.workspace-page .hero-panel', '.workspace-page .hero-console', '.workspace-page .output-panel',
  '.workspace-page .copy-editor-panel', '.workspace-page .image-studio-panel', '.workspace-page .jianying-root-bar',
  '.workspace-page .health-card', '.workspace-page .user-chip', '.workspace-page .result-block',
  '.workspace-page .provider-config-panel', '.workspace-page .ui-select-trigger',
  '.admin-shell .sidebar', '.admin-page .topbar', '.admin-page .panel', '.admin-page .metric-card',
  '.admin-page .feature-card', '.admin-page .table-card', '.admin-page .provider-config-panel',
  '.admin-page .hero-panel', '.admin-page .health-card', '.admin-page .user-chip', '.admin-page .result-block',
  '.admin-page .ui-select-trigger',
  '.modal', '.asset-preview-dialog', '.ui-action-dialog', '.ui-select-popover',
  '.auth-shell', '.home-nav-shell', '.home-product-window'
].join(',');

const searchSelector = [
  'input[type="search"]', '#assetSearchInput', 'input[id*="Search"]', 'input[id*="search"]', '.ui-select-search'
].join(',');

const materialByType = {
  structural: { blur: 1, saturation: 6, opacity: .38, thickness: 92, refractiveIndex: 1.3 },
  panel: { blur: 1, saturation: 6, opacity: .4, thickness: 82, refractiveIndex: 1.3 },
  card: { blur: .65, saturation: 5, opacity: .32, thickness: 66, refractiveIndex: 1.32 },
  overlay: { blur: 1.25, saturation: 6, opacity: .42, thickness: 96, refractiveIndex: 1.3 },
  search: { blur: 1, saturation: 4, opacity: .2, thickness: 70, refractiveIndex: 1.5 },
  player: { blur: 1, saturation: 6, opacity: .4, thickness: 90, refractiveIndex: 1.3 },
  slider: { blur: 0, saturation: 7, opacity: .4, thickness: 80, refractiveIndex: 1.45 },
  switch: { blur: .2, saturation: 6, opacity: .5, thickness: 47, refractiveIndex: 1.5 }
};

const surfaceState = new WeakMap();
const rangeState = new WeakMap();
const audioState = new WeakMap();
const switchState = new WeakMap();
// Keep the thumb travel equal to track width minus thumb width so a dragged
// switch lands cleanly on either edge after the larger 68x38 geometry.
const SWITCH_TRAVEL = 34;
// Filter construction rasterizes several textures. Reuse an identical filter
// for cards with the same geometry instead of rebuilding it per element.
const filterCache = new Map();
let filterCacheClock = 0;
const MAX_FILTER_CACHE = 64;
const fillByType = {
  // Keep the material clear enough for the animated spectrum underneath.
  // The bezel, shadow and specular layers provide separation; a bright fill
  // here becomes a white mask because this value is applied inline.
  structural: 'rgba(255,255,255,.018)', panel: 'rgba(255,255,255,.010)', card: 'rgba(255,255,255,.006)',
  overlay: 'rgba(255,255,255,.028)', search: 'rgba(255,255,255,.008)', player: 'rgba(255,255,255,.014)'
};
const finishByType = {
  structural: { blur: '.6px', saturation: '1.07' }, panel: { blur: '.35px', saturation: '1.05' },
  card: { blur: '.18px', saturation: '1.05' }, overlay: { blur: '.8px', saturation: '1.09' },
  search: { blur: '.65px', saturation: '1.03' }, player: { blur: '.75px', saturation: '1.06' }
};

function ensureDefs() {
  if (defs) return defs;
  let svg = document.getElementById('optical-glass-defs');
  if (!svg) {
    svg = document.createElementNS(SVG_NS, 'svg');
    svg.id = 'optical-glass-defs';
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.classList.add('optical-glass-defs');
    svg.append(document.createElementNS(SVG_NS, 'defs'));
    document.body.prepend(svg);
  }
  defs = svg.querySelector('defs');
  return defs;
}

function smoothStep(a, b, value) {
  const t = Math.max(0, Math.min(1, (value - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// Port of the reference page's Snell-law bezel profile.
function createRefractionProfile(glassThickness = 200, bezelWidth = 50, refractiveIndex = 1.5, samples = 128) {
  const inverseIndex = 1 / refractiveIndex;
  const height = (value) => Math.pow(1 - Math.pow(1 - value, 4), 1 / 4);
  const refract = (normalX, normalY) => {
    const cosine = normalY;
    const discriminant = 1 - inverseIndex * inverseIndex * (1 - cosine * cosine);
    if (discriminant < 0) return null;
    const root = Math.sqrt(discriminant);
    return [-(inverseIndex * cosine + root) * normalX, inverseIndex - (inverseIndex * cosine + root) * normalY];
  };
  return Array.from({ length: samples }, (_, index) => {
    const progress = index / samples;
    const bezelHeight = height(progress);
    const epsilon = progress < 1 ? 1e-4 : -1e-4;
    const derivative = (height(progress + epsilon) - bezelHeight) / epsilon;
    const normalLength = Math.hypot(derivative, 1);
    const ray = refract(-derivative / normalLength, -1 / normalLength);
    if (!ray) return 0;
    return ray[0] * ((bezelHeight * bezelWidth + glassThickness) / ray[1]);
  });
}

function canvasUrl(imageData) {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const context = canvas.getContext('2d');
  context.putImageData(imageData, 0, 0);
  return canvas.toDataURL('image/png');
}

// Port of the reference page's rounded-bezel displacement texture.
function createDisplacementTexture({ canvasWidth, canvasHeight, width, height, radius, bezelWidth, maxRefraction, profile, dpr }) {
  const pixelWidth = Math.max(1, Math.round(canvasWidth * dpr));
  const pixelHeight = Math.max(1, Math.round(canvasHeight * dpr));
  const data = new ImageData(pixelWidth, pixelHeight);
  new Uint32Array(data.data.buffer).fill(0xff008080);
  const pixelRadius = radius * dpr;
  const pixelBezel = Math.max(1, bezelWidth * dpr);
  const radiusSquared = pixelRadius ** 2;
  const outerSquared = (pixelRadius + 1) ** 2;
  const innerSquared = Math.max(0, pixelRadius - pixelBezel) ** 2;
  const elementWidth = Math.min(pixelWidth, Math.round(width * dpr));
  const elementHeight = Math.min(pixelHeight, Math.round(height * dpr));
  const horizontalSpan = elementWidth - pixelRadius * 2;
  const verticalSpan = elementHeight - pixelRadius * 2;
  const offsetX = (pixelWidth - elementWidth) / 2;
  const offsetY = (pixelHeight - elementHeight) / 2;

  for (let y = 0; y < elementHeight; y += 1) {
    for (let x = 0; x < elementWidth; x += 1) {
      const index = ((Math.floor(offsetY + y) * pixelWidth) + Math.floor(offsetX + x)) * 4;
      const left = x < pixelRadius;
      const right = x >= elementWidth - pixelRadius;
      const top = y < pixelRadius;
      const bottom = y >= elementHeight - pixelRadius;
      const cornerX = left ? x - pixelRadius : right ? x - pixelRadius - horizontalSpan : 0;
      const cornerY = top ? y - pixelRadius : bottom ? y - pixelRadius - verticalSpan : 0;
      const squaredDistance = cornerX * cornerX + cornerY * cornerY;
      if (squaredDistance > outerSquared || squaredDistance < innerSquared) continue;
      const edgeAlpha = squaredDistance < radiusSquared
        ? 1
        : 1 - (Math.sqrt(squaredDistance) - Math.sqrt(radiusSquared)) / Math.max(1, Math.sqrt(outerSquared) - Math.sqrt(radiusSquared));
      const distance = Math.sqrt(Math.max(squaredDistance, .0001));
      const depth = pixelRadius - distance;
      const normalX = cornerX / distance;
      const normalY = cornerY / distance;
      const profileIndex = Math.max(0, Math.min(profile.length - 1, Math.floor((depth / pixelBezel) * profile.length)));
      const refraction = profile[profileIndex] || 0;
      const dx = -normalX * refraction / Math.max(maxRefraction, .0001);
      const dy = -normalY * refraction / Math.max(maxRefraction, .0001);
      data.data[index] = 128 + dx * 127 * edgeAlpha;
      data.data[index + 1] = 128 + dy * 127 * edgeAlpha;
      data.data[index + 2] = 0;
      data.data[index + 3] = 255;
    }
  }
  return data;
}

// Port of the reference page's directional specular texture.
function createSpecularTexture({ width, height, radius, dpr, thickness = 50, lightAngle = Math.PI / 3 }) {
  const pixelWidth = Math.max(1, Math.round(width * dpr));
  const pixelHeight = Math.max(1, Math.round(height * dpr));
  const data = new ImageData(pixelWidth, pixelHeight);
  const pixelRadius = radius * dpr;
  const pixelThickness = thickness * dpr;
  const light = [Math.cos(lightAngle), Math.sin(lightAngle)];
  const radiusSquared = pixelRadius ** 2;
  const outerSquared = (pixelRadius + dpr) ** 2;
  const innerSquared = Math.max(0, pixelRadius - pixelThickness) ** 2;
  const horizontalSpan = pixelWidth - pixelRadius * 2;
  const verticalSpan = pixelHeight - pixelRadius * 2;

  for (let y = 0; y < pixelHeight; y += 1) {
    for (let x = 0; x < pixelWidth; x += 1) {
      const index = (y * pixelWidth + x) * 4;
      const left = x < pixelRadius;
      const right = x >= pixelWidth - pixelRadius;
      const top = y < pixelRadius;
      const bottom = y >= pixelHeight - pixelRadius;
      const cornerX = left ? x - pixelRadius : right ? x - pixelRadius - horizontalSpan : 0;
      const cornerY = top ? y - pixelRadius : bottom ? y - pixelRadius - verticalSpan : 0;
      const squaredDistance = cornerX * cornerX + cornerY * cornerY;
      if (squaredDistance > outerSquared || squaredDistance < innerSquared) continue;
      const distance = Math.sqrt(Math.max(squaredDistance, .0001));
      const depth = pixelRadius - distance;
      const outerFade = squaredDistance < radiusSquared
        ? 1
        : 1 - (distance - Math.sqrt(radiusSquared)) / Math.max(.001, Math.sqrt(outerSquared) - Math.sqrt(radiusSquared));
      const normalX = cornerX / distance;
      const normalY = -cornerY / distance;
      const facing = Math.abs(normalX * light[0] + normalY * light[1]);
      const curvature = Math.sqrt(Math.max(0, 1 - (1 - depth / Math.max(dpr, .001)) ** 2));
      const intensity = 255 * facing * curvature;
      const alpha = intensity * facing * outerFade;
      data.data[index] = intensity;
      data.data[index + 1] = intensity;
      data.data[index + 2] = intensity;
      data.data[index + 3] = alpha;
    }
  }
  return data;
}

// The reference magnifier uses a separate, gentle inner lens before the
// stronger Snell-law bezel refraction. Keeping it separate preserves detail
// in the center while the rim bends the background more aggressively.
function createMagnificationTexture({ width, height, radius, dpr, amount = .82 }) {
  const pixelWidth = Math.max(1, Math.round(width * dpr));
  const pixelHeight = Math.max(1, Math.round(height * dpr));
  const data = new ImageData(pixelWidth, pixelHeight);
  const safeRadius = Math.max(1, Math.min(radius * dpr, pixelWidth / 2, pixelHeight / 2));
  const innerWidth = Math.max(1, pixelWidth - safeRadius * 2);
  const innerHeight = Math.max(1, pixelHeight - safeRadius * 2);

  for (let y = 0; y < pixelHeight; y += 1) {
    for (let x = 0; x < pixelWidth; x += 1) {
      const centeredX = x - pixelWidth / 2;
      const centeredY = y - pixelHeight / 2;
      const qx = Math.abs(centeredX) - innerWidth / 2;
      const qy = Math.abs(centeredY) - innerHeight / 2;
      const outsideX = Math.max(qx, 0);
      const outsideY = Math.max(qy, 0);
      const signedDistance = Math.min(Math.max(qx, qy), 0) + Math.hypot(outsideX, outsideY) - safeRadius;
      const edgeFade = 1 - smoothStep(-Math.max(2, safeRadius * .44), 1, signedDistance);
      const nx = centeredX / Math.max(pixelWidth / 2, 1);
      const ny = centeredY / Math.max(pixelHeight / 2, 1);
      const index = (y * pixelWidth + x) * 4;
      data.data[index] = Math.round(Math.max(0, Math.min(1, .5 - nx * amount * .5 * edgeFade)) * 255);
      data.data[index + 1] = Math.round(Math.max(0, Math.min(1, .5 - ny * amount * .5 * edgeFade)) * 255);
      data.data[index + 2] = 0;
      data.data[index + 3] = 255;
    }
  }
  return data;
}

function appendPrimitive(filter, tag, attributes = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, String(value)));
  filter.append(node);
  return node;
}

function createFilter(type, width, height, radius) {
  const material = materialByType[type] || materialByType.panel;
  const id = `optical-glass-${type}-${++filterSequence}`;
  const filter = document.createElementNS(SVG_NS, 'filter');
  filter.id = id;
  filter.setAttribute('filterUnits', 'userSpaceOnUse');
  filter.setAttribute('color-interpolation-filters', 'sRGB');
  filter.setAttribute('x', '0');
  filter.setAttribute('y', '0');
  filter.setAttribute('width', String(width));
  filter.setAttribute('height', String(height));

  appendPrimitive(filter, 'feGaussianBlur', { in: 'SourceGraphic', stdDeviation: material.blur, result: 'blurred_source' });
  const displacementImage = appendPrimitive(filter, 'feImage', { x: 0, y: 0, width, height, result: 'displacement_map', preserveAspectRatio: 'none' });
  const displacement = appendPrimitive(filter, 'feDisplacementMap', {
    in: 'blurred_source', in2: 'displacement_map', xChannelSelector: 'R', yChannelSelector: 'G', result: 'displaced'
  });
  appendPrimitive(filter, 'feColorMatrix', { in: 'displaced', type: 'saturate', values: material.saturation, result: 'displaced_saturated' });
  const specularImage = appendPrimitive(filter, 'feImage', { x: 0, y: 0, width, height, result: 'specular_layer', preserveAspectRatio: 'none' });
  appendPrimitive(filter, 'feComposite', { in: 'displaced_saturated', in2: 'specular_layer', operator: 'in', result: 'specular_saturated' });
  const transfer = appendPrimitive(filter, 'feComponentTransfer', { in: 'specular_layer', result: 'specular_faded' });
  const alpha = document.createElementNS(SVG_NS, 'feFuncA');
  alpha.setAttribute('type', 'linear');
  alpha.setAttribute('slope', String(material.opacity));
  transfer.append(alpha);
  appendPrimitive(filter, 'feBlend', { in: 'specular_saturated', in2: 'displaced', mode: 'normal', result: 'withSaturation' });
  appendPrimitive(filter, 'feBlend', { in: 'specular_faded', in2: 'withSaturation', mode: 'normal' });
  ensureDefs().append(filter);

  const safeRadius = Math.max(3, Math.min(radius, width / 2, height / 2));
  const bezelWidth = Math.max(2, Math.min(safeRadius - 1, type === 'card' ? 7 : type === 'search' ? safeRadius - 1 : 12));
  const profile = createRefractionProfile(material.thickness, bezelWidth, material.refractiveIndex);
  const maxRefraction = Math.max(...profile.map((value) => Math.abs(value)), 1);
  const longest = Math.max(width, height);
  const dpr = Math.max(.32, Math.min(.72, 520 / longest, window.devicePixelRatio || 1));
  const displacementUrl = canvasUrl(createDisplacementTexture({
    canvasWidth: width, canvasHeight: height, width, height, radius: safeRadius,
    bezelWidth, maxRefraction, profile, dpr
  }));
  const specularUrl = canvasUrl(createSpecularTexture({
    width, height, radius: safeRadius, dpr, thickness: Math.min(50, Math.max(10, safeRadius * 1.7))
  }));
  displacementImage.setAttribute('href', displacementUrl);
  displacementImage.setAttributeNS(XLINK_NS, 'href', displacementUrl);
  displacement.setAttribute('scale', String(maxRefraction));
  specularImage.setAttribute('href', specularUrl);
  specularImage.setAttributeNS(XLINK_NS, 'href', specularUrl);
  return { id, filter };
}

function filterCacheKey(type, width, height, radius) {
  const dpr = Math.round((window.devicePixelRatio || 1) * 100) / 100;
  return `${type}:${width}:${height}:${Math.round(radius * 10) / 10}:${dpr}`;
}

function pruneFilterCache() {
  if (filterCache.size <= MAX_FILTER_CACHE) return;
  const removable = [...filterCache.entries()]
    .filter(([, entry]) => entry.refs === 0)
    .sort(([, a], [, b]) => a.lastUsed - b.lastUsed);
  while (filterCache.size > MAX_FILTER_CACHE && removable.length) {
    const [key, entry] = removable.shift();
    entry.filter.remove();
    filterCache.delete(key);
  }
}

function acquireFilter(type, width, height, radius) {
  const key = filterCacheKey(type, width, height, radius);
  const cached = filterCache.get(key);
  if (cached) {
    cached.refs += 1;
    cached.lastUsed = ++filterCacheClock;
    return { ...cached, key };
  }
  const optical = createFilter(type, width, height, radius);
  const entry = { ...optical, refs: 1, lastUsed: ++filterCacheClock };
  filterCache.set(key, entry);
  pruneFilterCache();
  return { ...entry, key };
}

function releaseFilter(key) {
  const entry = filterCache.get(key);
  if (entry) entry.refs = Math.max(0, entry.refs - 1);
}

function surfaceType(element) {
  if (element.matches('.sidebar, .topbar, .home-nav-shell')) return 'structural';
  if (element.matches('.modal, .asset-preview-dialog, .ui-action-dialog, .ui-select-popover, .auth-shell')) return 'overlay';
  if (element.matches('.metric-card, .feature-card, .template-card, .asset-card, .platform-card, .image-output-card, .copy-library-item, .media-library-item')) return 'card';
  return 'panel';
}

function usesWorkspaceBackdrop(element) {
  // The workspace is a long, continuously scrolled surface. Backdrop sampling
  // for every panel/card makes scrolling repaint the page beneath each item.
  // Dialogs remain optical because they are transient and do not participate in
  // the normal scroll path. Tabs and switches use separate liquid filters.
  return !element.closest('body.workspace-page')
    || element.matches('.modal, .asset-preview-dialog, .ui-action-dialog, .ui-select-popover');
}

function measureSurface(element, type, sizeHint) {
  if (!supportsSvgBackdrop || !element.isConnected) return;
  // ResizeObserver already gives us box geometry after layout.  Using it here
  // avoids forcing a fresh layout for every card revealed by a tab switch.
  const rect = sizeHint ? null : element.getBoundingClientRect();
  const width = Math.round(sizeHint?.width ?? rect.width);
  const height = Math.round(sizeHint?.height ?? rect.height);
  if (width < 20 || height < 20) return;
  const previous = surfaceState.get(element);
  if (previous && Math.abs(previous.width - width) < 5 && Math.abs(previous.height - height) < 5 && previous.type === type) return;
  // Corner radii are static for these components.  Reusing the previous value
  // prevents a computed-style read during resize and view-switch bursts.
  const declaredRadius = previous?.type === type ? previous.radius : parseFloat(getComputedStyle(element).borderTopLeftRadius);
  const radius = Math.max(3, Math.min(declaredRadius || 8, width / 2, height / 2));
  return { element, type, width, height, radius, previous };
}

function updateSurface(element, type = surfaceType(element), measured = measureSurface(element, type)) {
  if (!measured) return;
  const { width, height, radius, previous } = measured;
  if (previous?.filterKey) releaseFilter(previous.filterKey);
  const optical = acquireFilter(type, width, height, radius);
  element.classList.add('optical-glass-surface', `optical-glass-${type}`);
  element.style.setProperty('--optical-glass-filter', `url(#${optical.id})`);
  const finish = finishByType[type] || finishByType.panel;
  // Keep the fill themeable. The old inline !important background turned every
  // surface into a white mask and prevented the light-liquid stylesheet from
  // controlling transparency per component.
  element.style.setProperty('--optical-glass-fill', fillByType[type] || fillByType.panel);
  element.style.setProperty('backdrop-filter', `url(#${optical.id}) blur(${finish.blur}) saturate(${finish.saturation})`, 'important');
  element.style.setProperty('-webkit-backdrop-filter', `url(#${optical.id}) blur(${finish.blur}) saturate(${finish.saturation})`, 'important');
  surfaceState.set(element, { type, width, height, radius, filter: optical.filter, filterKey: optical.key });
}

const pendingSurfaceUpdates = new Map();
let surfaceUpdateFrame = 0;
let surfaceIdleHandle = 0;
const MAX_SURFACE_UPDATES_PER_FRAME = 1;

function scheduleIdle(callback) {
  if ('requestIdleCallback' in window) return window.requestIdleCallback(callback, { timeout: 180 });
  return window.setTimeout(() => callback({ didTimeout: true, timeRemaining: () => 0 }), 80);
}

function runSurfaceUpdates(limit = Infinity, deferredOnly = false) {
  let handled = 0;
  for (const [element, pending] of pendingSurfaceUpdates) {
    if (handled >= limit || (deferredOnly ? !pending.deferred : pending.deferred)) continue;
    pendingSurfaceUpdates.delete(element);
    const measured = measureSurface(element, pending.type, pending.size);
    if (measured) updateSurface(element, pending.type, measured);
    handled += 1;
  }
  return handled;
}

function scheduleSurfaceFrame() {
  if (surfaceUpdateFrame) return;
  surfaceUpdateFrame = requestAnimationFrame(() => {
    surfaceUpdateFrame = 0;
    // A known surface needs to catch up with a resize, but one expensive SVG
    // texture per frame keeps a click or an active tab lens inside budget.
    runSurfaceUpdates(MAX_SURFACE_UPDATES_PER_FRAME);
    if ([...pendingSurfaceUpdates.values()].some((pending) => !pending.deferred)) scheduleSurfaceFrame();
    if ([...pendingSurfaceUpdates.values()].some((pending) => pending.deferred)) scheduleSurfaceIdle();
  });
}

function scheduleSurfaceIdle() {
  if (surfaceIdleHandle) return;
  surfaceIdleHandle = scheduleIdle((deadline) => {
    surfaceIdleHandle = 0;
    const interactionInFlight = document.querySelector('.liquid-segment-host:is(.is-moving, .is-pressed, .is-dragging)');
    const pendingInput = navigator.scheduling?.isInputPending?.({ includeContinuous: true });
    // SVG texture creation is deliberately opportunistic.  It must never take
    // the time slice reserved for a tap, a drag or the liquid tab indicator.
    if (interactionInFlight || pendingInput || (!deadline.didTimeout && deadline.timeRemaining() < 24)) {
      scheduleSurfaceFrame();
      return;
    }
    // A newly revealed panel still has its normal glass styling.  Construct
    // only one optical map after paint so it cannot delay the tab feedback.
    runSurfaceUpdates(1, true);
    // Yield one visual frame between texture builds. requestIdleCallback may
    // otherwise invoke consecutive tasks in one long idle period.
    if ([...pendingSurfaceUpdates.values()].some((pending) => pending.deferred)) scheduleSurfaceFrame();
  });
}

function scheduleSurfaceUpdate(element, type = surfaceType(element), {
  size,
  deferred = !surfaceState.has(element)
} = {}) {
  if (!element?.isConnected) return;
  const previous = pendingSurfaceUpdates.get(element);
  pendingSurfaceUpdates.set(element, {
    type,
    size: size || previous?.size,
    // A surface already on screen must not be demoted by a duplicate IO event.
    deferred: previous ? previous.deferred && deferred : deferred
  });
  if (deferred) scheduleSurfaceIdle();
  else scheduleSurfaceFrame();
}

function observerSize(entry) {
  const borderBox = Array.isArray(entry.borderBoxSize) ? entry.borderBoxSize[0] : entry.borderBoxSize;
  if (borderBox) return { width: borderBox.inlineSize, height: borderBox.blockSize };
  return { width: entry.contentRect.width, height: entry.contentRect.height };
}

const resizeObserver = new ResizeObserver((entries) => {
  entries.forEach((entry) => scheduleSurfaceUpdate(
    entry.target,
    entry.target.dataset.opticalGlassType || surfaceType(entry.target),
    { size: observerSize(entry), deferred: !surfaceState.has(entry.target) }
  ));
});

const intersectionObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    const type = entry.target.dataset.opticalGlassType || surfaceType(entry.target);
    scheduleSurfaceUpdate(entry.target, type, {
      size: { width: entry.boundingClientRect.width, height: entry.boundingClientRect.height },
      deferred: !surfaceState.has(entry.target)
    });
    resizeObserver.observe(entry.target);
    intersectionObserver.unobserve(entry.target);
  });
}, { rootMargin: '120px' });

function observeSurface(element, type) {
  if (element.dataset.opticalGlassObserved) return;
  element.dataset.opticalGlassObserved = 'true';
  const surfaceKind = type || surfaceType(element);
  element.dataset.opticalGlassType = surfaceKind;
  // Keep only the two persistent structural surfaces blurred in the workspace.
  // Lists and cards still use the lightweight no-backdrop path for smooth scroll.
  if (element.matches('.topbar, .sidebar') && element.closest('body.workspace-page, body.admin-page')) {
    element.classList.add('optical-glass-surface', 'optical-glass-structural');
    element.style.setProperty('--optical-glass-fill', fillByType.structural);
    element.style.setProperty('backdrop-filter', 'blur(18px) saturate(140%)', 'important');
    element.style.setProperty('-webkit-backdrop-filter', 'blur(18px) saturate(140%)', 'important');
    return;
  }
  if (!usesWorkspaceBackdrop(element)) {
    element.classList.add('optical-glass-surface', `optical-glass-${surfaceKind}`);
    element.style.setProperty('--optical-glass-fill', fillByType[surfaceKind] || fillByType.panel);
    // Set this inline so legacy stylesheet rules cannot re-enable a large
    // backdrop surface after this lightweight path has been selected.
    element.style.setProperty('backdrop-filter', 'none', 'important');
    element.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
    return;
  }
  // Repeated cards are the high-count part of long workspaces. Their fill,
  // rim and subtle blur still read as glass, while skipping the SVG backdrop
  // map avoids a separate filtered paint for every scrolling card.
  if (surfaceKind === 'card') {
    const finish = finishByType.card;
    element.classList.add('optical-glass-surface', 'optical-glass-card');
    element.style.setProperty('--optical-glass-fill', fillByType.card);
    element.style.setProperty('backdrop-filter', `blur(${finish.blur}) saturate(${finish.saturation})`, 'important');
    element.style.setProperty('-webkit-backdrop-filter', `blur(${finish.blur}) saturate(${finish.saturation})`, 'important');
    return;
  }
  intersectionObserver.observe(element);
}

function decorateSearch(input) {
  if (input.dataset.opticalSearchReady) return;
  input.dataset.opticalSearchReady = 'true';
  input.classList.add('optical-search');
  observeSurface(input, 'search');
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function updateRange(input) {
  const state = rangeState.get(input);
  if (!state) return;
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const value = Number(input.value || 0);
  const ratio = max === min ? 0 : Math.max(0, Math.min(1, (value - min) / (max - min)));
  state.shell.style.setProperty('--optical-range-progress', String(ratio));
}

function decorateRange(input) {
  if (input.dataset.opticalRangeReady || input.closest('.optical-range')) return input.closest('.optical-range');
  input.dataset.opticalRangeReady = 'true';
  const shell = document.createElement('span');
  shell.className = 'optical-range';
  const track = document.createElement('span');
  track.className = 'optical-range-track';
  const fill = document.createElement('span');
  fill.className = 'optical-range-fill';
  const thumb = document.createElement('span');
  thumb.className = 'optical-range-thumb';
  input.parentNode.insertBefore(shell, input);
  shell.append(track, fill, thumb, input);
  input.classList.add('optical-range-input');
  rangeState.set(input, { shell, thumb });
  input.addEventListener('input', () => updateRange(input));
  input.addEventListener('change', () => updateRange(input));
  input.addEventListener('pointerdown', () => shell.classList.add('is-active'));
  input.addEventListener('pointerup', () => shell.classList.remove('is-active'));
  input.addEventListener('pointercancel', () => shell.classList.remove('is-active'));
  input.addEventListener('focus', () => shell.classList.add('is-focused'));
  input.addEventListener('blur', () => shell.classList.remove('is-focused', 'is-active'));
  updateRange(input);
  return shell;
}

function updateSwitchVisual(input) {
  const ratio = input.checked ? 1 : 0;
  const shell = switchState.get(input)?.shell || input.parentElement;
  input.style.setProperty('--switch-progress', String(ratio));
  input.style.setProperty('--switch-offset', `${ratio * SWITCH_TRAVEL}px`);
  if (shell?.classList?.contains('optical-switch-shell')) {
    shell.classList.toggle('is-checked', ratio === 1);
    shell.classList.toggle('is-disabled', input.disabled);
    shell.style.setProperty('--switch-progress', String(ratio));
    shell.style.setProperty('--switch-offset', `${ratio * SWITCH_TRAVEL}px`);
  }
}

function decorateSwitch(input) {
  if (switchState.has(input)) return;
  input.classList.add('optical-switch');
  const shell = document.createElement('span');
  shell.className = 'optical-switch-shell';
  input.parentNode?.insertBefore(shell, input);
  shell.append(input);
  const state = {
    shell,
    pointerId: null,
    startX: 0,
    startProgress: 0,
    dragging: false,
    suppressClick: false,
    dragChecked: input.checked
  };
  switchState.set(input, state);
  updateSwitchVisual(input);

  input.addEventListener('pointerdown', (event) => {
    if (input.disabled) return;
    state.pointerId = event.pointerId;
    state.startX = event.clientX;
    state.startProgress = input.checked ? 1 : 0;
    state.dragging = false;
    state.dragChecked = input.checked;
    shell.classList.add('is-switch-pressing');
    try { input.setPointerCapture(event.pointerId); } catch (_) { /* optional */ }
  });
  input.addEventListener('pointermove', (event) => {
    if (state.pointerId !== event.pointerId || input.disabled) return;
    const delta = event.clientX - state.startX;
    if (!state.dragging && Math.abs(delta) < 4) return;
    state.dragging = true;
    shell.classList.add('is-switch-dragging');
    event.preventDefault();
    const progress = Math.max(0, Math.min(1, state.startProgress + delta / SWITCH_TRAVEL));
    const stretch = Math.min(.14, Math.abs(delta) / 42 * .14);
    input.style.setProperty('--switch-scale-x', (0.82 + stretch).toFixed(3));
    input.style.setProperty('--switch-scale-y', (0.74 - stretch * .28).toFixed(3));
    input.style.setProperty('--switch-progress', progress.toFixed(3));
    input.style.setProperty('--switch-offset', `${(progress * SWITCH_TRAVEL).toFixed(3)}px`);
    const next = progress >= .5;
    if (input.checked !== next) {
      input.checked = next;
      state.dragChecked = next;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  const end = (event) => {
    if (state.pointerId !== event.pointerId) return;
    if (state.dragging) {
      state.dragChecked = input.checked;
      state.suppressClick = true;
      input.checked = state.dragChecked;
      input.style.setProperty('--switch-progress', state.dragChecked ? '1' : '0');
      input.style.setProperty('--switch-offset', state.dragChecked ? `${SWITCH_TRAVEL}px` : '0px');
    }
    state.pointerId = null;
    state.dragging = false;
    shell.classList.remove('is-switch-pressing');
    input.style.setProperty('--switch-scale-x', '1');
    input.style.setProperty('--switch-scale-y', '1');
    shell.classList.remove('is-switch-dragging');
    try { input.releasePointerCapture?.(event.pointerId); } catch (_) { /* optional */ }
  };
  input.addEventListener('pointerup', end);
  input.addEventListener('pointercancel', end);
  input.addEventListener('click', (event) => {
    if (state.suppressClick) {
      event.preventDefault();
      event.stopPropagation();
      input.checked = state.dragChecked;
      state.suppressClick = false;
      updateSwitchVisual(input);
      return;
    }
    updateSwitchVisual(input);
  });
  input.addEventListener('input', () => updateSwitchVisual(input));
  input.addEventListener('change', () => updateSwitchVisual(input));
  input.addEventListener('focus', () => shell.classList.add('is-switch-focused'));
  input.addEventListener('blur', () => shell.classList.remove('is-switch-focused', 'is-switch-pressing'));
}

function decorateAudio(audio) {
  if (audioState.has(audio) || audio.closest('.optical-audio-player')) return;
  audio.controls = false;
  audio.classList.add('optical-audio-source');
  const player = document.createElement('div');
  player.className = 'optical-audio-player';
  player.dataset.opticalGlassType = 'player';
  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'optical-audio-play';
  play.setAttribute('aria-label', '播放');
  play.title = '播放';
  play.textContent = '▶';
  const progress = document.createElement('input');
  progress.type = 'range';
  progress.min = '0';
  progress.max = '1000';
  progress.step = '1';
  progress.value = '0';
  progress.setAttribute('aria-label', '播放进度');
  const time = document.createElement('output');
  time.className = 'optical-audio-time';
  time.textContent = '0:00 / --:--';
  player.append(play, progress, time);
  audio.insertAdjacentElement('afterend', player);
  decorateRange(progress);
  observeSurface(player, 'player');

  const refresh = () => {
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    if (!progress.matches(':active')) progress.value = duration ? String(Math.round(audio.currentTime / duration * 1000)) : '0';
    updateRange(progress);
    time.textContent = `${formatTime(audio.currentTime)} / ${formatTime(audio.duration)}`;
    const paused = audio.paused;
    play.textContent = paused ? '▶' : 'Ⅱ';
    play.setAttribute('aria-label', paused ? '播放' : '暂停');
    play.title = paused ? '播放' : '暂停';
  };
  play.addEventListener('click', () => { if (audio.paused) audio.play().catch(() => {}); else audio.pause(); });
  progress.addEventListener('input', () => {
    if (!Number.isFinite(audio.duration)) return;
    audio.currentTime = Number(progress.value) / 1000 * audio.duration;
    refresh();
  });
  ['loadedmetadata', 'durationchange', 'timeupdate', 'play', 'pause', 'ended'].forEach((event) => audio.addEventListener(event, refresh));
  audioState.set(audio, { player, progress, refresh });
  refresh();
}

function ensureSharedControlFilters() {
  if (!supportsSvgBackdrop) return;
  if (!document.getElementById('optical-glass-switch')) {
    const result = createFilter('switch', 48, 42, 21);
    result.filter.id = 'optical-glass-switch';
  }
  if (!document.getElementById('optical-glass-slider')) {
    const result = createFilter('slider', 54, 36, 18);
    result.filter.id = 'optical-glass-slider';
  }
}

function decorate(root = document) {
  ensureSharedControlFilters();
  const images = root.matches?.('img') ? [root] : [...root.querySelectorAll?.('img') || []];
  images.forEach((image) => { if (image.decoding !== 'async') image.decoding = 'async'; });
  const surfaces = root.matches?.(surfaceSelector) ? [root] : [...root.querySelectorAll?.(surfaceSelector) || []];
  surfaces.forEach((element) => observeSurface(element));
  const searches = root.matches?.(searchSelector) ? [root] : [...root.querySelectorAll?.(searchSelector) || []];
  searches.forEach(decorateSearch);
  const ranges = root.matches?.('input[type="range"]') ? [root] : [...root.querySelectorAll?.('input[type="range"]') || []];
  ranges.forEach(decorateRange);
  const checkboxes = root.matches?.('input[type="checkbox"]') ? [root] : [...root.querySelectorAll?.('input[type="checkbox"]') || []];
  // Asset picker choices are list-selection checkboxes, not the workspace
  // switch controls. Keeping them native prevents the large switch shell from
  // colliding with thumbnails and filenames inside the selection dialog.
  checkboxes.filter((input) => !input.matches('[data-asset-picker-choice]')).forEach(decorateSwitch);
  const audio = root.matches?.('audio') ? [root] : [...root.querySelectorAll?.('audio') || []];
  audio.forEach(decorateAudio);
}

decorate();

let decorationFrame = 0;
const pendingDecorationRoots = new Set();

function releaseRemovedSurfaces(root) {
  const surfaces = root.matches?.('.optical-glass-surface')
    ? [root]
    : [...root.querySelectorAll?.('.optical-glass-surface') || []];
  surfaces.forEach((element) => {
    const state = surfaceState.get(element);
    if (!state) return;
    releaseFilter(state.filterKey);
    surfaceState.delete(element);
  });
}

const mutationObserver = new MutationObserver((records) => {
  records.forEach((record) => {
    record.removedNodes.forEach((node) => {
      if (node.nodeType === Node.ELEMENT_NODE) releaseRemovedSurfaces(node);
    });
    record.addedNodes.forEach((node) => {
      if (node.nodeType === Node.ELEMENT_NODE) pendingDecorationRoots.add(node);
    });
  });
  if (decorationFrame || !pendingDecorationRoots.size) return;
  decorationFrame = requestAnimationFrame(() => {
    decorationFrame = 0;
    const roots = [...pendingDecorationRoots];
    pendingDecorationRoots.clear();
    roots.forEach((root) => { if (root.isConnected) decorate(root); });
  });
});
mutationObserver.observe(document.body, { childList: true, subtree: true });

window.OpticalGlass = {
  decorate,
  updateSurface,
  createRefractionMap(width, height, radius, {
    bezelWidth = Math.max(3, Math.min(radius - 1, 16)),
    glassThickness = 82,
    refractiveIndex = 1.3,
    dpr = Math.min(window.devicePixelRatio || 1, .72)
  } = {}) {
    const profile = createRefractionProfile(glassThickness, bezelWidth, refractiveIndex);
    const maxRefraction = Math.max(...profile.map((value) => Math.abs(value)), 1);
    const image = createDisplacementTexture({
      canvasWidth: width, canvasHeight: height, width, height, radius,
      bezelWidth, maxRefraction, profile, dpr
    });
    return { url: canvasUrl(image), maxRefraction };
  },
  createSpecularUrl(width, height, radius, dpr = Math.min(window.devicePixelRatio || 1, .72)) {
    return canvasUrl(createSpecularTexture({ width, height, radius, dpr, thickness: Math.min(50, Math.max(10, radius * 1.7)) }));
  },
  createMagnificationUrl(width, height, radius, dpr = Math.min(window.devicePixelRatio || 1, .72)) {
    return canvasUrl(createMagnificationTexture({ width, height, radius, dpr }));
  }
};
