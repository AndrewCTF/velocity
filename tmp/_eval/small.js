(() => {
  const out = [];
  document.querySelectorAll('*').forEach(el => {
    if (!el.textContent.trim() || el.children.length) return;
    const px = parseFloat(getComputedStyle(el).fontSize);
    if (px < 12) out.push(px + 'px :: ' + el.tagName + ' :: ' + el.textContent.trim().slice(0, 30));
  });
  return JSON.stringify(out);
})()
