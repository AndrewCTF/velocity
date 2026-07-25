// Velocity site behaviors: nav state, scroll reveals, count-ups, copy button.
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Nav background after leaving the hero
const nav = document.getElementById('nav');
// The announcement strip retracts on first scroll and the nav slides up into
// its place, so it costs no vertical space below the fold.
const topbar = document.getElementById('topbar');
const topbarX = document.getElementById('topbar-x');
let barDismissed = false;
const onScroll = () => {
  nav.classList.toggle('scrolled', scrollY > 40);
  document.body.classList.toggle('bar-gone', barDismissed || scrollY > 24);
};
topbarX.addEventListener('click', () => {
  barDismissed = true;
  document.body.classList.add('bar-gone');
  topbar.setAttribute('aria-hidden', 'true');
  topbar.querySelectorAll('a,button').forEach((e) => e.setAttribute('tabindex', '-1'));
});
addEventListener('scroll', onScroll, { passive: true });
onScroll();

// Reveal on enter + count-ups
const fmt = new Intl.NumberFormat('en-US');
const countUp = (el) => {
  const target = +el.dataset.count;
  const prefix = el.dataset.prefix || '';
  if (reduce) { el.textContent = prefix + fmt.format(target); return; }
  const t0 = performance.now(), dur = 1400;
  const tick = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - k, 3);
    el.textContent = prefix + fmt.format(Math.round(target * eased));
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    e.target.classList.add('in');
    e.target.querySelectorAll('[data-count]').forEach(countUp);
    io.unobserve(e.target);
  }
  // threshold 0 + a bottom inset: a section taller than the viewport can never
  // reach a ratio threshold, which left the last gallery cards at opacity 0.
}, { threshold: 0, rootMargin: '0px 0px -12% 0px' });
document.querySelectorAll('.reveal').forEach((el) => {
  if (reduce) {
    el.classList.add('in');
    el.querySelectorAll('[data-count]').forEach(countUp);
  } else io.observe(el);
});

// Mobile menu. The five section links are unreachable below 760px without it.
const toggle = document.getElementById('nav-toggle');
const navLinks = document.getElementById('nav-links');
const navFoot = document.querySelector('.nav-foot');
const setMenu = (open) => {
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  navLinks.toggleAttribute('data-open', open);
  nav.classList.toggle('menu-open', open);
  // Full-screen overlay, so the page behind it must not scroll.
  document.body.classList.toggle('menu-locked', open);
  navFoot.setAttribute('aria-hidden', String(!open));
  navFoot.querySelectorAll('a').forEach((a) => a.setAttribute('tabindex', open ? '0' : '-1'));
  // The overlay covers the viewport but does not stop the page behind it being
  // tabbable, so tab focus walked into the hero button and the FAQ. inert takes
  // that content out of both the tab order and the accessibility tree.
  for (const el of document.body.children) {
    if (el !== nav) el.toggleAttribute('inert', open);
  }
  // Move focus into the overlay. A rAF is too early: the pointer interaction
  // that opened the menu still focuses the toggle afterwards.
  if (open) setTimeout(() => navLinks.querySelector('a')?.focus(), 60);
};
toggle.addEventListener('click', () => setMenu(toggle.getAttribute('aria-expanded') !== 'true'));
navLinks.addEventListener('click', (e) => { if (e.target.tagName === 'A') setMenu(false); });
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') { setMenu(false); toggle.focus(); }
});
// Leaving the breakpoint must not strand the panel open on desktop.
matchMedia('(min-width: 761px)').addEventListener('change', (e) => { if (e.matches) setMenu(false); });

// Copy quick-start commands
document.querySelectorAll('.copy-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(btn.dataset.copy);
      btn.textContent = 'copied';
    } catch {
      btn.textContent = 'copy failed';
    }
    setTimeout(() => (btn.textContent = 'copy'), 1600);
  });
});
