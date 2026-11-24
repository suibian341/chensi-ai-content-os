(() => {
  'use strict';

  const header = document.querySelector('.home-header');
  const nav = document.querySelector('.home-nav-links');
  const navLinks = [...document.querySelectorAll('.home-nav-links a[href^="#"]')];
  const sections = navLinks
    .map((link) => document.querySelector(link.getAttribute('href')))
    .filter(Boolean);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const gsap = window.gsap;

  if (gsap && window.ScrollTrigger) {
    gsap.registerPlugin(window.ScrollTrigger);
  }

  let activeLink = null;
  let scrollTicking = false;
  let resizeTicking = false;
  let targetTimer = 0;
  let navigationTarget = null;
  let navigationLockTimer = 0;

  const releaseNavigationLock = () => {
    navigationTarget = null;
    window.clearTimeout(navigationLockTimer);
    navigationLockTimer = 0;
  };

  const headerOffset = () => {
    const shell = header?.querySelector('.home-nav-shell');
    return (shell?.getBoundingClientRect().height || 64) + 24;
  };

  const setActive = (link, { immediate = false } = {}) => {
    if (!link) return;
    activeLink = link;
    navLinks.forEach((item) => {
      const active = item === link;
      item.classList.toggle('is-active', active);
      if (active) item.setAttribute('aria-current', 'true');
      else item.removeAttribute('aria-current');
    });
    // liquid-glass.js observes the active class and owns the capsule geometry.
    nav?.classList.toggle('is-home-active', Boolean(link));
  };

  const updateHeader = () => {
    header?.classList.toggle('is-scrolled', window.scrollY > 24);
    scrollTicking = false;
  };

  window.addEventListener('scroll', () => {
    if (!scrollTicking) {
      window.requestAnimationFrame(updateHeader);
      scrollTicking = true;
    }
  }, { passive: true });

  window.addEventListener('resize', () => {
    if (resizeTicking) return;
    resizeTicking = true;
    window.requestAnimationFrame(() => {
      resizeTicking = false;
    });
  }, { passive: true });

  updateHeader();

  const initialTarget = window.location.hash
    ? navLinks.find((link) => link.getAttribute('href') === window.location.hash)
    : navLinks[0];
  setActive(initialTarget, { immediate: true });

  navLinks.forEach((link) => {
    link.addEventListener('click', (event) => {
      const target = document.querySelector(link.getAttribute('href'));
      if (!target) return;

      event.preventDefault();
      setActive(link);
      navigationTarget = target;
      window.clearTimeout(navigationLockTimer);
      navigationLockTimer = window.setTimeout(releaseNavigationLock, 1800);

      window.clearTimeout(targetTimer);
      target.classList.remove('is-nav-target');
      window.requestAnimationFrame(() => target.classList.add('is-nav-target'));
      targetTimer = window.setTimeout(() => target.classList.remove('is-nav-target'), 720);

      const top = Math.max(0, Math.round(target.getBoundingClientRect().top + window.scrollY - headerOffset()));
      window.scrollTo({ top, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
    });
  });

  if ('IntersectionObserver' in window && sections.length) {
    const sectionObserver = new IntersectionObserver((entries) => {
      // A homepage capsule drag is a deliberate selection gesture. Ignore
      // transient intersections until the gesture and its smooth scroll have
      // committed the final tab.
      if (nav?.classList.contains('is-dragging') || navigationTarget) return;
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible) return;
      const link = navLinks.find((item) => item.getAttribute('href') === `#${visible.target.id}`);
      if (link && link !== activeLink) setActive(link);
    }, { rootMargin: '-18% 0px -60%', threshold: [0, 0.2, 0.55] });
    sections.forEach((section) => sectionObserver.observe(section));
  }

  window.addEventListener('scrollend', releaseNavigationLock, { passive: true });

  if (!gsap || reducedMotion.matches) return;

  const mm = gsap.matchMedia();
  mm.add('(prefers-reduced-motion: no-preference)', () => {
    const intro = gsap.timeline({ defaults: { ease: 'power3.out' } });
    intro
      .from('.home-nav-shell', { y: -18, autoAlpha: 0, duration: 0.55 })
      .from('.home-availability', { y: 12, autoAlpha: 0, duration: 0.45 }, '-=0.24')
      .from('.home-hero .home-kicker', { y: 12, autoAlpha: 0, duration: 0.42 }, '-=0.28')
      .from('.home-hero h1', { y: 20, autoAlpha: 0, duration: 0.7 }, '-=0.28')
      .from(['.home-hero-lead', '.home-hero-description'], { y: 16, autoAlpha: 0, duration: 0.55, stagger: 0.09 }, '-=0.42')
      .from('.home-hero-actions .home-button', { y: 12, autoAlpha: 0, duration: 0.42, stagger: 0.07 }, '-=0.3')
      .from('.home-proof-list', { y: 10, autoAlpha: 0, duration: 0.4 }, '-=0.25')
      .from('.home-product-window', { y: 32, rotateX: 5, scale: 0.975, autoAlpha: 0, duration: 0.9 }, '-=0.26')
      .from('.home-floating-card', { y: 16, scale: 0.95, autoAlpha: 0, duration: 0.5, stagger: 0.1 }, '-=0.38');

    if (window.ScrollTrigger) {
      gsap.utils.toArray('.home-section-heading, .home-workflow-heading, .home-teams-copy, .home-final-cta .home-section-inner').forEach((heading) => {
        gsap.from(heading, {
          scrollTrigger: { trigger: heading, start: 'top 84%', once: true },
          y: 24,
          autoAlpha: 0,
          duration: 0.7,
          ease: 'power3.out'
        });
      });

      gsap.from('.home-capability-item', {
        scrollTrigger: { trigger: '.home-capability-grid', start: 'top 82%', once: true },
        y: 28,
        autoAlpha: 0,
        duration: 0.62,
        stagger: 0.08,
        ease: 'power3.out'
      });

      gsap.from('.home-workflow-steps li', {
        scrollTrigger: { trigger: '.home-workflow-steps', start: 'top 82%', once: true },
        y: 20,
        autoAlpha: 0,
        duration: 0.55,
        stagger: 0.07,
        ease: 'power3.out'
      });

      gsap.from('.home-team-features > *', {
        scrollTrigger: { trigger: '.home-team-features', start: 'top 82%', once: true },
        x: 24,
        autoAlpha: 0,
        duration: 0.58,
        stagger: 0.08,
        ease: 'power3.out'
      });
    }

    return () => intro.kill();
  });

  mm.add('(min-width: 900px) and (pointer: fine) and (prefers-reduced-motion: no-preference)', () => {
    const scene = document.querySelector('.home-preview-scene');
    const windowEl = document.querySelector('.home-product-window');
    if (!scene || !windowEl) return undefined;

    const rotateX = gsap.quickTo(windowEl, 'rotateX', { duration: 0.45, ease: 'power3.out' });
    const rotateY = gsap.quickTo(windowEl, 'rotateY', { duration: 0.45, ease: 'power3.out' });

    const onMove = (event) => {
      const bounds = scene.getBoundingClientRect();
      const x = (event.clientX - bounds.left) / bounds.width - 0.5;
      const y = (event.clientY - bounds.top) / bounds.height - 0.5;
      rotateX(2 - y * 2.4);
      rotateY(x * 2.8);
    };
    const onLeave = () => {
      rotateX(2);
      rotateY(0);
    };

    scene.addEventListener('pointermove', onMove, { passive: true });
    scene.addEventListener('pointerleave', onLeave, { passive: true });
    return () => {
      scene.removeEventListener('pointermove', onMove);
      scene.removeEventListener('pointerleave', onLeave);
    };
  });
})();
