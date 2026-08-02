(() => {
  const FOCUSABLE = 'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])';
  const name = el => el.getAttribute('aria-label') || el.textContent.trim()
    || el.getAttribute('title') || [...el.querySelectorAll('img[alt]')].map(i => i.alt).join(' ').trim();
  const smalls = {};
  document.querySelectorAll('*').forEach(el => {
    if (!el.textContent.trim() || el.children.length) return;
    const px = parseFloat(getComputedStyle(el).fontSize);
    if (px < 12) smalls[px] = (smalls[px] || 0) + 1;
  });
  const unreachable = [...document.querySelectorAll('.row,.chip,.tool,.toggle,.pitem,.pinstrip .p')]
    .filter(el => !el.matches(FOCUSABLE) && !el.querySelector(FOCUSABLE));
  const unnamed = [...document.querySelectorAll(FOCUSABLE)].filter(el => !name(el));
  return JSON.stringify({ belowFloor: Object.keys(smalls).length, focusable: document.querySelectorAll(FOCUSABLE).length,
    unreachable: unreachable.length, unnamed: unnamed.length });
})()
