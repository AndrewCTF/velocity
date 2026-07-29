// The launch-film director, injected into the running console.
//
// Everything is a pure function of t: camera, cinema stack, and every overlay
// transform. The shoot steps t frame by frame, so the same t always produces
// the same pixels. Three beats are real 3D motion rather than captions over a
// screen recording: feed chips arriving through depth, the live satellite
// constellation, and the console's domains exploding apart as stacked planes.
//
// Motion spec (researched, not invented): entrances ease-out over 0.5-0.8s,
// exits ease-in over 0.25-0.3s, nothing linear except deliberate camera rails,
// one idea per shot, hard cuts between acts, opening title on black.
window.__installFilm = function (opts) {
  const { archivoB64, monoB64, stats } = opts;
  const V = window.__viewer;
  const C = window.__Cesium;
  const scene = V.scene;

  // ---------------------------------------------------------------- cinema
  scene.msaaSamples = 1;
  // At 3840x2160 the tile pyramid and the HDR float targets are what exhaust
  // the card, not the geometry. A smaller resident cache and a slightly looser
  // screen-space error keep the whole shoot inside the GPU's budget; bloom
  // still works without a float pipeline.
  scene.globe.tileCacheSize = 40;
  scene.globe.maximumScreenSpaceError = 3;
  scene.globe.dynamicAtmosphereLighting = true;
  scene.fog.enabled = true;
  scene.fog.density = 0.00026;
  const bloom = scene.postProcessStages.bloom;
  bloom.uniforms.glowOnly = false;
  bloom.uniforms.contrast = 128;
  bloom.uniforms.brightness = -0.42;
  bloom.uniforms.delta = 1.3;
  bloom.uniforms.sigma = 2.4;
  bloom.uniforms.stepSize = 1.0;
  V.clockViewModel.shouldAnimate = false;
  scene.light = new C.SunLight();
  V.clock.currentTime = C.JulianDate.fromIso8601('2026-07-26T17:40:00Z');

  // Resizing into a zero-sized container throws DeveloperError and kills the
  // render loop for the rest of the shoot. The app resizes on its own layout
  // changes too, so the guard goes on the viewer itself, not on our callers.
  const viewerEl = V.canvas.closest('.cesium-viewer') || V.container;
  const okSize = () => viewerEl.clientWidth > 0 && viewerEl.clientHeight > 0;
  // A floor on the geometry: every crash in this shoot has been Cesium
  // rendering into a container that a relayout momentarily collapsed.
  viewerEl.style.minWidth = '320px';
  viewerEl.style.minHeight = '240px';
  const rawResize = V.resize.bind(V);
  V.resize = () => { if (okSize()) rawResize(); };
  if (V.cesiumWidget) {
    const rawWidget = V.cesiumWidget.resize.bind(V.cesiumWidget);
    V.cesiumWidget.resize = () => { if (okSize()) rawWidget(); };
  }

  const shell = document.getElementById('root') || document.body.firstElementChild;
  let hidden = null;
  const stash = {};
  let hero = null;
  // The rails and panels are floating siblings of the globe, not a frame around
  // it, so hero shots walk the canvas's ancestor chain hiding every sibling,
  // then promote the viewer to the whole window.
  window.__filmHero = function (on) {
    if (on === hero) return;
    hero = on;
    if (on) {
      hidden = [];
      let e = V.canvas;
      while (e && e !== document.body) {
        const p = e.parentElement;
        if (!p) break;
        for (const sib of p.children) {
          if (sib !== e && sib.id !== 'film') {
            hidden.push([sib, sib.style.visibility]);
            sib.style.visibility = 'hidden';
          }
        }
        e = p;
      }
      stash.pos = viewerEl.style.position;
      stash.z = viewerEl.style.zIndex;
      viewerEl.style.position = 'fixed';
      viewerEl.style.inset = '0';
      viewerEl.style.width = '100vw';
      viewerEl.style.height = '100vh';
      viewerEl.style.zIndex = '2147482000';
    } else {
      for (const [sib, v] of hidden || []) sib.style.visibility = v;
      hidden = null;
      viewerEl.style.position = stash.pos || '';
      viewerEl.style.inset = '';
      viewerEl.style.width = '';
      viewerEl.style.height = '';
      viewerEl.style.zIndex = stash.z || '';
    }
    // HDR and bloom double every float target in the pipeline; at 4K device
    // pixels that is the VRAM budget (GlobeCanvas.tsx:598). Hero shots only.
    scene.globe.enableLighting = on;
    scene.highDynamicRange = false;
    bloom.enabled = on;
    // Hero shots put full-globe satellite imagery on a 3840x2160 canvas, which
    // is the one thing on this card that runs out of VRAM. From 14 Mm the
    // globe is small in frame, so a looser screen-space error and a smaller
    // resident cache cost nothing visible and keep the shoot alive.
    scene.globe.maximumScreenSpaceError = on ? 6 : 3;
    scene.globe.tileCacheSize = on ? 20 : 40;
    const credits = document.querySelector('.cesium-widget-credits');
    if (credits) credits.style.display = 'none';
    const settle = () => { if (okSize()) { rawResize(); scene.requestRender(); } else requestAnimationFrame(settle); };
    requestAnimationFrame(settle);
  };

  // ---------------------------------------------------------------- styles
  const style = document.createElement('style');
  style.textContent = `
@font-face { font-family: 'FilmSans'; src: url(data:font/woff2;base64,${archivoB64}) format('woff2'); font-weight: 100 900; font-stretch: 62% 125%; }
@font-face { font-family: 'FilmMono'; src: url(data:font/woff2;base64,${monoB64}) format('woff2'); font-weight: 100 900; }
#film { position: fixed; inset: 0; z-index: 2147483000; pointer-events: none; font-family: 'FilmSans', system-ui, sans-serif; color: #f2f6f9; }
#film .layer { position: absolute; inset: 0; }
#film .black { background: #03060a; z-index: 9; }
#film .scrim { background: radial-gradient(70% 55% at 24% 84%, rgba(2,6,12,.82) 0%, rgba(2,6,12,0) 70%); z-index: 3; }
#film .escrim { background: radial-gradient(48% 40% at 50% 44%, rgba(2,6,12,.88) 0%, rgba(2,6,12,0) 72%); z-index: 4; }
#film .vig { background: radial-gradient(118% 88% at 50% 46%, rgba(0,0,0,0) 40%, rgba(0,0,0,.58) 100%); }
#film .grade { background: linear-gradient(180deg, rgba(4,10,20,.42) 0%, rgba(0,0,0,0) 26%, rgba(0,0,0,0) 58%, rgba(2,6,12,.70) 100%); }
#film .mask { overflow: hidden; display: block; }
#film .mask > span { display: block; }
#film .center { z-index: 8; position: absolute; left: 0; right: 0; text-align: center; }
#film .wm { font-weight: 500; font-size: 122px; line-height: 1.14; }
#film .sub { font-weight: 300; font-size: 33px; line-height: 1.4; color: #c3cfd9; }
#film .hair { height: 1px; background: rgba(242,246,249,.46); margin: 30px auto 26px; }
#film .lower { z-index: 7; position: absolute; left: 104px; bottom: 120px; }
#film .kick { font-family: 'FilmMono', monospace; font-size: 15px; letter-spacing: .36em; color: #63cdff; text-transform: uppercase; }
#film .head { font-weight: 460; font-size: 80px; letter-spacing: -.024em; line-height: 1.12; margin-top: 14px; }
#film .hrule { height: 1px; background: linear-gradient(90deg, rgba(99,205,255,.85), rgba(99,205,255,0)); margin-top: 26px; }
#film .stats { z-index: 7; position: absolute; right: 104px; bottom: 126px; text-align: right; }
#film .st { margin-top: 26px; }
#film .st b { display: block; font-family: 'FilmMono', monospace; font-weight: 500; font-size: 66px; line-height: 1; letter-spacing: -.03em; }
#film .st i { display: block; font-style: normal; font-family: 'FilmMono', monospace; font-size: 13px; letter-spacing: .28em; color: #92a5b4; text-transform: uppercase; margin-top: 10px; }
#film .cmp { z-index: 7; position: absolute; left: 50%; margin-left: -370px; bottom: 172px; width: 740px; }
#film .row { display: flex; justify-content: space-between; align-items: baseline; padding: 16px 0; border-bottom: 1px solid rgba(242,246,249,.13); }
#film .row u { text-decoration: none; font-size: 27px; color: #aebbc7; }
#film .row s { text-decoration: none; font-family: 'FilmMono', monospace; font-size: 21px; color: #7f8f9d; }
#film .row.us u { color: #f2f6f9; } #film .row.us s { color: #63cdff; }
#film .ring { z-index: 7; position: absolute; border: 1px solid rgba(99,205,255,.9); box-shadow: 0 0 0 1px rgba(99,205,255,.14), 0 0 52px rgba(99,205,255,.20); }
#film .url { font-family: 'FilmMono', monospace; font-size: 30px; letter-spacing: .14em; color: #63cdff; }
#film .meta { font-family: 'FilmMono', monospace; font-size: 15px; letter-spacing: .32em; color: #92a5b4; margin-top: 26px; }

/* --- 3D stages. Perspective sits on the stage, transforms on the children,
       so every element is placed by one deterministic matrix per frame.
       Shadow blur radii stay small: at 4K a 90px blur on six large layers is
       compositor memory the GPU needs for the globe. --- */
#film .stage { z-index: 6; position: absolute; inset: 0; perspective: 1500px; perspective-origin: 50% 46%; transform-style: preserve-3d; }
#film .pills { position: absolute; left: 50%; top: 46%; width: 0; height: 0; transform-style: preserve-3d; }
#film .pill { position: absolute; left: 0; top: 0; transform-origin: 0 50%; white-space: nowrap;
  padding: 20px 34px; border-radius: 999px; font-family: 'FilmMono', monospace; font-size: 25px; letter-spacing: .04em;
  color: #eaf4fb; background: linear-gradient(180deg, rgba(14,26,40,.94), rgba(8,15,24,.94));
  border: 1px solid rgba(120,190,235,.42); box-shadow: 0 12px 24px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.10); }
#film .pill em { font-style: normal; color: #63cdff; margin-right: 14px; }
#film .planes { position: absolute; left: 50%; top: 50%; width: 0; height: 0; transform-style: preserve-3d; }
#film .plane { position: absolute; left: -420px; top: -270px; width: 840px; height: 540px;
  border: 1px solid rgba(120,190,235,.34); border-radius: 10px;
  background: linear-gradient(150deg, rgba(16,32,48,.66), rgba(6,12,20,.38));
  box-shadow: 0 14px 26px rgba(0,0,0,.5); }
#film .plane b { position: absolute; left: 30px; top: 22px; font-family: 'FilmMono', monospace; font-weight: 500;
  font-size: 27px; letter-spacing: .26em; color: #cfe6f6; }
#film .plane i { position: absolute; left: 30px; top: 66px; font-style: normal; font-family: 'FilmMono', monospace;
  font-size: 17px; letter-spacing: .12em; color: #7fa8c2; }
`;
  document.head.appendChild(style);

  const FEEDS = [
    ['ADS-B', 'OpenSky Network'],
    ['ADS-B', 'airplanes.live'],
    ['AIS', 'ShipXplorer'],
    ['AIS', 'MyShipTracking'],
    ['TLE', 'CelesTrak'],
    ['SEISMIC', 'USGS'],
    ['EVENTS', 'GDELT'],
  ];
  const DOMAINS = [
    ['AIR', '9,000 aircraft · ADS-B'],
    ['MARITIME', '33,000 vessels · keyless AIS'],
    ['SPACE', '16,000 objects · SGP4'],
    ['HAZARDS', 'quake · fire · storm · outage'],
    ['SIGNALS', 'GPS jamming from ADS-B integrity'],
    ['INFRASTRUCTURE', '125,000 sites · 15 layers'],
  ];

  const el = document.createElement('div');
  el.id = 'film';
  el.innerHTML = `
<div class="layer" id="f-dim" style="background:#03060a; opacity:0; z-index:5"></div>
<div class="layer grade" id="f-grade"></div>
<div class="layer vig"></div>
<div class="layer scrim" id="f-scrim" style="opacity:0"></div>
<div class="layer escrim" id="f-escrim" style="opacity:0"></div>
<div class="stage" id="f-stage-pills" style="opacity:0"><div class="pills" id="f-pills">
  ${FEEDS.map((f, i) => `<div class="pill" id="f-pill${i}"><em>${f[0]}</em>${f[1]}</div>`).join('')}
</div></div>
<div class="stage" id="f-stage-planes" style="opacity:0"><div class="planes" id="f-planes">
  ${DOMAINS.map((d, i) => `<div class="plane" id="f-plane${i}"><b>${d[0]}</b><i>${d[1]}</i></div>`).join('')}
</div></div>
<div class="ring" id="f-ring" style="opacity:0"></div>
<div class="center" id="f-title" style="top:34%; z-index:10">
  <span class="mask"><span class="wm" id="f-wm">VELOCITY</span></span>
  <div class="hair" id="f-hair" style="width:0"></div>
  <span class="mask"><span class="sub" id="f-sub">The situation console you own.</span></span>
</div>
<div class="lower" id="f-lower" style="opacity:0">
  <div class="kick" id="f-kick"></div>
  <span class="mask"><span class="head" id="f-head"></span></span>
  <div class="hrule" id="f-hr" style="width:0"></div>
</div>
<div class="stats" id="f-stats" style="opacity:0">
  <div class="st"><b id="f-n1">0</b><i>aircraft, live</i></div>
  <div class="st"><b id="f-n2">0</b><i>vessels, live</i></div>
  <div class="st"><b id="f-n3">0</b><i>orbital objects</i></div>
</div>
<div class="cmp" id="f-cmp" style="opacity:0">
  <div class="row" id="f-c0"><u>Flightradar24</u><s>7 days</s></div>
  <div class="row" id="f-c1"><u>MarineTraffic</u><s>24 hours</s></div>
  <div class="row" id="f-c2"><u>ADS-B Exchange</u><s>free API discontinued</s></div>
  <div class="row us" id="f-c3"><u>Velocity</u><s>as far as your disk allows</s></div>
</div>
<div class="center" id="f-end" style="top:33%; opacity:0">
  <span class="mask"><span class="wm" style="font-size:104px">VELOCITY</span></span>
  <div class="hair" style="width:200px"></div>
  <div class="url">projectvelocity.org</div>
  <div class="meta">AGPL-3.0 &nbsp;·&nbsp; SELF-HOSTED &nbsp;·&nbsp; NO API KEYS</div>
</div>
<div class="layer black" id="f-black"></div>
`;
  document.body.appendChild(el);
  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------- easing
  const cl = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const outExpo = (x) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x));
  const inQuad = (x) => x * x;
  const inOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const en = (t, a, d) => outExpo(cl((t - a) / d));
  const ex = (t, b, e) => 1 - inQuad(cl((t - b) / e));
  const seg = (t, a, b, din = 0.6, dout = 0.28) => Math.min(en(t, a, din), ex(t, b, dout));
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  const rise = (p) => `translateY(${((1 - p) * 112).toFixed(2)}%)`;

  // ------------------------------------------------------------- camera
  // Shots are what the camera LOOKS AT: target lon/lat, then pitch and range.
  // setView's destination is the camera position, so a tilted shot framed
  // 15 degrees of latitude north of its subject; lookAt centres the subject.
  // Earth fills the vertical frame at about 13.8 Mm with this FOV.
  const CUT = [
    // t,    lon,   lat,  range(m),   pitch, heading
    [0.0, -16, 22, 15_000_000, -90, 0],
    [2.4, -15, 22, 14_600_000, -90, 0],    // title on black
    // Five different pictures, not one picture five times: top-down, then the
    // limb, then tight on daylight traffic, then two tilted plates. The sun is
    // pinned at 17:40Z, so every one of these stays on the lit hemisphere.
    [2.4, 10, 30, 15_400_000, -90, 0],     // 1 full globe, Europe and Africa
    [5.2, 4, 32, 14_100_000, -90, 0],
    [5.2, -35, 40, 20_000_000, -36, 0],    // 2 the limb: curved horizon, counters
    [7.6, -44, 44, 18_600_000, -34, 8],
    [7.6, -75, 38, 9_500_000, -84, 0],     // 3 tight on the US seaboard in daylight
    [9.8, -80, 40, 8_700_000, -84, -4],
    [9.8, -60, 25, 15_000_000, -52, 12],   // 4 tilted plate, chips volley one
    [11.6, -54, 27, 14_200_000, -50, 8],
    [11.6, -45, 32, 13_600_000, -58, -6],  // 5 tilted the other way, volley two
    [13.6, -38, 34, 12_800_000, -56, -10],
    [13.6, 30, 14, 25_000_000, -74, 0],    // 6 constellation, wide
    [15.8, 12, 18, 23_000_000, -72, 12],
    [15.8, -20, 26, 21_000_000, -62, 30],  // 7 constellation, low tilt
    [18.2, -34, 28, 24_000_000, -60, 40],
    [18.2, 2.4, 51.4, 2_600_000, -46, 4],  // 8 console reveal
    [20.4, 2.8, 51.2, 2_250_000, -45, 2],
    [20.4, 3.6, 51.0, 1_800_000, -44, 0],  // 9 on your hardware
    [22.6, 4.0, 50.8, 1_600_000, -43, -2],
    [22.6, 4.6, 50.6, 1_300_000, -42, 0],  // 10 dense traffic push
    [24.6, 4.9, 50.4, 1_150_000, -41, -2],
    [24.6, 5.0, 50.3, 1_050_000, -40, 0],  // 11 selection + ring
    [27.0, 5.3, 50.2, 950_000, -39, -3],
    [27.0, 5.4, 50.1, 780_000, -38, -2],   // 12 the owned track
    [29.0, 5.7, 50.0, 700_000, -37, -6],
    [29.0, 5.2, 50.3, 900_000, -40, 0],    // 13 dossier detail
    [31.0, 5.4, 50.2, 840_000, -39, -3],
    [31.0, 4.6, 50.4, 1_500_000, -44, 0],  // 14 domains explode
    [33.4, 4.9, 50.4, 1_420_000, -43, -2],
    [33.4, 5.1, 50.4, 1_360_000, -43, -3], // 15 domains settle
    [35.6, 5.4, 50.4, 1_300_000, -42, -5],
    [35.6, 4.4, 50.6, 1_700_000, -45, 0],  // 16 replay, clock rewinds
    [37.8, 4.8, 50.5, 1_560_000, -44, -2],
    [37.8, 5.0, 50.4, 1_480_000, -44, -3], // 17 the comparison
    [41.5, 5.6, 50.3, 1_360_000, -43, -6],
    [41.5, 5.8, 50.2, 1_280_000, -43, -7], // 18 replay wide
    [43.5, 6.2, 50.1, 1_180_000, -42, -9],
    [43.5, 8, 40, 9_000_000, -90, 0],      // 19 pull to the globe
    [46.0, 10, 34, 13_000_000, -90, 0],
    [46.0, 12, 30, 13_600_000, -90, 0],    // 20 end card
    [52.0, 18, 26, 14_800_000, -90, 0],
  ];
  const camAt = (t) => {
    let i = 0;
    while (i < CUT.length - 2 && t >= CUT[i + 1][0]) i++;
    const a = CUT[i], b = CUT[i + 1];
    const span = b[0] - a[0];
    const p = span <= 0 ? 1 : inOut(cl((t - a[0]) / span));
    const L = (u, v) => u + (v - u) * p;
    return {
      lon: L(a[1], b[1]), lat: L(a[2], b[2]),
      range: Math.exp(L(Math.log(a[3]), Math.log(b[3]))),
      pitch: L(a[4], b[4]), heading: L(a[5], b[5]),
    };
  };

  const LOWER = [
    [7.7, 9.6, 'Live · unfiltered', 'Every public feed.'],
    [11.7, 13.4, 'The sources', 'No API keys.'],
    [15.9, 18.0, 'Space', 'Sixteen thousand objects.'],
    [20.5, 22.4, 'Self-hosted', 'On your hardware.'],
    [24.7, 26.8, 'Selection', 'Click anything.'],
    [27.1, 28.8, 'History', 'Get its whole track.'],
    [33.5, 35.4, 'The domains', 'Six layers, correlated.'],
    [35.7, 37.6, 'The archive', 'Rewind as far as your disk allows.'],
  ];

  window.__film = function (t) {
    // Between hero and chrome the viewer is relaid out and is briefly
    // zero-height. Touching the scene in that window throws DeveloperError and
    // kills the render loop for good, so the camera waits for real geometry.
    const c = camAt(t);
    if (!okSize()) return;
    V.camera.lookAt(
      C.Cartesian3.fromDegrees(c.lon, c.lat),
      new C.HeadingPitchRange(C.Math.toRadians(c.heading), C.Math.toRadians(c.pitch), c.range),
    );
    // Release the east-north-up frame lookAt installs, keeping the pose.
    V.camera.lookAtTransform(C.Matrix4.IDENTITY);
    scene.requestRender();

    $('f-black').style.opacity = (t < 2.35 ? 1 : en(t, 50.4, 1.2)).toFixed(4);

    // Title, on black
    $('f-title').style.opacity = seg(t, 0.15, 2.05, 0.30, 0.22).toFixed(4);
    $('f-wm').style.transform = rise(en(t, 0.15, 0.36));
    $('f-wm').style.letterSpacing = `${(0.42 - 0.10 * en(t, 0.15, 1.3)).toFixed(3)}em`;
    $('f-hair').style.width = `${(320 * en(t, 0.55, 0.45)).toFixed(0)}px`;
    $('f-sub').style.transform = rise(en(t, 0.85, 0.34));

    // Lower thirds
    let L = null;
    for (const l of LOWER) if (t >= l[0] - 0.1 && t <= l[1] + 0.25) L = l;
    if (L) {
      $('f-lower').style.opacity = seg(t, L[0], L[1], 0.26, 0.18).toFixed(4);
      $('f-kick').textContent = L[2];
      $('f-kick').style.opacity = en(t, L[0], 0.22).toFixed(3);
      $('f-head').innerHTML = L[3];
      $('f-head').style.transform = rise(en(t, L[0] + 0.05, 0.32));
      $('f-hr').style.width = `${(300 * en(t, L[0] + 0.14, 0.42)).toFixed(0)}px`;
    } else $('f-lower').style.opacity = '0';

    // Counters, real numbers measured at shoot time
    $('f-stats').style.opacity = seg(t, 5.3, 7.4, 0.28, 0.2).toFixed(4);
    const cu = en(t, 5.35, 1.1);
    $('f-n1').textContent = fmt(stats.aircraft * cu);
    $('f-n2').textContent = fmt(stats.vessels * cu);
    $('f-n3').textContent = fmt(stats.sats * cu);

    // ---- BEAT: the feeds arrive through depth ---------------------------
    const pillsOn = seg(t, 9.85, 13.4, 0.22, 0.22);
    $('f-stage-pills').style.opacity = pillsOn.toFixed(4);
    if (pillsOn > 0.01) {
      const exit = en(t, 13.05, 0.5);
      for (let i = 0; i < FEEDS.length; i++) {
        const p = en(t, 9.9 + i * 0.12 + (i > 2 ? 1.7 : 0), 0.34);  // two volleys, 120ms stagger
        const row = i - (FEEDS.length - 1) / 2;
        // Lands as one clean right-of-centre column so the headline keeps the
        // left third; the arrival is what moves, not the resting layout.
        const x = 250 + 210 * (1 - p);
        const z = -1700 * (1 - p) - 900 * exit;
        const pill = $('f-pill' + i);
        pill.style.transform =
          `translate3d(${x.toFixed(0)}px, ${(row * 104).toFixed(0)}px, ${z.toFixed(0)}px) rotateY(${(-38 * (1 - p)).toFixed(1)}deg) rotateX(${(34 * exit).toFixed(1)}deg)`;
        pill.style.opacity = (p * (1 - exit * 0.9)).toFixed(3);
      }
      $('f-pills').style.transform = `rotateX(${(10 * en(t, 9.85, 1.4) + 26 * exit).toFixed(1)}deg) translateZ(${(-260 * exit).toFixed(0)}px)`;
    }

    // ---- BEAT: the domains explode apart --------------------------------
    const planesOn = seg(t, 31.05, 35.3, 0.28, 0.3);
    $('f-stage-planes').style.opacity = planesOn.toFixed(4);
    if (planesOn > 0.01) {
      const spread = en(t, 31.1, 1.0) * (1 - en(t, 34.7, 0.6));
      for (let i = 0; i < DOMAINS.length; i++) {
        const k = i - (DOMAINS.length - 1) / 2;
        const p = en(t, 31.1 + i * 0.07, 0.4);
        const plane = $('f-plane' + i);
        plane.style.transform =
          `translate3d(${(k * 26 * spread).toFixed(0)}px, ${(k * 132 * spread).toFixed(0)}px, ${(k * 92 * spread).toFixed(0)}px) rotateX(58deg) rotateZ(${(-6 * spread).toFixed(1)}deg) scale(${(0.9 + 0.1 * p).toFixed(3)})`;
        plane.style.opacity = (p * 0.96).toFixed(3);
      }
      $('f-planes').style.transform = `translateY(${(30 - 60 * spread).toFixed(0)}px) rotateZ(${(2 * spread).toFixed(1)}deg)`;
    }

    // Archive comparison, staggered
    $('f-cmp').style.opacity = seg(t, 37.85, 41.3, 0.25, 0.22).toFixed(4);
    for (let i = 0; i < 4; i++) {
      const p = en(t, 37.95 + i * 0.25, 0.34);
      const r = $('f-c' + i);
      r.style.opacity = p.toFixed(3);
      r.style.transform = `translateY(${((1 - p) * 15).toFixed(2)}px)`;
    }

    // Ring on the dossier
    const ro = seg(t, 24.9, 30.8, 0.3, 0.25);
    const ring = $('f-ring');
    const box = window.__filmPanelRect;
    if (ro > 0.02 && box && box.width > 120) {
      const g = 1 - en(t, 24.9, 0.35);
      ring.style.opacity = ro.toFixed(3);
      ring.style.left = `${box.left - 9 - 14 * g}px`;
      ring.style.top = `${box.top - 9 - 14 * g}px`;
      ring.style.width = `${box.width + 18 + 28 * g}px`;
      ring.style.height = `${box.height + 18 + 28 * g}px`;
    } else ring.style.opacity = '0';

    // End card
    const endO = seg(t, 46.2, 50.1, 0.45, 0.5);
    $('f-end').style.opacity = endO.toFixed(4);
    $('f-escrim').style.opacity = (endO * 0.95).toFixed(4);
    const lowerO = parseFloat($('f-lower').style.opacity || '0');
    const cmpO = parseFloat($('f-cmp').style.opacity || '0');
    $('f-scrim').style.opacity = Math.max(lowerO, cmpO * 0.7).toFixed(4);
    // Drop the stage lights under a claim, the way a keynote does. An opacity
    // quad, not a CSS filter on the app shell: a filter forces the whole
    // 3840x2160 tree into an offscreen buffer every frame and loses the GL
    // context mid-shoot.
    const dim = Math.max(seg(t, 37.85, 41.3, 0.3, 0.3), planesOn, endO);
    $('f-dim').style.opacity = (0.62 * dim).toFixed(4);
    if (shell && shell.style.filter) shell.style.filter = '';
    $('f-grade').style.opacity = (0.82 + 0.18 * en(t, 43.5, 2.5)).toFixed(3);
  };

  window.__film(0);
  return true;
};
