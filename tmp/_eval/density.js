(() => {
  const r = document.querySelector('.row');
  const s = document.querySelector('.sech');
  const t = document.querySelector('.dock .pbody');
  const px = e => e ? Math.round(e.getBoundingClientRect().height) : null;
  return JSON.stringify({
    rowHeight: px(r),
    sectionHeadHeight: px(s),
    bodyPadding: t ? getComputedStyle(t).padding : null,
    rowsInFirstScreen: [...document.querySelectorAll('.dock.left .row')]
      .filter(e => e.getBoundingClientRect().top < 1000).length
  });
})()
