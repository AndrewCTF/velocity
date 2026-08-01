(() => {
  const FOCUSABLE = 'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])';
  return JSON.stringify([...document.querySelectorAll(FOCUSABLE)]
    .filter(el => !(el.getAttribute('aria-label') || el.textContent.trim() || el.getAttribute('title')))
    .map(el => el.outerHTML.slice(0, 150)));
})()
