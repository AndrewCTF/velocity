// Velocity site behaviors: nav state, scroll reveals, count-ups, copy button.
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Nav background after leaving the hero
const nav = document.getElementById('nav');
const onScroll = () => nav.classList.toggle('scrolled', scrollY > 40);
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
const setMenu = (open) => {
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  if (open) navLinks.setAttribute('data-open', '');
  else navLinks.removeAttribute('data-open');
};
toggle.addEventListener('click', () => setMenu(toggle.getAttribute('aria-expanded') !== 'true'));
navLinks.addEventListener('click', (e) => { if (e.target.tagName === 'A') setMenu(false); });
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') { setMenu(false); toggle.focus(); }
});
// Leaving the breakpoint must not strand the panel open on desktop.
matchMedia('(min-width: 761px)').addEventListener('change', (e) => { if (e.matches) setMenu(false); });
document.addEventListener('click', (e) => {
  if (toggle.getAttribute('aria-expanded') !== 'true') return;
  if (!nav.contains(e.target)) setMenu(false);
});

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
