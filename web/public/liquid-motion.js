(() => {
  const start = () => {
    const body = document.body;
    if (!body || body.dataset.liquidMotionReady) return;
    body.dataset.liquidMotionReady = 'true';

    const ambient = document.createElement('div');
    ambient.className = 'liquid-ambient';
    ambient.setAttribute('aria-hidden', 'true');
    ambient.append(document.createElement('span'), document.createElement('span'), document.createElement('span'), document.createElement('span'), document.createElement('span'));
    body.prepend(ambient);

    const gsap = window.gsap;
    if (!gsap) return;
    const mm = gsap.matchMedia();

    const reveal = (targets, options = {}) => {
      const elements = gsap.utils.toArray(targets).filter((node) => node instanceof HTMLElement && !node.classList.contains('hidden'));
      if (!elements.length) return null;
      return gsap.fromTo(elements, {
        autoAlpha: 0,
        y: options.y ?? 10,
        scale: options.scale ?? 1
      }, {
        autoAlpha: 1,
        y: 0,
        scale: 1,
        duration: options.duration ?? .36,
        ease: options.ease ?? 'power2.out',
        stagger: options.stagger ?? .045,
        clearProps: 'opacity,visibility,transform',
        overwrite: 'auto'
      });
    };

    mm.add({
      full: '(prefers-reduced-motion: no-preference)',
      desktop: '(min-width: 821px) and (hover: hover) and (pointer: fine)',
      reduced: '(prefers-reduced-motion: reduce)'
    }, (context) => {
      const { full, desktop } = context.conditions;
      if (!full) {
        gsap.set('[data-motion-pending]', { clearProps: 'all' });
        return;
      }

      // Workspace interactions have their own pointer-driven indicators. Keep
      // the large ambient blobs static there so background painting cannot
      // compete with tab and switch feedback on slower machines.
      const animateAmbient = !body.matches('.workspace-page, .admin-page');
      const animateContent = !body.matches('.workspace-page, .admin-page');

      const landing = gsap.timeline({ defaults: { ease: 'power2.out' } });
      landing
        .fromTo('.sidebar', { autoAlpha: 0, x: desktop ? -14 : 0, y: desktop ? 0 : -7 }, { autoAlpha: 1, x: 0, y: 0, duration: .42, clearProps: 'opacity,visibility,transform' })
        .fromTo('.topbar', { autoAlpha: 0, y: -8 }, { autoAlpha: 1, y: 0, duration: .34, clearProps: 'opacity,visibility,transform' }, '-=.28');
      const firstView = document.querySelector('.content-view:not(.hidden), .admin-view:not(.hidden), .auth-shell');
      if (firstView) {
        const targets = firstView.matches('.auth-shell')
          ? [firstView]
          : [...firstView.querySelectorAll(':scope > .hero-panel, :scope > .view-heading, :scope > .summary-grid, :scope > .workflow-strip, :scope > .panel, :scope > .workspace-grid, :scope > .dual-grid, :scope > .overview-bottom')].slice(0, 8);
        if (animateContent) landing.add(reveal(targets.length ? targets : firstView, { y: 12, duration: .4, stagger: .055 }), '-=.2');
      }

      /* Closed, linear paths keep every colour field moving at a constant
         velocity. The old sine/yoyo tweens visibly paused at each endpoint. */
      const ambientPaths = [
        { duration: 12, points: [[92, 42, 1.08], [148, -16, .96], [-34, -72, 1.04]] },
        { duration: 15, points: [[-78, -56, 1.06], [-138, 28, .95], [24, 74, 1.03]] },
        { duration: 17, points: [[104, -44, 1.07], [30, -112, .96], [-92, -18, 1.04]] },
        { duration: 14, points: [[-88, 62, 1.05], [-24, 138, .96], [116, 66, 1.03]] },
        { duration: 16, points: [[68, 82, 1.06], [132, 8, .95], [-22, -76, 1.04]] }
      ];
      if (animateAmbient) {
        [...ambient.children].forEach((blob, index) => {
          const path = ambientPaths[index];
          const timeline = gsap.timeline({ repeat: -1, defaults: { ease: 'none' } });
          path.points.forEach(([x, y, scale], pointIndex) => {
            timeline.to(blob, {
              x,
              y,
              scale,
              duration: path.duration / 4
            }, pointIndex * path.duration / 4);
          });
          timeline.to(blob, {
            x: 0,
            y: 0,
            scale: 1,
            duration: path.duration / 4
          }, path.duration * .75);
        });
      } else {
        gsap.set(ambient.children, { x: 0, y: 0, scale: 1, clearProps: 'transform' });
      }

      const selectObservers = new WeakSet();
      const visibleObserver = new MutationObserver((records) => {
        for (const record of records) {
          const node = record.target;
          if (!(node instanceof HTMLElement) || node.classList.contains('hidden')) continue;
          if (node.matches('.content-view, .admin-view') && animateContent) {
            const children = [...node.querySelectorAll(':scope > .hero-panel, :scope > .view-heading, :scope > .summary-grid, :scope > .workflow-strip, :scope > .panel, :scope > .workspace-grid, :scope > .dual-grid, :scope > .overview-bottom')].slice(0, 9);
            reveal(children.length ? children : node, { y: 9, duration: .32, stagger: .035 });
          } else if (node.matches('.modal-backdrop, .asset-preview-backdrop')) {
            gsap.fromTo(node, { autoAlpha: 0 }, { autoAlpha: 1, duration: .18, ease: 'power1.out', clearProps: 'opacity,visibility' });
            reveal(node.querySelector('.modal, .asset-preview-dialog'), { y: 8, scale: .97, duration: .25, stagger: 0 });
          } else if (node.matches('.ui-select-popover')) {
            const direction = node.dataset.placement === 'top' ? 4 : -4;
            reveal(node, { y: direction, scale: .98, duration: .18, stagger: 0 });
          } else if (node.matches('.toast') && node.classList.contains('show')) {
            gsap.fromTo(node, { y: 10, scale: .98 }, { y: 0, scale: 1, duration: .22, ease: 'power2.out', clearProps: 'transform' });
          }
        }
      });
      document.querySelectorAll('.content-view, .admin-view, .modal-backdrop, .asset-preview-backdrop, .ui-select-popover, .toast').forEach((node) => {
        visibleObserver.observe(node, { attributes: true, attributeFilter: ['class', 'data-placement'] });
        if (node.matches('.ui-select-popover')) selectObservers.add(node);
      });

      const componentObserver = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (!(node instanceof HTMLElement)) continue;
            const popovers = node.matches('.ui-select-popover') ? [node] : [...node.querySelectorAll('.ui-select-popover')];
            for (const popover of popovers) {
              if (selectObservers.has(popover)) continue;
              selectObservers.add(popover);
              visibleObserver.observe(popover, { attributes: true, attributeFilter: ['class', 'data-placement'] });
            }
          }
        }
      });
      componentObserver.observe(document.body, { childList: true, subtree: true });

      const dynamicSelectors = '.summary-grid, .feature-grid, .asset-grid, .history-list, .data-table, .team-member-list, .ticket-list, .output-list, .platform-grid, .template-grid, .provider-status-list';
      let dynamicRevealQueued = false;
      const dynamicObserver = new MutationObserver((records) => {
        if (!animateContent || document.querySelector('.liquid-segment-host:is(.is-moving, .is-pressed, .is-dragging)')) return;
        const added = [];
        for (const record of records) {
          for (const node of record.addedNodes) if (node instanceof HTMLElement) added.push(node);
        }
        if (added.length && added.length <= 20 && !dynamicRevealQueued) {
          dynamicRevealQueued = true;
          requestAnimationFrame(() => {
            dynamicRevealQueued = false;
            reveal(added.slice(0, 12), { y: 6, duration: .25, stagger: .025 });
          });
        }
      });
      document.querySelectorAll(dynamicSelectors).forEach((node) => dynamicObserver.observe(node, { childList: true }));

      return () => {
        visibleObserver.disconnect();
        dynamicObserver.disconnect();
        componentObserver.disconnect();
      };
    });

    window.addEventListener('pagehide', () => mm.revert(), { once: true });
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
