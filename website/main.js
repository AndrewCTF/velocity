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
    // Idempotent instead of unobserved: a block jumped over by an End-key press
    // or a scrollbar drag was never intersected, and unobserving on first hit
    // meant it stayed invisible forever once passed. Now it catches up on
    // re-entry, and re-firing on an already-revealed block is a no-op.
    if (e.target.classList.contains('in')) continue;
    e.target.classList.add('in');
    // A wipe inside a revealed block runs with it, so the row and its artifact
    // are one event rather than two.
    e.target.querySelectorAll('.wipe, .wipe-r').forEach((w) => w.classList.add('in'));
    e.target.querySelectorAll('[data-count]').forEach(countUp);
  }
  // threshold 0 + a bottom inset: a section taller than the viewport can never
  // reach a ratio threshold, which left the last gallery cards at opacity 0.
}, { threshold: 0, rootMargin: '0px 0px -12% 0px' });
document.querySelectorAll('.reveal').forEach((el) => {
  if (reduce) {
    el.classList.add('in');
    el.querySelectorAll('.wipe, .wipe-r').forEach((w) => w.classList.add('in'));
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

// ---------- launch film player ----------
// The native controls are replaced, not restyled: browsers will not let you
// touch their chrome, and a stock control bar is the one element on the page
// that looks like every other page. Guarded so the rest of main.js is unaffected
// if the band is ever removed.
const film = document.getElementById('film');
if (film) {
  const video = document.getElementById('film-video');
  const bigPlay = document.getElementById('film-play');
  const bar = document.getElementById('film-bar');
  const track = document.getElementById('film-track');
  const fill = document.getElementById('film-fill');
  const time = document.getElementById('film-time');
  const toggleBtn = document.getElementById('film-toggle');
  const muteBtn = document.getElementById('film-mute');
  const fullBtn = document.getElementById('film-full');

  const ICON = {
    play: '<svg viewBox="0 0 24 24" aria-hidden="true" width="15" height="15"><path d="M8 5.2v13.6L19 12z" fill="currentColor"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true" width="15" height="15"><path d="M7 5h3.4v14H7zM13.6 5H17v14h-3.4z" fill="currentColor"/></svg>',
    loud: '<svg viewBox="0 0 24 24" aria-hidden="true" width="15" height="15"><path d="M4 9.5h3.4L12 5.6v12.8L7.4 14.5H4z" fill="currentColor"/><path d="M15.4 9.2a4 4 0 0 1 0 5.6M17.9 6.7a7.5 7.5 0 0 1 0 10.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    muted: '<svg viewBox="0 0 24 24" aria-hidden="true" width="15" height="15"><path d="M4 9.5h3.4L12 5.6v12.8L7.4 14.5H4z" fill="currentColor"/><path d="M15.6 9.6l4.8 4.8M20.4 9.6l-4.8 4.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  };
  const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  // The bar lives only while the pointer is in the frame, and retreats a beat
  // after it stops moving — the film should be the only thing on screen.
  let idle;
  const show = () => {
    film.classList.add('is-live');
    clearTimeout(idle);
    if (!video.paused) idle = setTimeout(() => film.classList.remove('is-live'), 2200);
  };
  film.addEventListener('mousemove', show);
  film.addEventListener('mouseleave', () => { if (!video.paused) film.classList.remove('is-live'); });
  film.addEventListener('focusin', show);

  const play = () => video.play().catch(() => {});
  const flip = () => (video.paused ? play() : video.pause());
  bigPlay.addEventListener('click', play);
  video.addEventListener('click', flip);
  toggleBtn.addEventListener('click', flip);

  video.addEventListener('play', () => {
    film.classList.add('is-playing');
    toggleBtn.innerHTML = ICON.pause;
    toggleBtn.setAttribute('aria-label', 'Pause');
    show();
  });
  video.addEventListener('pause', () => {
    toggleBtn.innerHTML = ICON.play;
    toggleBtn.setAttribute('aria-label', 'Play');
    show();
  });
  video.addEventListener('ended', () => {
    // load() drops the decoded media so the poster comes back. Seeking to 0
    // instead leaves the film's own first frame on screen, which is black.
    film.classList.remove('is-playing', 'is-live');
    video.load();
  });
  video.addEventListener('timeupdate', () => {
    const d = video.duration || 52;
    const p = Math.min(1, video.currentTime / d);
    fill.style.width = `${(p * 100).toFixed(2)}%`;
    time.textContent = `${clock(video.currentTime)} / ${clock(d)}`;
    track.setAttribute('aria-valuenow', Math.round(video.currentTime));
    track.setAttribute('aria-valuetext', `${Math.round(video.currentTime)} seconds`);
  });

  const seekTo = (clientX) => {
    const r = track.getBoundingClientRect();
    video.currentTime = ((clientX - r.left) / r.width) * (video.duration || 52);
  };
  track.addEventListener('pointerdown', (e) => {
    seekTo(e.clientX);
    const move = (m) => seekTo(m.clientX);
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  });
  track.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: -5, ArrowRight: 5, Home: -1e4, End: 1e4 }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    video.currentTime = Math.max(0, Math.min(video.duration || 52, video.currentTime + step));
  });

  muteBtn.addEventListener('click', () => {
    video.muted = !video.muted;
    muteBtn.innerHTML = video.muted ? ICON.muted : ICON.loud;
    muteBtn.setAttribute('aria-label', video.muted ? 'Unmute' : 'Mute');
  });
  fullBtn.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else film.requestFullscreen?.().catch(() => {});
  });
}

