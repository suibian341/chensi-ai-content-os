const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
const reactiveSurfaceSelector = [
  '.sidebar', '.top-actions', '.hero-panel', '.jianying-root-bar', '.modal',
  '.asset-preview-dialog', '.auth-shell', '.home-nav-shell', '.home-product-window'
].join(',');

const surfaceFrames = new WeakMap();
let liquidFilterMap = null;
let liquidFilterDisplacement = null;
let liquidMagnificationMap = null;
let liquidMagnificationDisplacement = null;
let liquidPhysicalMap = null;
let liquidPhysicalDisplacement = null;
let liquidSpecularMap = null;
let liquidFilterNode = null;
let liquidMapCanvas = null;
let liquidMapContext = null;
let liquidOpticalKey = '';
let segmentFilterSequence = 0;
const segmentMotionCache = new Map();
const MAX_SEGMENT_MOTION_CACHE = 32;
const pendingSegmentMotionTextures = new Map();
let segmentMotionIdleHandle = 0;

function ensureLiquidFilter() {
  if (document.getElementById('liquid-glass-defs')) return;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'liquid-glass-defs';
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  // Zero-sized inline SVGs still create a line box in some browsers. Keep the
  // filter definitions out of document flow so injecting them cannot shift
  // the workspace shell during startup.
  svg.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;display:block;overflow:hidden;pointer-events:none;';
  svg.innerHTML = `
    <defs>
      <filter id="liquid-nav-distortion" filterUnits="userSpaceOnUse" x="0" y="0" width="160" height="80" color-interpolation-filters="sRGB">
        <feImage id="liquid-nav-magnification-map" result="liquid-magnification-map" x="0" y="0" width="160" height="80" preserveAspectRatio="none"></feImage>
        <feDisplacementMap id="liquid-nav-magnification" in="SourceGraphic" in2="liquid-magnification-map" xChannelSelector="R" yChannelSelector="G" scale="24" result="liquid-magnified"></feDisplacementMap>
        <feGaussianBlur in="liquid-magnified" stdDeviation="0" result="liquid-base"></feGaussianBlur>
        <feImage id="liquid-nav-physical-map" result="liquid-physical-map" x="0" y="0" width="160" height="80" preserveAspectRatio="none"></feImage>
        <feDisplacementMap id="liquid-nav-physical-displacement" in="liquid-base" in2="liquid-physical-map" xChannelSelector="R" yChannelSelector="G" scale="98.24713343067756" result="liquid-displaced"></feDisplacementMap>
        <feColorMatrix in="liquid-displaced" type="saturate" values="9" result="liquid-saturated"></feColorMatrix>
        <feImage id="liquid-nav-specular-map" result="liquid-specular" x="0" y="0" width="160" height="80" preserveAspectRatio="none"></feImage>
        <feComposite in="liquid-saturated" in2="liquid-specular" operator="in" result="liquid-specular-saturated"></feComposite>
        <feComponentTransfer in="liquid-specular" result="liquid-specular-faded"><feFuncA type="linear" slope="0.5"></feFuncA></feComponentTransfer>
        <feBlend in="liquid-specular-saturated" in2="liquid-displaced" mode="normal" result="liquid-with-saturation"></feBlend>
        <feBlend in="liquid-specular-faded" in2="liquid-with-saturation" mode="normal"></feBlend>
      </filter>
      <filter id="liquid-generic-distortion" x="-30%" y="-45%" width="160%" height="190%" color-interpolation-filters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency="0.012 0.035" numOctaves="2" seed="8" result="noise"></feTurbulence>
        <feGaussianBlur in="noise" stdDeviation="0.7" result="softNoise"></feGaussianBlur>
        <feDisplacementMap in="SourceGraphic" in2="softNoise" scale="3" xChannelSelector="R" yChannelSelector="B"></feDisplacementMap>
      </filter>
    </defs>`;
  document.body.prepend(svg);
  liquidFilterNode = svg.querySelector('#liquid-nav-distortion');
  liquidFilterMap = svg.querySelector('#liquid-nav-displacement-map');
  liquidFilterDisplacement = svg.querySelector('#liquid-nav-displacement');
  liquidMagnificationMap = svg.querySelector('#liquid-nav-magnification-map');
  liquidMagnificationDisplacement = svg.querySelector('#liquid-nav-magnification');
  liquidPhysicalMap = svg.querySelector('#liquid-nav-physical-map');
  liquidPhysicalDisplacement = svg.querySelector('#liquid-nav-physical-displacement');
  liquidSpecularMap = svg.querySelector('#liquid-nav-specular-map');
  liquidMapCanvas = document.createElement('canvas');
  liquidMapCanvas.id = 'liquid-nav-map-canvas';
  liquidMapCanvas.setAttribute('aria-hidden', 'true');
  liquidMapCanvas.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
  document.body.append(liquidMapCanvas);
  liquidMapContext = liquidMapCanvas.getContext('2d');
}

function setSvgImageHref(image, url) {
  if (!image || !url) return;
  image.setAttribute('href', url);
  image.setAttributeNS('http://www.w3.org/1999/xlink', 'href', url);
}

function updateNavOpticalTextures(width, height) {
  const optical = window.OpticalGlass;
  if (!optical || !width || !height) return;
  const roundedWidth = Math.max(1, Math.round(width));
  const roundedHeight = Math.max(1, Math.round(height));
  const key = `${roundedWidth}:${roundedHeight}`;
  if (key === liquidOpticalKey) return;
  liquidOpticalKey = key;
  const radius = Math.max(8, Math.min(roundedHeight / 2, roundedWidth / 2));
  // Keep the captured reference filter byte-for-byte intact. Its feImage
  // textures are authored in the reference page's coordinate space; resizing
  // those images to each tab's box changes the magnifier's optical profile.
  const bezelWidth = Math.max(5, Math.min(radius - 1, 18));
  const physical = optical.createRefractionMap(roundedWidth, roundedHeight, radius, {
    bezelWidth, glassThickness: 110, refractiveIndex: 1.5, dpr: Math.min(window.devicePixelRatio || 1, .72)
  });
  const magnification = optical.createMagnificationUrl(roundedWidth, roundedHeight, radius);
  const specular = optical.createSpecularUrl(roundedWidth, roundedHeight, radius);
  liquidFilterNode?.setAttribute('width', String(roundedWidth));
  liquidFilterNode?.setAttribute('height', String(roundedHeight));
  [liquidMagnificationMap, liquidPhysicalMap, liquidFilterMap, liquidSpecularMap].forEach((image) => {
    image?.setAttribute('width', String(roundedWidth));
    image?.setAttribute('height', String(roundedHeight));
  });
  setSvgImageHref(liquidMagnificationMap, magnification);
  // The reference page's lens uses a noticeably stronger inner magnifier
  // before the bezel refraction pass. Keep it visible at navigation-chip
  // sizes instead of reducing it to a barely perceptible blur.
  liquidMagnificationDisplacement?.setAttribute('scale', String(Math.max(24, Math.min(30, roundedHeight * .4))));
  setSvgImageHref(liquidPhysicalMap, physical.url);
  // Keep the same bezel displacement strength as the supplied reference
  // filter. Its magnifier is the primary lens; the generated map remains as
  // the fallback for browsers that reject a data-backed SVG filter.
  liquidPhysicalDisplacement?.setAttribute('scale', '98.24713343067756');
  setSvgImageHref(liquidSpecularMap, specular);
}

function decorate(root = document) {
  if (reducedMotion.matches || !finePointer.matches) return;
  const surfaces = root.matches?.(reactiveSurfaceSelector)
    ? [root]
    : [...root.querySelectorAll?.(reactiveSurfaceSelector) || []];
  for (const surface of surfaces) {
    if (surface.dataset.glassReady) continue;
    surface.dataset.glassReady = 'true';
    surface.classList.add('glass-reactive');
    surface.addEventListener('pointerenter', () => surface.classList.add('glass-lit'));
    surface.addEventListener('pointerleave', () => {
      surface.classList.remove('glass-lit');
      surface.style.removeProperty('--glass-x');
      surface.style.removeProperty('--glass-y');
      surface.style.removeProperty('--glass-angle');
    });
    surface.addEventListener('pointermove', (event) => {
      cancelAnimationFrame(surfaceFrames.get(surface));
      surfaceFrames.set(surface, requestAnimationFrame(() => {
        const bounds = surface.getBoundingClientRect();
        if (!bounds.width || !bounds.height) return;
        const x = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
        const y = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));
        surface.style.setProperty('--glass-x', `${Math.round(x * 100)}%`);
        surface.style.setProperty('--glass-y', `${Math.round(y * 100)}%`);
        surface.style.setProperty('--glass-angle', `${Math.round(108 + (y - 0.5) * 22)}deg`);
      }));
    }, { passive: true });
  }
}

function getActiveItem(nav) {
  return nav.querySelector('.nav-item.active, a.is-active') || (nav.classList.contains('home-nav-links') ? nav.querySelector('a') : null);
}

function setupGenericLiquidNavigation(nav) {
  if (nav.dataset.liquidNavReady) return;
  nav.dataset.liquidNavReady = 'true';
  const indicator = document.createElement('span');
  indicator.className = 'nav-liquid-indicator';
  indicator.style.filter = 'url(#liquid-generic-distortion)';
  indicator.setAttribute('aria-hidden', 'true');
  indicator.innerHTML = '<span class="nav-liquid-filter"></span><span class="nav-liquid-overlay"></span><span class="nav-liquid-specular"></span>';
  nav.prepend(indicator);
  const state = { x: 0, y: 0, width: 0, height: 0, initialized: false };
  const body = [...indicator.children];
  const revealActive = (active) => {
    if (!nav.classList.contains('nav-list')) return;
    const start = active.offsetTop;
    const end = start + active.offsetHeight;
    const visibleStart = nav.scrollTop + 6;
    const visibleEnd = nav.scrollTop + nav.clientHeight - 6;
    if (start < visibleStart || end > visibleEnd) active.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'nearest', inline: 'nearest' });
  };
  const retarget = ({ reveal = false, immediate = false } = {}) => {
    const active = getActiveItem(nav);
    if (!active) { indicator.hidden = true; return; }
    indicator.hidden = false;
    const target = { x: active.offsetLeft, y: active.offsetTop, width: active.offsetWidth, height: active.offsetHeight };
    if (reveal) revealActive(active);
    if (!state.initialized || immediate || reducedMotion.matches || !window.gsap) {
      state.initialized = true;
      Object.assign(state, target);
      indicator.style.width = `${target.width}px`;
      indicator.style.height = `${target.height}px`;
      indicator.style.transform = `translate3d(${target.x}px, ${target.y}px, 0)`;
      body.forEach((layer) => { layer.style.transform = ''; });
      return;
    }
    const dx = target.x - state.x;
    const dy = target.y - state.y;
    const verticalTravel = Math.abs(dy) >= Math.abs(dx);
    const distance = Math.hypot(dx, dy);
    const travelDuration = Math.min(0.62, Math.max(0.38, 0.36 + distance / 950));
    const initialScaleX = state.width && target.width ? state.width / target.width : 1;
    const initialScaleY = state.height && target.height ? state.height / target.height : 1;
    window.gsap.killTweensOf([indicator, ...body]);
    window.gsap.set(indicator, { x: state.x, y: state.y, width: target.width, height: target.height, force3D: true });
    window.gsap.set(body, { scaleX: initialScaleX, scaleY: initialScaleY, transformOrigin: '50% 50%' });
    const timeline = window.gsap.timeline({ defaults: { overwrite: 'auto' } });
    timeline.to(indicator, { x: target.x, y: target.y, duration: travelDuration, ease: 'power3.inOut', force3D: true }, 0)
      .to(body, { scaleX: verticalTravel ? 0.92 : 1.18, scaleY: verticalTravel ? 1.2 : 0.9, duration: travelDuration * 0.46, ease: 'power2.out' }, 0)
      .to(body, { scaleX: verticalTravel ? 1.035 : 0.97, scaleY: verticalTravel ? 0.975 : 1.045, duration: travelDuration * 0.34, ease: 'sine.inOut' }, travelDuration * 0.46)
      .to(body, { scaleX: 1, scaleY: 1, duration: 0.26, ease: 'elastic.out(1, 0.58)', clearProps: 'transform' }, travelDuration * 0.76);
    Object.assign(state, target);
  };
  if (typeof MutationObserver === 'function') {
    const activeObserver = new MutationObserver((records) => {
      if (records.some((record) => record.type === 'attributes')) requestAnimationFrame(() => retarget({ reveal: true }));
    });
    activeObserver.observe(nav, { subtree: true, attributes: true, attributeFilter: ['class'] });
  }
  if (typeof ResizeObserver === 'function') {
    const resizeObserver = new ResizeObserver(() => retarget({ immediate: true }));
    resizeObserver.observe(nav);
    nav.querySelectorAll('.nav-item, a[href^="#"]').forEach((item) => resizeObserver.observe(item));
  } else {
    window.addEventListener('resize', () => retarget({ immediate: true }), { passive: true });
  }
  nav.addEventListener('click', () => requestAnimationFrame(() => retarget({ reveal: true })));
  requestAnimationFrame(() => retarget({ immediate: true }));
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const smoothStep = (a, b, t) => { const n = clamp((t - a) / (b - a), 0, 1); return n * n * (3 - 2 * n); };

function roundedRectSdf(x, y, width, height, radius) {
  const qx = Math.abs(x) - width + radius;
  const qy = Math.abs(y) - height + radius;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - radius;
}

function updateLiquidDisplacement(layout, state, force = false) {
  if (!liquidMapCanvas || !liquidMapContext || !layout.width || !layout.height) return;
  const speedBand = Math.round(clamp(Math.abs(state.velocity) / 1100, 0, 1) * 3);
  const mapKey = `${liquidMapCanvas.width}:${liquidMapCanvas.height}:${state.pressed > 0.5 ? 1 : 0}:${speedBand}:${Math.sign(state.velocity)}`;
  if (!force && mapKey === state.mapKey) return;
  state.mapKey = mapKey;
  const w = liquidMapCanvas.width;
  const h = liquidMapCanvas.height;
  const image = liquidMapContext.createImageData(w, h);
  const data = image.data;
  const speed = clamp(Math.abs(state.velocity) / 1100, 0, 1);
  const press = state.pressed;
  const directional = clamp(state.velocity / 1100, -1, 1);
  const refractionScale = 14 + press * 7 + speed * 7;
  for (let py = 0; py < h; py += 1) {
    const y = py / Math.max(h - 1, 1) - 0.5;
    for (let px = 0; px < w; px += 1) {
      const x = px / Math.max(w - 1, 1) - 0.5;
      const sd = roundedRectSdf(x, y, 0.47, 0.4, 0.2);
      const edge = 1 - smoothStep(0.005, 0.16, Math.abs(sd));
      const inner = smoothStep(-0.42, 0, sd);
      const push = edge * (0.022 + press * 0.038 + speed * 0.03);
      const bulgeX = -x * push * (1.08 + press * 0.18);
      const bulgeY = -y * push * 0.74;
      const dragX = directional * edge * (0.028 + press * 0.01);
      const dragY = -Math.abs(directional) * edge * 0.005;
      const index = (py * w + px) * 4;
      data[index] = Math.round(clamp(0.5 + ((bulgeX + dragX) * w) / refractionScale, 0, 1) * 255);
      data[index + 1] = Math.round(clamp(0.5 + ((bulgeY + dragY) * h) / refractionScale, 0, 1) * 255);
      data[index + 2] = Math.round((0.5 + inner * 0.045) * 255);
      data[index + 3] = 255;
    }
  }
  liquidMapContext.putImageData(image, 0, 0);
  const url = liquidMapCanvas.toDataURL('image/png');
  liquidFilterMap?.setAttribute('href', url);
  liquidFilterMap?.setAttributeNS('http://www.w3.org/1999/xlink', 'href', url);
  liquidFilterDisplacement?.setAttribute('scale', String(refractionScale));
}

function setupHomeLiquidNavigation(nav) {
  if (nav.dataset.liquidNavReady) return;
  nav.dataset.liquidNavReady = 'true';
  nav.classList.add('liquid-nav-host');
  nav.style.setProperty('touch-action', 'none', 'important');

  const indicator = document.createElement('span');
  indicator.className = 'nav-liquid-indicator is-visible';
  indicator.setAttribute('aria-hidden', 'true');
  indicator.innerHTML = '<span class="nav-liquid-filter"></span><span class="nav-liquid-overlay"></span><span class="nav-liquid-specular"></span><span class="nav-liquid-rim"></span>';
  nav.prepend(indicator);

  const links = [...nav.querySelectorAll(':scope > a[href]')];
  const state = {
    rect: null,
    centers: [],
    rects: [],
    index: 0,
    center: 0,
    pointerId: null,
    startX: 0,
    startCenter: 0,
    lastX: 0,
    lastTime: 0,
    velocity: 0,
    moved: false,
    dragging: false,
    committedIndex: 0,
    suppressClick: false
  };

  const selectedIndex = () => {
    const selected = links.findIndex((link) => link.classList.contains('is-active'));
    return selected >= 0 ? selected : 0;
  };

  function measure(reset = false) {
    state.rect = nav.getBoundingClientRect();
    state.rects = links.map((link) => link.getBoundingClientRect());
    state.centers = state.rects.map((rect) => rect.left - state.rect.left + nav.scrollLeft + rect.width / 2);
    if (reset || !state.dragging) {
      state.index = selectedIndex();
      state.center = state.centers[state.index] || 0;
    }
  }

  function nearestIndex(center) {
    let nearest = 0;
    state.centers.forEach((itemCenter, index) => {
      if (Math.abs(itemCenter - center) < Math.abs(state.centers[nearest] - center)) nearest = index;
    });
    return nearest;
  }

  function render() {
    const itemRect = state.rects[state.index];
    if (!itemRect || !state.rect) return;
    const width = itemRect.width;
    const height = itemRect.height;
    const y = itemRect.top - state.rect.top + nav.scrollTop;
    const speed = clamp(state.velocity / 1200, -1, 1);
    const scaleX = state.dragging ? 1.045 + Math.abs(speed) * .025 : 1;
    const scaleY = state.dragging ? .985 : 1;
    indicator.style.width = `${width}px`;
    indicator.style.height = `${height}px`;
    indicator.style.transform = `translate3d(${(state.center - width / 2).toFixed(2)}px, ${y.toFixed(2)}px, 0) scale(${scaleX.toFixed(3)}, ${scaleY.toFixed(3)}) skewX(${(speed * .65).toFixed(3)}deg)`;
    links.forEach((link, index) => link.classList.toggle('liquid-target', state.dragging && index === state.index));
  }

  function commit(index) {
    const link = links[index];
    if (!link) return;
    state.suppressClick = true;
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
    requestAnimationFrame(() => { state.suppressClick = false; });
  }

  function begin(event) {
    if (event.button != null && event.button !== 0) return;
    const target = event.target instanceof Element ? event.target.closest('a[href]') : null;
    measure(false);
    const bounds = indicator.getBoundingClientRect();
    const insideIndicator = event.clientX >= bounds.left - 10 && event.clientX <= bounds.right + 10
      && event.clientY >= bounds.top - 10 && event.clientY <= bounds.bottom + 10;
    if (!target && !insideIndicator) return;
    const targetIndex = target ? links.indexOf(target) : state.index;
    if (targetIndex >= 0) {
      state.index = targetIndex;
      state.center = state.centers[targetIndex];
    }
    state.pointerId = event.pointerId;
    state.startX = event.clientX;
    state.startCenter = state.center;
    state.lastX = event.clientX;
    state.lastTime = performance.now();
    state.velocity = 0;
    state.moved = false;
    state.dragging = true;
    state.committedIndex = selectedIndex();
    nav.classList.add('is-pressed', 'is-dragging');
    try { nav.setPointerCapture?.(event.pointerId); } catch (_) { /* capture is optional */ }
    event.preventDefault();
    render();
  }

  function move(event) {
    if (!state.dragging || event.pointerId !== state.pointerId) return;
    event.preventDefault();
    const now = performance.now();
    const delta = event.clientX - state.startX;
    const first = state.centers[0];
    const last = state.centers[state.centers.length - 1];
    state.center = clamp(state.startCenter + delta, first, last);
    state.index = nearestIndex(state.center);
    state.velocity = (event.clientX - state.lastX) / Math.max(8, now - state.lastTime) * 1000;
    state.lastX = event.clientX;
    state.lastTime = now;
    state.moved ||= Math.abs(delta) > 4;
    render();
    if (state.moved && state.index !== state.committedIndex) {
      state.committedIndex = state.index;
      commit(state.index);
    }
  }

  function end(event) {
    if (!state.dragging || (event && event.pointerId !== state.pointerId)) return;
    try { nav.releasePointerCapture?.(state.pointerId); } catch (_) { /* already released */ }
    const destination = state.index;
    state.dragging = false;
    state.pointerId = null;
    state.velocity = 0;
    state.center = state.centers[destination];
    nav.classList.remove('is-pressed', 'is-dragging');
    render();
    if (destination !== state.committedIndex) commit(destination);
  }

  nav.addEventListener('pointerdown', begin);
  nav.addEventListener('pointermove', move, { passive: false });
  nav.addEventListener('pointerup', end);
  nav.addEventListener('pointercancel', end);
  nav.addEventListener('click', (event) => {
    if (state.suppressClick && event.detail > 0) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const target = event.target instanceof Element ? event.target.closest('a[href]') : null;
    const index = links.indexOf(target);
    if (index < 0 || state.dragging) return;
    measure(false);
    state.index = index;
    state.center = state.centers[index];
    render();
  }, true);

  if (typeof MutationObserver === 'function') {
    const observer = new MutationObserver(() => {
      if (state.dragging) return;
      requestAnimationFrame(() => { measure(false); render(); });
    });
    links.forEach((link) => observer.observe(link, { attributes: true, attributeFilter: ['class'] }));
  }
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => { measure(false); render(); }).observe(nav);
  } else {
    window.addEventListener('resize', () => { measure(false); render(); }, { passive: true });
  }
  requestAnimationFrame(() => { measure(true); render(); });
}

function setupWorkspaceLiquidNavigation(nav) {
  if (nav.dataset.liquidNavReady) return;
  nav.dataset.liquidNavReady = 'true';
  nav.classList.add('liquid-nav-host');
  // Own the gesture surface from the first pointerdown.  Relying only on the
  // stylesheet is fragile in embedded/mobile browsers while styles are still
  // being applied, and can hand the stream to native scrolling.
  nav.style.setProperty('touch-action', 'none', 'important');
  nav.style.setProperty('-ms-touch-action', 'none');
  nav.style.setProperty('overscroll-behavior-x', 'contain');
  const indicator = document.createElement('span');
  indicator.className = 'nav-liquid-indicator';
  indicator.setAttribute('aria-hidden', 'true');
  indicator.innerHTML = '<span class="nav-liquid-filter"></span><span class="nav-liquid-overlay"></span><span class="nav-liquid-specular"></span><span class="nav-liquid-rim"></span>';
  nav.prepend(indicator);
  const compactNav = window.matchMedia('(max-width: 820px)');
  const isHomeNav = nav.classList.contains('home-nav-links');

  const state = {
    active: 0, current: 0, target: 0, velocity: 0, pressed: 0, dragging: false, moving: false,
    pointerId: null, pressedIndex: null, start: 0, lastAxis: 0, last: 0, lastY: 0, lastTime: 0,
    dragOffset: 0, moved: false, transitionDistance: 0, orientation: 'y', cross: 0, mapKey: '', settleRaf: 0,
    edgeScrollRaf: 0, edgeScrollVelocity: 0,
    mobileArmed: false, mobileTapPending: false, mobileTapCancelled: false, mobileTapX: 0, mobileTapY: 0,
    mobileTapIndex: null, mobileTapWasActive: false,
    mobileArmTimer: 0,
    suppressNativeClick: false
  };
  const layout = { navRect: null, items: [], centers: [], crossCenters: [], rects: [], width: 0, height: 0, scrollLeft: 0, scrollTop: 0 };
  const items = () => [...nav.children].filter((node) => node.matches('.nav-item, a[href]'));
  const activeIndex = () => {
    const active = getActiveItem(nav);
    const index = layout.items.indexOf(active);
    return index >= 0 ? index : 0;
  };
  const axisValue = (rect, axis) => axis === 'x'
    ? rect.left - layout.navRect.left + layout.scrollLeft + rect.width / 2
    : rect.top - layout.navRect.top + layout.scrollTop + rect.height / 2;
  const crossValue = (rect, axis) => axis === 'x'
    ? rect.top - layout.navRect.top + rect.height / 2
    : rect.left - layout.navRect.left + rect.width / 2;

  function measure(reset = false) {
    layout.items = items();
    layout.navRect = nav.getBoundingClientRect();
    layout.scrollLeft = nav.scrollLeft;
    layout.scrollTop = nav.scrollTop;
    layout.rects = layout.items.map((item) => item.getBoundingClientRect());
    layout.width = layout.navRect.width;
    layout.height = layout.navRect.height;
    if (!layout.rects.length) return;
    const xSpan = layout.rects.length > 1 ? Math.abs(layout.rects[layout.rects.length - 1].left - layout.rects[0].left) : 0;
    const ySpan = layout.rects.length > 1 ? Math.abs(layout.rects[layout.rects.length - 1].top - layout.rects[0].top) : 0;
    state.orientation = xSpan >= ySpan ? 'x' : 'y';
    nav.dataset.liquidOrientation = state.orientation;
    layout.centers = layout.rects.map((rect) => axisValue(rect, state.orientation));
    layout.crossCenters = layout.rects.map((rect) => crossValue(rect, state.orientation));
    if (!state.dragging && !state.moving) {
      const next = activeIndex();
      if (layout.centers[next] != null) {
        state.active = next;
        state.current = layout.centers[next];
        state.target = state.current;
      }
    }
    if (reset || !state.current) {
      state.active = activeIndex();
      state.current = layout.centers[state.active] || 0;
      state.target = state.current;
      state.cross = layout.crossCenters[state.active] || 0;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 1.25) * 0.72;
    const activeRect = layout.rects[clamp(state.active, 0, layout.rects.length - 1)];
    const mapWidth = Math.max(1, Math.round((activeRect.width + 36) * dpr));
    const mapHeight = Math.max(1, Math.round((activeRect.height + 36) * dpr));
    if (liquidMapCanvas && (liquidMapCanvas.width !== mapWidth || liquidMapCanvas.height !== mapHeight)) {
      liquidMapCanvas.width = mapWidth;
      liquidMapCanvas.height = mapHeight;
      liquidMapCanvas.style.width = `${activeRect.width}px`;
      liquidMapCanvas.style.height = `${activeRect.height}px`;
      liquidFilterMap?.setAttribute('width', String(activeRect.width));
      liquidFilterMap?.setAttribute('height', String(activeRect.height));
      state.mapKey = '';
    }
    updateNavOpticalTextures(activeRect.width, activeRect.height);
  }

  function nearestIndex(value) {
    let index = 0;
    for (let i = 1; i < layout.centers.length; i += 1) {
      if (Math.abs(layout.centers[i] - value) < Math.abs(layout.centers[index] - value)) index = i;
    }
    return index;
  }
  function setVisualActive(index) {
    state.active = clamp(Math.round(index), 0, Math.max(layout.items.length - 1, 0));
    layout.items.forEach((item, itemIndex) => item.classList.toggle('liquid-target', itemIndex === state.active));
  }
  function stopSpring() {
    if (state.settleRaf) cancelAnimationFrame(state.settleRaf);
    state.settleRaf = 0;
  }
  function animateTo(index, initialVelocity = 0) {
    if (!layout.centers.length) return;
    stopSpring();
    const destination = clamp(Math.round(index), 0, layout.centers.length - 1);
    state.target = layout.centers[destination];
    state.transitionDistance = Math.abs(state.target - state.current);
    state.velocity = initialVelocity;
    state.moving = state.transitionDistance > 1.5;
    setVisualActive(destination);
    if (reducedMotion.matches) {
      state.current = state.target;
      state.velocity = 0;
      state.moving = false;
      state.pressed = 0;
      render();
      return;
    }
    if (!state.moving && Math.abs(state.velocity) < 2) {
      nav.classList.remove('is-moving');
      if (!state.dragging) nav.classList.remove('is-dragging');
      render();
      return;
    }
    nav.classList.add('is-moving');
    let previous = performance.now();
    const step = (now) => {
      const dt = Math.min(0.034, Math.max(0.008, (now - previous) / 1000));
      previous = now;
      const stiffness = Math.abs(initialVelocity) > 40 ? 430 : 560;
      const damping = Math.abs(initialVelocity) > 40 ? 31 : 39;
      state.velocity += (state.target - state.current) * stiffness * dt;
      state.velocity *= Math.exp(-damping * dt);
      state.current += state.velocity * dt;
      setVisualActive(nearestIndex(state.current));
      render();
      if (Math.abs(state.target - state.current) < 0.8 && Math.abs(state.velocity) < 14) {
        state.current = state.target;
        state.velocity = 0;
        state.moving = false;
        state.transitionDistance = 0;
        setVisualActive(destination);
        nav.classList.remove('is-moving');
        if (!state.dragging) nav.classList.remove('is-dragging');
        render();
        state.settleRaf = 0;
        return;
      }
      state.settleRaf = requestAnimationFrame(step);
    };
    state.settleRaf = requestAnimationFrame(step);
  }
  function rubberband(value, dimension) {
    return value * dimension * 0.55 / (dimension + 0.55 * Math.abs(value));
  }
  function isCompactHorizontal() {
    return compactNav.matches && state.orientation === 'x';
  }
  function clearMobileArmTimer() {
    if (state.mobileArmTimer) clearTimeout(state.mobileArmTimer);
    state.mobileArmTimer = 0;
  }
  function setMobileArmed(armed, timeout = 0) {
    clearMobileArmTimer();
    state.mobileArmed = armed;
    nav.classList.toggle('is-liquid-armed', armed);
    render();
    if (armed && timeout) {
      state.mobileArmTimer = window.setTimeout(() => {
        if (state.dragging || state.mobileTapPending || state.moving) return;
        state.mobileArmed = false;
        nav.classList.remove('is-liquid-armed');
        render();
      }, timeout);
    }
  }
  function applyDragPosition(axis) {
    const first = layout.centers[0];
    const last = layout.centers[layout.centers.length - 1];
    const raw = axis - state.dragOffset;
    if (isCompactHorizontal()) {
      const rect = layout.rects[state.active] || layout.rects[0];
      const halfWidth = Math.max(20, rect.width / 2 * (1 + state.pressed * .085));
      const visibleStart = nav.scrollLeft + halfWidth + 3;
      const visibleEnd = nav.scrollLeft + nav.clientWidth - halfWidth - 3;
      state.current = clamp(raw, Math.max(first, visibleStart), Math.min(last, visibleEnd));
    } else {
      state.current = raw < first ? first + rubberband(raw - first, layout.width) : raw > last ? last + rubberband(raw - last, layout.width) : raw;
    }
    const crossed = nearestIndex(state.current);
    if (crossed !== state.active) {
      setVisualActive(crossed);
      // Homepage navigation owns scrolling in home-motion.js. Committing a
      // click for every crossed item makes the page scroll repeatedly while a
      // pointer is still down, which causes the capsule to jump. Workspace
      // navigation keeps its established crossed-tab behavior.
      if (!isHomeNav) {
        layout.items[crossed]?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
      }
    }
    render();
  }
  function stopEdgeScroll() {
    state.edgeScrollVelocity = 0;
    if (state.edgeScrollRaf) cancelAnimationFrame(state.edgeScrollRaf);
    state.edgeScrollRaf = 0;
  }
  function updateEdgeScroll(clientX) {
    if (!state.dragging || !state.moved || !isCompactHorizontal() || !layout.navRect) {
      stopEdgeScroll();
      return;
    }
    const rect = layout.rects[state.active] || layout.rects[0];
    const halfWidth = Math.max(20, rect.width / 2 * (1 + state.pressed * .085));
    const desiredCenter = clientX - layout.navRect.left + nav.scrollLeft - state.dragOffset;
    const visibleStart = nav.scrollLeft + halfWidth + 3;
    const visibleEnd = nav.scrollLeft + nav.clientWidth - halfWidth - 3;
    const leftPull = Math.max(0, visibleStart - desiredCenter);
    const rightPull = Math.max(0, desiredCenter - visibleEnd);
    state.edgeScrollVelocity = leftPull
      ? -smoothStep(0, 42, leftPull) * 8
      : rightPull
        ? smoothStep(0, 42, rightPull) * 8
        : 0;
    if (!state.edgeScrollVelocity) {
      stopEdgeScroll();
      return;
    }
    if (state.edgeScrollRaf) return;
    const step = () => {
      state.edgeScrollRaf = 0;
      if (!state.dragging || !state.moved || !state.edgeScrollVelocity) return;
      const before = nav.scrollLeft;
      nav.scrollLeft += state.edgeScrollVelocity;
      if (nav.scrollLeft === before) {
        stopEdgeScroll();
        return;
      }
      measure(false);
      const axis = state.last - layout.navRect.left + nav.scrollLeft;
      state.velocity = state.edgeScrollVelocity * 60;
      state.lastAxis = axis;
      state.lastTime = performance.now();
      applyDragPosition(axis);
      state.edgeScrollRaf = requestAnimationFrame(step);
    };
    state.edgeScrollRaf = requestAnimationFrame(step);
  }
  function render() {
    if (!layout.navRect || !layout.items.length) return;
    const speed = clamp(Math.abs(state.velocity) / 950, 0, 1);
    const progress = state.transitionDistance > 1 ? clamp(1 - Math.abs(state.target - state.current) / state.transitionDistance, 0, 1) : 0;
    const transit = state.moving ? Math.sin(progress * Math.PI) : 0;
    const deform = clamp(transit * 0.58 + speed * 0.16, 0, 1);
    const targetRect = layout.rects[state.active] || layout.rects[0];
    const width = Math.max(40, targetRect.width);
    const height = Math.max(30, targetRect.height);
    const scalePrimary = 1 + state.pressed * 0.085 + deform * 0.065 + speed * 0.022;
    const scaleCross = 1 + state.pressed * 0.08 + transit * 0.025 - speed * 0.018;
    const skew = clamp(state.velocity * 0.00075, -0.8, 0.8);
    // Keep the home capsule visible at rest; workspace navigation reveals its
    // lens during active interaction to preserve the existing visual behavior.
    const visible = isHomeNav || state.dragging || state.moving || state.mobileArmed || state.mobileTapPending;
    indicator.classList.toggle('is-visible', visible);
    indicator.style.width = `${width}px`;
    indicator.style.height = `${height}px`;
    const cross = layout.crossCenters[state.active] || state.cross;
    const x = state.orientation === 'x' ? state.current - width / 2 : cross - width / 2;
    const y = state.orientation === 'x' ? cross - height / 2 : state.current - height / 2;
    const primaryScale = state.orientation === 'x' ? scalePrimary : scaleCross;
    const crossScale = state.orientation === 'x' ? scaleCross : scalePrimary;
    indicator.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) scale(${primaryScale.toFixed(4)}, ${crossScale.toFixed(4)}) skewX(${skew.toFixed(3)}deg)`;
    // The capsule edge has a single origin now: a fixed full-radius arc shared
    // by the indicator, the clipping path and the SVG lens bezel. The liquid
    // character comes from the scale/skew above, not from a second moving arc.
    const renderedWidth = width * primaryScale;
    const renderedHeight = height * crossScale;
    const surfaceLeft = layout.navRect.left - layout.scrollLeft + x + (width - renderedWidth) / 2;
    const surfaceTop = layout.navRect.top - layout.scrollTop + y + (height - renderedHeight) / 2;
    const pointerX = state.last || (surfaceLeft + renderedWidth * 0.28);
    const pointerY = state.lastY || (surfaceTop + renderedHeight * 0.15);
    indicator.style.setProperty('--light-x', `${clamp((pointerX - surfaceLeft) / Math.max(renderedWidth, 1), 0, 1) * 100}%`);
    indicator.style.setProperty('--light-y', `${clamp((pointerY - surfaceTop) / Math.max(renderedHeight, 1), 0, 1) * 100}%`);
    updateLiquidDisplacement(layout, state);
  }
  function pointerAxis(event) {
    return state.orientation === 'x' ? event.clientX - layout.navRect.left + nav.scrollLeft : event.clientY - layout.navRect.top + nav.scrollTop;
  }
  function begin(event) {
    const eventElement = event.target instanceof Element ? event.target : event.target?.parentElement;
    const item = eventElement?.closest('.nav-item, a[href]');
    measure(false);
    const bounds = indicator.getBoundingClientRect();
    const inPill = event.clientX >= bounds.left - 14 && event.clientX <= bounds.right + 14 && event.clientY >= bounds.top - 14 && event.clientY <= bounds.bottom + 14;
    if (!isHomeNav && isCompactHorizontal() && !(state.mobileArmed && inPill)) {
      if (!item) return;
      const itemIndex = layout.items.indexOf(item);
      if (itemIndex < 0) return;
      // Do not cancel the pointerdown itself: cancelling here suppresses the
      // browser click synthesis on touch devices. Drag movement cancels the
      // stream below once the user crosses the movement threshold.
      try { nav.setPointerCapture?.(event.pointerId); } catch (_) { /* capture is optional */ }
      item.style.setProperty('touch-action', 'none', 'important');
      nav.style.setProperty('touch-action', 'none', 'important');
      const wasActive = itemIndex === activeIndex();
      stopSpring();
      stopEdgeScroll();
      clearMobileArmTimer();
      state.mobileArmed = true;
      state.mobileTapPending = true;
      state.mobileTapCancelled = false;
      state.mobileTapIndex = itemIndex;
      state.mobileTapX = event.clientX;
      state.mobileTapY = event.clientY;
      state.pointerId = event.pointerId;
      state.pressedIndex = itemIndex;
      state.mobileTapWasActive = wasActive;
      state.last = event.clientX;
      state.lastY = event.clientY;
      state.moved = false;
      state.dragging = false;
      state.velocity = 0;
      state.pressed = 1;
      nav.classList.add('is-liquid-armed', 'is-pressed');
      animateTo(itemIndex, 0);
      render();
      return;
    }
    if (!item && !inPill) return;
    if (!item) event.preventDefault();
    stopSpring();
    clearMobileArmTimer();
    const itemIndex = isCompactHorizontal() ? state.active : item ? layout.items.indexOf(item) : state.active;
    const targetIndex = itemIndex >= 0 ? itemIndex : state.active;
    const axis = pointerAxis(event);
    state.pressedIndex = targetIndex;
    state.dragOffset = axis - (isCompactHorizontal() ? state.current : layout.centers[targetIndex]);
    state.dragging = true;
    state.moving = false;
    state.pointerId = event.pointerId;
    state.start = axis;
    state.lastAxis = axis;
    state.last = event.clientX;
    state.lastY = event.clientY;
    state.lastTime = performance.now();
    state.velocity = 0;
    state.moved = false;
    state.pressed = 1;
    stopEdgeScroll();
    nav.classList.add('is-pressed', 'is-dragging');
    if (isHomeNav) {
      // The homepage capsule follows the pointer immediately. Starting the
      // workspace spring here would keep writing `current` during the same
      // pointer stream and make the capsule pull back or jump between tabs.
      state.active = targetIndex;
      state.current = layout.centers[targetIndex];
      state.target = state.current;
      state.transitionDistance = 0;
      setVisualActive(targetIndex);
    } else {
      animateTo(targetIndex, 0);
    }
    render();
  }
  function move(event) {
    if (state.mobileTapPending && event.pointerId === state.pointerId) {
      state.last = event.clientX;
      state.lastY = event.clientY;
      if (Math.hypot(event.clientX - state.mobileTapX, event.clientY - state.mobileTapY) > 8) {
        // Any nav tab can begin a horizontal liquid drag once the finger
        // moves past the touch threshold; a tap still snaps to that tab.
        if (state.pressedIndex != null) {
          const axis = pointerAxis(event);
          // A tap on another tab starts a snap animation.  Once the finger
          // crosses the threshold that animation must be interrupted, or its
          // RAF keeps writing `current` and visibly pulls the pill back.
          stopSpring();
          state.mobileTapPending = false;
          state.mobileTapCancelled = false;
          state.dragging = true;
          state.moving = false;
          state.transitionDistance = 0;
          state.moved = true;
          state.start = state.mobileTapX - layout.navRect.left + nav.scrollLeft;
          state.lastAxis = axis;
          state.lastTime = performance.now();
          state.dragOffset = state.start - state.current;
          state.pressedIndex = state.active;
          nav.classList.add('is-dragging', 'is-moving');
          if (event.cancelable !== false) event.preventDefault();
          try { nav.setPointerCapture?.(event.pointerId); } catch (_) { /* capture is optional */ }
          applyDragPosition(axis);
          updateEdgeScroll(event.clientX);
          return;
        }
        state.mobileTapCancelled = true;
        state.pressed = 0;
        nav.classList.remove('is-pressed');
        render();
      }
      return;
    }
    if (!state.dragging || event.pointerId !== state.pointerId) return;
    if (event.cancelable !== false) event.preventDefault();
    const now = performance.now();
    const axis = pointerAxis(event);
    const dt = Math.max(8, now - state.lastTime);
    state.velocity = (axis - state.lastAxis) / dt * 1000;
    state.lastAxis = axis;
    state.last = event.clientX;
    state.lastY = event.clientY;
    state.lastTime = now;
    if (!state.moved) {
      if (Math.abs(axis - state.start) <= 3) return;
      state.moved = true;
      try { nav.setPointerCapture?.(event.pointerId); } catch (_) { /* capture is optional for synthetic pointers */ }
      stopSpring();
      state.moving = false;
      state.transitionDistance = 0;
      nav.classList.add('is-moving');
    }
    applyDragPosition(axis);
    updateEdgeScroll(event.clientX);
  }
  function end(event) {
    if (state.mobileTapPending && (!event || event.pointerId === state.pointerId)) {
      const cancelled = state.mobileTapCancelled && !state.moved;
      const moved = state.moved;
      const tapIndex = state.mobileTapIndex;
      state.mobileTapPending = false;
      state.mobileTapCancelled = false;
      state.pointerId = null;
      state.pressedIndex = null;
      state.mobileTapIndex = null;
      state.mobileTapWasActive = false;
      state.pressed = 0;
      nav.classList.remove('is-pressed');
      if (moved) {
        animateTo(state.active, state.velocity);
      } else if (cancelled) {
        state.suppressNativeClick = true;
        state.mobileArmed = false;
        nav.classList.remove('is-liquid-armed');
        animateTo(activeIndex(), 0);
        window.setTimeout(() => { state.suppressNativeClick = false; }, 360);
      } else {
        setMobileArmed(true, 3200);
        // Pointerdown calls preventDefault to keep the nav gesture surface
        // from handing the stream to native scrolling. That also suppresses
        // the browser's click synthesis, so a stationary tap must dispatch
        // the target tab click explicitly.
        const tapTarget = tapIndex == null ? null : layout.items[tapIndex];
        if (tapTarget) requestAnimationFrame(() => {
          if (tapTarget.isConnected && tapIndex !== activeIndex()) {
            tapTarget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
          }
        });
      }
      render();
      return;
    }
    if (!state.dragging || (event && event.pointerId !== state.pointerId)) return;
    stopEdgeScroll();
    state.dragging = false;
    try { nav.releasePointerCapture?.(state.pointerId); } catch (_) { /* already released */ }
    const releaseVelocity = state.velocity;
    const destination = state.moved ? state.active : (state.pressedIndex == null ? state.active : state.pressedIndex);
    state.pressedIndex = null;
    state.mobileTapIndex = null;
    state.mobileTapWasActive = false;
    state.pointerId = null;
    state.pressed = 0;
    nav.classList.remove('is-pressed');
    if (isHomeNav && state.moved && layout.items[destination]) {
      // Home scrolling is committed exactly once, after the drag settles on
      // its final tab. The synthetic detail=0 event is intentionally allowed
      // through the click guard and is handled by home-motion.js.
      layout.items[destination].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
    }
    animateTo(destination, releaseVelocity);
    if (state.orientation === 'x' && layout.items[destination]) {
      const item = layout.items[destination];
      const itemCenter = item.offsetLeft + item.offsetWidth / 2;
      const left = clamp(itemCenter - nav.clientWidth / 2, 0, Math.max(0, nav.scrollWidth - nav.clientWidth));
      nav.scrollTo({ left, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
    }
    if (isCompactHorizontal()) setMobileArmed(true, 1800);
    if (state.moved) {
      state.suppressNativeClick = true;
      requestAnimationFrame(() => { state.suppressNativeClick = false; });
    }
  }
  nav.addEventListener('pointerdown', begin);
  nav.addEventListener('pointermove', move, { passive: false });
  nav.addEventListener('pointerup', end);
  nav.addEventListener('pointercancel', end);
  // Some mobile Chromium/WebView builds emit lostpointercapture as soon as a
  // captured touch crosses a composited layer.  It is not a cancellation;
  // pointerup/pointercancel (plus the document fallback below) remain the
  // authoritative end events.
  nav.addEventListener('lostpointercapture', () => {});
  nav.addEventListener('pointermove', (event) => { state.last = event.clientX; state.lastY = event.clientY; render(); }, { passive: true });
  // Pointer capture is not reliable in every embedded browser. Keep a document
  // level route for events that leave the nav before capture is established.
  document.addEventListener('pointermove', (event) => {
    if (!state.dragging && !state.mobileTapPending) return;
    if (nav.contains(event.target)) return;
    move(event);
  }, { passive: false });
  document.addEventListener('pointerup', (event) => {
    if (state.dragging || state.mobileTapPending) end(event);
  }, true);
  document.addEventListener('pointercancel', (event) => {
    if (state.dragging || state.mobileTapPending) end(event);
  }, true);

  // Safari versions without Pointer Events still need the same gesture model.
  if (!('PointerEvent' in window)) {
    let activeTouchId = null;
    const compatEvent = (nativeEvent, point, pointerId) => ({
      target: point?.target || nativeEvent.target,
      clientX: point?.clientX ?? nativeEvent.clientX,
      clientY: point?.clientY ?? nativeEvent.clientY,
      pointerId,
      cancelable: nativeEvent.cancelable,
      preventDefault: () => nativeEvent.preventDefault()
    });
    nav.addEventListener('mousedown', (event) => begin(compatEvent(event, event, 1)));
    document.addEventListener('mousemove', (event) => {
      if (state.pointerId === 1) move(compatEvent(event, event, 1));
    }, { passive: false });
    document.addEventListener('mouseup', (event) => {
      if (state.pointerId === 1) end(compatEvent(event, event, 1));
    }, true);
    nav.addEventListener('touchstart', (event) => {
      const point = event.changedTouches?.[0];
      if (!point) return;
      activeTouchId = point.identifier;
      begin(compatEvent(event, point, activeTouchId));
    }, { passive: false });
    document.addEventListener('touchmove', (event) => {
      if (activeTouchId == null) return;
      const point = [...event.changedTouches].find((touch) => touch.identifier === activeTouchId);
      if (point) move(compatEvent(event, point, activeTouchId));
    }, { passive: false });
    const finishTouch = (event) => {
      if (activeTouchId == null) return;
      const point = [...event.changedTouches].find((touch) => touch.identifier === activeTouchId) || event.changedTouches?.[0];
      if (point) end(compatEvent(event, point, activeTouchId));
      activeTouchId = null;
    };
    document.addEventListener('touchend', finishTouch, true);
    document.addEventListener('touchcancel', finishTouch, true);
  }
  nav.addEventListener('click', (event) => {
    if (state.dragging) return;
    if (state.suppressNativeClick && event.detail > 0) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const eventElement = event.target instanceof Element ? event.target : event.target?.parentElement;
    const item = eventElement?.closest('.nav-item, a[href]');
    if (!item) return;
    const index = layout.items.indexOf(item);
    if (index >= 0) {
      animateTo(index, 0);
      if (isCompactHorizontal()) setMobileArmed(true, 3200);
    }
  }, true);
  nav.addEventListener('scroll', () => { measure(false); render(); }, { passive: true });
  if (typeof MutationObserver === 'function') {
    const activeObserver = new MutationObserver((records) => {
      if (!records.some((record) => record.type === 'attributes')) return;
      requestAnimationFrame(() => {
        measure(false);
        const next = activeIndex();
        if (!state.dragging && !state.moving && next !== state.active) {
          state.current = layout.centers[next] || state.current;
          state.target = state.current;
          state.active = next;
        }
        render();
      });
    });
    activeObserver.observe(nav, { subtree: true, attributes: true, attributeFilter: ['class'] });
  }
  if (typeof ResizeObserver === 'function') {
    const resizeObserver = new ResizeObserver(() => { measure(false); render(); });
    resizeObserver.observe(nav);
  } else {
    window.addEventListener('resize', () => { measure(false); render(); }, { passive: true });
  }
  requestAnimationFrame(() => { measure(true); state.active = activeIndex(); render(); });
}

function createSegmentRefraction(host) {
  const defs = document.querySelector('#liquid-glass-defs defs');
  if (!defs) return null;
  const id = `liquid-segment-distortion-${++segmentFilterSequence}`;
  const filter = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
  filter.id = id;
  filter.setAttribute('filterUnits', 'userSpaceOnUse');
  filter.setAttribute('color-interpolation-filters', 'sRGB');
  filter.setAttribute('x', '0');
  filter.setAttribute('y', '0');
  const image = document.createElementNS('http://www.w3.org/2000/svg', 'feImage');
  image.setAttribute('result', `${id}-motion-map`);
  image.setAttribute('preserveAspectRatio', 'none');
  const physicalImage = document.createElementNS('http://www.w3.org/2000/svg', 'feImage');
  physicalImage.setAttribute('result', `${id}-physical-map`);
  physicalImage.setAttribute('preserveAspectRatio', 'none');
  const magnificationImage = document.createElementNS('http://www.w3.org/2000/svg', 'feImage');
  magnificationImage.setAttribute('result', `${id}-magnification-map`);
  magnificationImage.setAttribute('preserveAspectRatio', 'none');
  const magnification = document.createElementNS('http://www.w3.org/2000/svg', 'feDisplacementMap');
  magnification.setAttribute('in', 'SourceGraphic');
  magnification.setAttribute('in2', `${id}-magnification-map`);
  magnification.setAttribute('xChannelSelector', 'R');
  magnification.setAttribute('yChannelSelector', 'G');
  magnification.setAttribute('result', `${id}-magnified`);
  const physicalDisplacement = document.createElementNS('http://www.w3.org/2000/svg', 'feDisplacementMap');
  physicalDisplacement.setAttribute('in', `${id}-magnified`);
  physicalDisplacement.setAttribute('in2', `${id}-physical-map`);
  physicalDisplacement.setAttribute('xChannelSelector', 'R');
  physicalDisplacement.setAttribute('yChannelSelector', 'G');
  physicalDisplacement.setAttribute('result', `${id}-refracted`);
  const displacement = document.createElementNS('http://www.w3.org/2000/svg', 'feDisplacementMap');
  displacement.setAttribute('in', `${id}-refracted`);
  displacement.setAttribute('in2', `${id}-motion-map`);
  displacement.setAttribute('xChannelSelector', 'R');
  displacement.setAttribute('yChannelSelector', 'G');
  displacement.setAttribute('result', `${id}-displaced`);
  const saturation = document.createElementNS('http://www.w3.org/2000/svg', 'feColorMatrix');
  saturation.setAttribute('in', `${id}-displaced`);
  saturation.setAttribute('type', 'saturate');
  saturation.setAttribute('values', '6');
  saturation.setAttribute('result', `${id}-saturated`);
  const specularImage = document.createElementNS('http://www.w3.org/2000/svg', 'feImage');
  specularImage.setAttribute('result', `${id}-specular-map`);
  specularImage.setAttribute('preserveAspectRatio', 'none');
  const composite = document.createElementNS('http://www.w3.org/2000/svg', 'feComposite');
  composite.setAttribute('in', `${id}-saturated`);
  composite.setAttribute('in2', `${id}-specular-map`);
  composite.setAttribute('operator', 'in');
  composite.setAttribute('result', `${id}-specular-saturated`);
  const transfer = document.createElementNS('http://www.w3.org/2000/svg', 'feComponentTransfer');
  transfer.setAttribute('in', `${id}-specular-map`);
  transfer.setAttribute('result', `${id}-specular-faded`);
  const alpha = document.createElementNS('http://www.w3.org/2000/svg', 'feFuncA');
  alpha.setAttribute('type', 'linear');
  alpha.setAttribute('slope', '.42');
  transfer.append(alpha);
  const blendSaturation = document.createElementNS('http://www.w3.org/2000/svg', 'feBlend');
  blendSaturation.setAttribute('in', `${id}-specular-saturated`);
  blendSaturation.setAttribute('in2', `${id}-displaced`);
  blendSaturation.setAttribute('mode', 'normal');
  blendSaturation.setAttribute('result', `${id}-with-saturation`);
  const blendSpecular = document.createElementNS('http://www.w3.org/2000/svg', 'feBlend');
  blendSpecular.setAttribute('in', `${id}-specular-faded`);
  blendSpecular.setAttribute('in2', `${id}-with-saturation`);
  blendSpecular.setAttribute('mode', 'normal');
  filter.append(magnificationImage, magnification, physicalImage, physicalDisplacement, image, displacement, saturation, specularImage, composite, transfer, blendSaturation, blendSpecular);
  defs.append(filter);
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  host.style.setProperty('--liquid-segment-filter', `url(#${id})`);
  return { id, filter, image, displacement, magnificationImage, magnification, physicalImage, physicalDisplacement, specularImage, canvas, context, key: '', opticalKey: '' };
}

function pruneSegmentMotionCache() {
  while (segmentMotionCache.size > MAX_SEGMENT_MOTION_CACHE) {
    segmentMotionCache.delete(segmentMotionCache.keys().next().value);
  }
}

function segmentMotionTextureInfo(width, height, pressed, velocity) {
  const speed = clamp(Math.abs(velocity) / 900, 0, 1);
  const speedBand = Math.round(speed * 3);
  const roundedWidth = Math.round(width);
  const roundedHeight = Math.round(height);
  const pressedState = pressed > 0.5 ? 1 : 0;
  const direction = Math.sign(velocity);
  const dpi = Math.min(window.devicePixelRatio || 1, 1.25) * 0.72;
  const key = `${roundedWidth}:${roundedHeight}:${pressedState}:${speedBand}:${direction}:${dpi}`;
  return { speed, roundedWidth, roundedHeight, dpi, key };
}

function createSegmentMotionTexture(refraction, width, height, pressed, velocity, info = segmentMotionTextureInfo(width, height, pressed, velocity)) {
  const { speed, roundedWidth, roundedHeight, dpi, key } = info;
  const cached = segmentMotionCache.get(key);
  if (cached) {
    // Keep frequently used tab states hot without rebuilding the data URL.
    segmentMotionCache.delete(key);
    segmentMotionCache.set(key, cached);
    return { ...cached, key };
  }
  const w = Math.max(24, Math.round(width * dpi));
  const h = Math.max(18, Math.round(height * dpi));
  refraction.canvas.width = w;
  refraction.canvas.height = h;
  const imageData = refraction.context.createImageData(w, h);
  const data = imageData.data;
  const scale = 13 + pressed * 6 + speed * 6;
  const normalizedDirection = clamp(velocity / 900, -1, 1);
  for (let py = 0; py < h; py += 1) {
    const y = py / Math.max(h - 1, 1) - 0.5;
    for (let px = 0; px < w; px += 1) {
      const x = px / Math.max(w - 1, 1) - 0.5;
      const sd = roundedRectSdf(x, y, 0.47, 0.4, 0.19);
      const rim = 1 - smoothStep(0.006, 0.155, Math.abs(sd));
      const inner = smoothStep(-0.39, -0.01, sd);
      const push = rim * (0.024 + pressed * 0.036 + speed * 0.026);
      const dx = -x * push * 1.12 + normalizedDirection * rim * (0.025 + pressed * 0.008);
      const dy = -y * push * 0.76 - Math.abs(normalizedDirection) * rim * 0.004;
      const index = (py * w + px) * 4;
      data[index] = Math.round(clamp(0.5 + (dx * w) / scale, 0, 1) * 255);
      data[index + 1] = Math.round(clamp(0.5 + (dy * h) / scale, 0, 1) * 255);
      data[index + 2] = Math.round((0.5 + inner * 0.04) * 255);
      data[index + 3] = 255;
    }
  }
  refraction.context.putImageData(imageData, 0, 0);
  const result = { url: refraction.canvas.toDataURL('image/png'), scale };
  segmentMotionCache.set(key, result);
  pruneSegmentMotionCache();
  return { ...result, key };
}

function segmentInteractionInFlight() {
  return Boolean(
    document.querySelector('.liquid-segment-host:is(.is-moving, .is-pressed, .is-dragging)')
    || navigator.scheduling?.isInputPending?.({ includeContinuous: true })
  );
}

function cachedSegmentMotionFallback(info) {
  const prefix = `${info.roundedWidth}:${info.roundedHeight}:`;
  let fallback = null;
  for (const [key, texture] of segmentMotionCache) {
    if (key.startsWith(prefix)) fallback = { ...texture, key };
  }
  return fallback;
}

function scheduleSegmentMotionTexture(refraction, width, height, pressed, velocity, info) {
  if (!pendingSegmentMotionTextures.has(info.key)) {
    pendingSegmentMotionTextures.set(info.key, { refraction, width, height, pressed, velocity, info });
  }
  if (segmentMotionIdleHandle) return;
  const schedule = window.requestIdleCallback
    ? (callback) => window.requestIdleCallback(callback, { timeout: 220 })
    : (callback) => window.setTimeout(() => callback({ didTimeout: true, timeRemaining: () => 0 }), 90);
  segmentMotionIdleHandle = schedule((deadline) => {
    segmentMotionIdleHandle = 0;
    if (segmentInteractionInFlight() || (!deadline.didTimeout && deadline.timeRemaining() < 24)) {
      scheduleSegmentMotionTexture(refraction, width, height, pressed, velocity, info);
      return;
    }
    const next = pendingSegmentMotionTextures.values().next().value;
    if (!next) return;
    pendingSegmentMotionTextures.delete(next.info.key);
    createSegmentMotionTexture(next.refraction, next.width, next.height, next.pressed, next.velocity, next.info);
    // Never turn a generous idle window into a burst of texture encodes.
    if (pendingSegmentMotionTextures.size) requestAnimationFrame(() => {
      const queued = pendingSegmentMotionTextures.values().next().value;
      if (queued) scheduleSegmentMotionTexture(
        queued.refraction,
        queued.width,
        queued.height,
        queued.pressed,
        queued.velocity,
        queued.info
      );
    });
  });
}

function segmentMotionTexture(refraction, width, height, pressed, velocity) {
  const info = segmentMotionTextureInfo(width, height, pressed, velocity);
  const cached = segmentMotionCache.get(info.key);
  if (cached) return { ...cached, key: info.key };
  // A cache miss used to encode a data URL inside the pointer animation frame.
  // Use the current lens map immediately and prepare the more specific one only
  // after input has settled, so first-use interactions retain their frame budget.
  if (segmentInteractionInFlight()) {
    scheduleSegmentMotionTexture(refraction, width, height, pressed, velocity, info);
    return cachedSegmentMotionFallback(info);
  }
  return createSegmentMotionTexture(refraction, width, height, pressed, velocity, info);
}

function updateSegmentRefraction(refraction, width, height, pressed, velocity) {
  if (!refraction?.context || !width || !height) return;
  const optical = window.OpticalGlass;
  if (optical) {
    const opticalKey = `${Math.round(width)}:${Math.round(height)}`;
    if (refraction.opticalKey !== opticalKey) {
      refraction.opticalKey = opticalKey;
      const radius = Math.max(7, Math.min(height / 2, width / 2));
      const map = optical.createRefractionMap(Math.round(width), Math.round(height), radius, {
        bezelWidth: Math.max(4, Math.min(radius - 1, 14)), glassThickness: 80, refractiveIndex: 1.45,
        dpr: Math.min(window.devicePixelRatio || 1, .72)
      });
      const magnificationUrl = optical.createMagnificationUrl(Math.round(width), Math.round(height), radius);
      const specular = optical.createSpecularUrl(Math.round(width), Math.round(height), radius);
      [refraction.magnificationImage, refraction.physicalImage, refraction.image, refraction.specularImage].forEach((image) => {
        image?.setAttribute('width', String(Math.round(width)));
        image?.setAttribute('height', String(Math.round(height)));
      });
      refraction.filter.setAttribute('width', String(Math.round(width)));
      refraction.filter.setAttribute('height', String(Math.round(height)));
      setSvgImageHref(refraction.magnificationImage, magnificationUrl);
      refraction.magnification?.setAttribute('scale', String(Math.max(10, Math.min(18, height * .26))));
      setSvgImageHref(refraction.physicalImage, map.url);
      setSvgImageHref(refraction.specularImage, specular);
      refraction.physicalDisplacement?.setAttribute('scale', String(map.maxRefraction));
    }
  }
  const motion = segmentMotionTexture(refraction, width, height, pressed, velocity);
  if (!motion || motion.key === refraction.key) return;
  refraction.key = motion.key;
  refraction.filter.setAttribute('x', '0');
  refraction.filter.setAttribute('y', '0');
  refraction.filter.setAttribute('width', String(width));
  refraction.filter.setAttribute('height', String(height));
  refraction.image.setAttribute('width', String(width));
  refraction.image.setAttribute('height', String(height));
  refraction.image.setAttribute('href', motion.url);
  refraction.image.setAttributeNS('http://www.w3.org/1999/xlink', 'href', motion.url);
  refraction.displacement.setAttribute('scale', String(motion.scale));
}

function setupLiquidSegment(host, itemSelector) {
  if (host.dataset.liquidSegmentReady) return;
  host.dataset.liquidSegmentReady = 'true';
  host.classList.add('liquid-segment-host');
  const indicator = document.createElement('span');
  indicator.className = 'liquid-segment-indicator';
  indicator.setAttribute('aria-hidden', 'true');
  indicator.innerHTML = '<span class="liquid-segment-filter"></span><span class="liquid-segment-overlay"></span><span class="liquid-segment-specular"></span><span class="liquid-segment-rim"></span>';
  host.prepend(indicator);
  const surface = indicator.querySelector('.liquid-segment-filter');
  const refraction = createSegmentRefraction(host);
  if (surface && refraction) {
    surface.style.setProperty('backdrop-filter', `url(#${refraction.id})`, 'important');
    surface.style.setProperty('-webkit-backdrop-filter', `url(#${refraction.id})`, 'important');
  }
  const state = {
    center: 0, target: 0, velocity: 0, width: 0, targetWidth: 0, widthVelocity: 0,
    active: 0, pressed: 0, dragging: false, moving: false, moved: false,
    pointerId: null, pressedIndex: null, start: 0, last: 0, lastY: 0, lastAxis: 0,
    lastTime: 0, dragOffset: 0, distance: 0, raf: 0, suppressNativeClick: false,
    committedIndex: 0
  };
  const layout = { hostRect: null, items: [], rects: [], centers: [], scrollLeft: 0, scrollTop: 0 };
  const getItems = () => [...host.children].filter((node) => node.matches(itemSelector));
  const getActiveIndex = () => {
    const index = layout.items.findIndex((item) => item.classList.contains('active') || item.classList.contains('selected') || item.getAttribute('aria-selected') === 'true' || item.getAttribute('aria-pressed') === 'true');
    return index >= 0 ? index : 0;
  };
  const nearestIndex = (value) => {
    let nearest = 0;
    for (let index = 1; index < layout.centers.length; index += 1) {
      if (Math.abs(layout.centers[index] - value) < Math.abs(layout.centers[nearest] - value)) nearest = index;
    }
    return nearest;
  };
  const setVisualTarget = (index) => {
    state.active = clamp(index, 0, Math.max(layout.items.length - 1, 0));
    layout.items.forEach((item, itemIndex) => item.classList.toggle('liquid-segment-target', itemIndex === state.active));
  };
  const commitTarget = (index) => {
    const destination = clamp(index, 0, Math.max(layout.items.length - 1, 0));
    if (destination === state.committedIndex) return;
    state.committedIndex = destination;
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 });
    Object.defineProperty(click, 'liquidSegmentCommit', { value: true });
    layout.items[destination]?.dispatchEvent(click);
  };
  const measure = (reset = false) => {
    layout.items = getItems();
    layout.hostRect = host.getBoundingClientRect();
    layout.scrollLeft = host.scrollLeft;
    layout.scrollTop = host.scrollTop;
    layout.rects = layout.items.map((item) => item.getBoundingClientRect());
    layout.centers = layout.rects.map((rect) => rect.left - layout.hostRect.left + layout.scrollLeft + rect.width / 2);
    if (!layout.items.length) return;
    const active = getActiveIndex();
    if (reset || (!state.dragging && !state.moving)) {
      state.active = active;
      state.committedIndex = active;
      state.center = layout.centers[active];
      state.target = state.center;
      state.width = layout.rects[active].width;
      state.targetWidth = state.width;
      state.velocity = 0;
      state.widthVelocity = 0;
    }
  };
  const stop = () => {
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = 0;
  };
  const render = () => {
    if (!layout.items.length) return;
    const speed = clamp(Math.abs(state.velocity) / 850, 0, 1);
    const travel = state.distance > 1 ? clamp(1 - Math.abs(state.target - state.center) / state.distance, 0, 1) : 0;
    const transit = state.moving ? Math.sin(travel * Math.PI) : 0;
    const deform = clamp(transit * .58 + speed * .16, 0, 1);
    const targetRect = layout.rects[state.active] || layout.rects[0];
    const height = Math.max(28, targetRect.height);
    const scaleX = 1 + state.pressed * .085 + deform * .065 + speed * .022;
    const scaleY = 1 + state.pressed * .08 + transit * .025 - speed * .018;
    const skew = clamp(state.velocity * .00075, -.8, .8);
    indicator.classList.toggle('is-visible', state.dragging || state.moving);
    indicator.style.width = `${Math.max(34, state.width)}px`;
    indicator.style.height = `${height}px`;
    const indicatorX = state.center - state.width / 2;
    const indicatorY = targetRect.top - layout.hostRect.top + layout.scrollTop;
    indicator.style.transform = `translate3d(${indicatorX.toFixed(2)}px, ${indicatorY.toFixed(2)}px, 0) scale(${scaleX.toFixed(4)}, ${scaleY.toFixed(4)}) skewX(${skew.toFixed(3)}deg)`;
    // Fixed full-radius capsule edge (matches the nav lens): one arc for the
    // clip, the border and the refraction bezel.
    const renderedWidth = state.width * scaleX;
    const renderedHeight = height * scaleY;
    const surfaceLeft = layout.hostRect.left - layout.scrollLeft + indicatorX + (state.width - renderedWidth) / 2;
    const surfaceTop = layout.hostRect.top - layout.scrollTop + indicatorY + (height - renderedHeight) / 2;
    indicator.style.setProperty('--light-x', `${clamp((state.last - surfaceLeft) / Math.max(renderedWidth, 1), 0, 1) * 100}%`);
    indicator.style.setProperty('--light-y', `${clamp((state.lastY - surfaceTop) / Math.max(renderedHeight, 1), 0, 1) * 100}%`);
    updateSegmentRefraction(refraction, state.width, height, state.pressed, state.velocity);
  };
  const animateTo = (index, initialVelocity = 0) => {
    if (!layout.items.length) return;
    stop();
    const destination = clamp(index, 0, layout.items.length - 1);
    state.target = layout.centers[destination];
    state.targetWidth = layout.rects[destination].width;
    state.distance = Math.abs(state.target - state.center);
    state.velocity = initialVelocity;
    state.moving = state.distance > 1 || Math.abs(state.targetWidth - state.width) > 1;
    if (reducedMotion.matches) {
      state.center = state.target;
      state.width = state.targetWidth;
      state.velocity = 0;
      state.moving = false;
      setVisualTarget(destination);
      commitTarget(destination);
      render();
      return;
    }
    if (!state.moving && Math.abs(state.velocity) < 2) {
      setVisualTarget(destination);
      commitTarget(destination);
      render();
      return;
    }
    host.classList.add('is-moving');
    let previous = performance.now();
    const step = (now) => {
      const dt = Math.min(.034, Math.max(.008, (now - previous) / 1000));
      previous = now;
      state.velocity += (state.target - state.center) * 520 * dt;
      state.velocity *= Math.exp(-35 * dt);
      state.center += state.velocity * dt;
      state.widthVelocity += (state.targetWidth - state.width) * 470 * dt;
      state.widthVelocity *= Math.exp(-34 * dt);
      state.width += state.widthVelocity * dt;
      const crossed = nearestIndex(state.center);
      setVisualTarget(crossed);
      commitTarget(crossed);
      render();
      if (Math.abs(state.target - state.center) < .65 && Math.abs(state.velocity) < 12 && Math.abs(state.targetWidth - state.width) < .4) {
        state.center = state.target;
        state.width = state.targetWidth;
        state.velocity = 0;
        state.widthVelocity = 0;
        state.moving = false;
        state.distance = 0;
        setVisualTarget(destination);
        commitTarget(destination);
        host.classList.remove('is-moving');
        render();
        state.raf = 0;
        return;
      }
      state.raf = requestAnimationFrame(step);
    };
    state.raf = requestAnimationFrame(step);
  };
  const begin = (event) => {
    const item = event.target.closest(itemSelector);
    if (!item || !host.contains(item) || item.disabled || item.querySelector('input:disabled')) return;
    measure(false);
    const index = layout.items.indexOf(item);
    if (index < 0) return;
    stop();
    const axis = event.clientX - layout.hostRect.left + layout.scrollLeft;
    state.dragging = true;
    state.pointerId = event.pointerId;
    state.pressedIndex = index;
    state.start = axis;
    state.lastAxis = axis;
    state.last = event.clientX;
    state.lastY = event.clientY;
    state.lastTime = performance.now();
    state.dragOffset = axis - layout.centers[index];
    state.moved = false;
    state.pressed = 1;
    state.velocity = 0;
    state.suppressNativeClick = index !== state.committedIndex;
    host.classList.add('is-pressed');
    animateTo(index, 0);
    render();
  };
  const move = (event) => {
    if (!state.dragging || event.pointerId !== state.pointerId) return;
    const axis = event.clientX - layout.hostRect.left + layout.scrollLeft;
    const now = performance.now();
    const dt = Math.max(8, now - state.lastTime);
    state.velocity = (axis - state.lastAxis) / dt * 1000;
    state.lastAxis = axis;
    state.last = event.clientX;
    state.lastY = event.clientY;
    state.lastTime = now;
    if (!state.moved && Math.abs(axis - state.start) > 3) {
      state.moved = true;
      stop();
      state.moving = false;
      state.distance = 0;
      host.classList.add('is-moving', 'is-dragging');
      try { host.setPointerCapture?.(event.pointerId); } catch (_) { /* synthetic pointers do not always support capture */ }
    }
    if (!state.moved) return;
    event.preventDefault();
    const first = layout.centers[0];
    const last = layout.centers[layout.centers.length - 1];
    state.center = clamp(axis - state.dragOffset, first, last);
    const target = nearestIndex(state.center);
    state.width = layout.rects[target].width;
    setVisualTarget(target);
    commitTarget(target);
    render();
  };
  const end = (event) => {
    if (!state.dragging || (event && event.pointerId !== state.pointerId)) return;
    state.dragging = false;
    try { host.releasePointerCapture?.(state.pointerId); } catch (_) { /* capture may already be released */ }
    const destination = state.moved ? state.active : state.pressedIndex;
    const releaseVelocity = state.velocity;
    state.pointerId = null;
    state.pressedIndex = null;
    state.pressed = 0;
    host.classList.remove('is-pressed', 'is-dragging');
    animateTo(destination, releaseVelocity);
    if (state.suppressNativeClick) requestAnimationFrame(() => { state.suppressNativeClick = false; });
  };
  host.addEventListener('pointerdown', begin);
  host.addEventListener('pointermove', move, { passive: false });
  host.addEventListener('pointerup', end);
  host.addEventListener('pointercancel', end);
  host.addEventListener('lostpointercapture', (event) => { if (state.dragging) end(event); });
  host.addEventListener('click', (event) => {
    if (event.liquidSegmentCommit) return;
    if (state.suppressNativeClick && event.detail > 0) {
      event.preventDefault();
      event.stopImmediatePropagation();
      state.suppressNativeClick = false;
      return;
    }
    const item = event.target.closest(itemSelector);
    if (!item) return;
    const index = layout.items.indexOf(item);
    if (index >= 0) animateTo(index, 0);
  }, true);
  if (typeof MutationObserver === 'function') {
    const activeObserver = new MutationObserver((records) => {
      const activeChanged = records.some((record) => {
        if (!layout.items.includes(record.target)) return false;
        if (record.attributeName !== 'class') return true;
        const wasActive = String(record.oldValue || '').split(/\s+/).includes('active');
        return wasActive !== record.target.classList.contains('active');
      });
      if (!activeChanged) return;
      requestAnimationFrame(() => {
        measure(false);
        const next = getActiveIndex();
        if (!state.dragging && next !== state.active) animateTo(next, 0);
      });
    });
    activeObserver.observe(host, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['class', 'aria-selected', 'aria-pressed'] });
  }
  if (typeof ResizeObserver === 'function') {
    const resizeObserver = new ResizeObserver(() => { measure(false); render(); });
    resizeObserver.observe(host);
  } else {
    window.addEventListener('resize', () => { measure(false); render(); }, { passive: true });
  }
  requestAnimationFrame(() => { measure(true); setVisualTarget(getActiveIndex()); render(); });
}

ensureLiquidFilter();
decorate();
document.querySelectorAll('.home-nav-links').forEach(setupHomeLiquidNavigation);
document.querySelectorAll('.nav-list').forEach((nav) => {
  if (nav.closest('.workspace-shell, .admin-shell')) setupWorkspaceLiquidNavigation(nav);
  else setupGenericLiquidNavigation(nav);
});
document.querySelectorAll('.production-mode-switcher').forEach((host) => setupLiquidSegment(host, '.production-mode-tab'));
document.querySelectorAll('.copy-modes').forEach((host) => setupLiquidSegment(host, '.copy-mode'));
document.querySelectorAll('.publish-mode-group').forEach((host) => setupLiquidSegment(host, '.publish-mode-option'));

if (typeof MutationObserver === 'function') {
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        decorate(node);
        if (node.matches('.home-nav-links')) setupHomeLiquidNavigation(node);
        if (node.matches('.nav-list')) {
          if (node.closest('.workspace-shell, .admin-shell')) setupWorkspaceLiquidNavigation(node);
          else setupGenericLiquidNavigation(node);
        }
        node.querySelectorAll?.('.home-nav-links').forEach(setupHomeLiquidNavigation);
        node.querySelectorAll?.('.nav-list').forEach((nav) => {
          if (nav.closest('.workspace-shell, .admin-shell')) setupWorkspaceLiquidNavigation(nav);
          else setupGenericLiquidNavigation(nav);
        });
        if (node.matches('.production-mode-switcher')) setupLiquidSegment(node, '.production-mode-tab');
        if (node.matches('.copy-modes')) setupLiquidSegment(node, '.copy-mode');
        if (node.matches('.publish-mode-group')) setupLiquidSegment(node, '.publish-mode-option');
        node.querySelectorAll?.('.production-mode-switcher').forEach((host) => setupLiquidSegment(host, '.production-mode-tab'));
        node.querySelectorAll?.('.copy-modes').forEach((host) => setupLiquidSegment(host, '.copy-mode'));
        node.querySelectorAll?.('.publish-mode-group').forEach((host) => setupLiquidSegment(host, '.publish-mode-option'));
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
