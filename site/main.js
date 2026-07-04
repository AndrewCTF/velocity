/* ============================================================================
   Velocity landing — cinematic engine
   - Globe: dotted Earth sampled from a real land mask (continents everywhere)
            + great-circle intel arcs with travelling pulses, scroll-scrubbed
   - City:  interactive LOD1 war-damage reconstruction — extruded blocks, a
            Sentinel-1 "scan" sweep that flags collapse candidates red
   - Counters, reveals, agent terminal, live-with-fallback, HUD
   Degrades: no WebGL → static; reduced-motion → no animation.
   ============================================================================ */
import * as THREE from "three";

const gsap = window.gsap;
const ScrollTrigger = window.ScrollTrigger;
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
if (gsap && ScrollTrigger) gsap.registerPlugin(ScrollTrigger);

const API = (window.VELOCITY_API || "").replace(/\/$/, "");
const DEMO = { aircraft: 13041, military: 139, vessels: 4668, jamming: 200, incidents: 25, cables: 714 };

function discTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const x = c.getContext("2d");
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.25, "rgba(170,255,240,0.85)");
  g.addColorStop(1, "rgba(45,212,191,0)");
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
const DISC = (() => { try { return discTexture(); } catch { return null; } })();

const ll = (latDeg, lonDeg, r) => {
  const lat = (latDeg * Math.PI) / 180, lon = (lonDeg * Math.PI) / 180;
  return new THREE.Vector3(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)).multiplyScalar(r);
};

/* ============================================================================
   GLOBE — dotted continents from assets/earth.jpg
   ============================================================================ */
const gcanvas = document.getElementById("bg");
let gRenderer, gScene, gCam, world, arcs = [], gRunning = true;
const gState = { z: 7, tilt: -0.12, spin: 0, glow: 0.32 };

function greatCircle(a, b, R, segs = 64) {
  const va = a.clone().normalize(), vb = b.clone().normalize();
  const omega = Math.acos(THREE.MathUtils.clamp(va.dot(vb), -1, 1));
  const so = Math.sin(omega) || 1e-5;
  const pts = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const v = va.clone().multiplyScalar(Math.sin((1 - t) * omega) / so).add(vb.clone().multiplyScalar(Math.sin(t * omega) / so));
    v.normalize().multiplyScalar(R * (1 + 0.26 * Math.sin(Math.PI * t)));
    pts.push(v);
  }
  return pts;
}

function initGlobe() {
  if (!gcanvas) return false;
  try { gRenderer = new THREE.WebGLRenderer({ canvas: gcanvas, antialias: true, alpha: true, powerPreference: "high-performance" }); }
  catch { gcanvas.style.display = "none"; return false; }
  gRenderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  gRenderer.setSize(innerWidth, innerHeight);
  gScene = new THREE.Scene();
  gCam = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 100);
  gCam.position.set(0, 0, gState.z);
  world = new THREE.Group(); world.rotation.x = gState.tilt; gScene.add(world);
  window.__world = world; // exposed for verification (rotate + re-render)
  window.__grender = () => gRenderer && gRenderer.render(gScene, gCam);
  const R = 2.1;

  // faint wire shell
  world.add(new THREE.LineSegments(
    new THREE.WireframeGeometry(new THREE.SphereGeometry(R * 0.99, 40, 24)),
    new THREE.LineBasicMaterial({ color: 0x2dd4bf, transparent: true, opacity: 0.04 })
  ));

  // Globe = two dot layers:
  //  (a) a uniform faint sphere so EVERY part of the globe has even dots (no
  //      empty oceans, no one-sided bunching), and
  //  (b) brighter continent dots from a land mask on top, so it reads as Earth.
  {
    const N = 3600, pos = [], col = [];
    const ga = Math.PI * (3 - Math.sqrt(5));
    const ocean = new THREE.Color(0x12525b);
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;
      const rad = Math.sqrt(1 - y * y);
      const th = ga * i;
      const v = new THREE.Vector3(Math.cos(th) * rad, y, Math.sin(th) * rad).multiplyScalar(R);
      pos.push(v.x, v.y, v.z);
      col.push(ocean.r, ocean.g, ocean.b);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    world.add(new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.022, map: DISC, vertexColors: true, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    })));
  }
  const img = new Image();
  img.onload = () => {
    const W = 720, H = 360;
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const cx = cv.getContext("2d"); cx.drawImage(img, 0, 0, W, H);
    const data = cx.getImageData(0, 0, W, H).data;
    const pos = [], col = [];
    const base = new THREE.Color(0x2dd4bf), hot = new THREE.Color(0x7afff0);
    const step = 0.9;
    for (let lat = -84; lat <= 84; lat += step) {
      const circ = Math.max(6, Math.round((360 / step) * Math.cos((lat * Math.PI) / 180)));
      for (let k = 0; k < circ; k++) {
        const lon = -180 + (360 * k) / circ;
        const px = Math.min(W - 1, Math.max(0, Math.floor(((lon + 180) / 360) * W)));
        const py = Math.min(H - 1, Math.max(0, Math.floor(((90 - lat) / 180) * H)));
        const o = (py * W + px) * 4;
        const b = (data[o] + data[o + 1] + data[o + 2]) / 3;
        if (b < 18) continue; // ocean → leave to the faint base layer
        const v = ll(lat + (Math.random() - 0.5) * step, lon + (Math.random() - 0.5) * step, R * 1.004);
        pos.push(v.x, v.y, v.z);
        const c = base.clone().lerp(hot, Math.random() * 0.5);
        col.push(c.r, c.g, c.b);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    world.add(new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.036, map: DISC, vertexColors: true, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    })));
  };
  img.src = "assets/earth.jpg";

  // Link nodes on a FIBONACCI SPHERE — mathematically even over the whole globe,
  // so beacons + arcs never bunch on the populated hemisphere.
  const NODEN = 40, nodeVerts = [];
  const gaN = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < NODEN; i++) {
    const y = 1 - (i / (NODEN - 1)) * 2;
    const rad = Math.sqrt(1 - y * y);
    const th = gaN * i;
    nodeVerts.push(new THREE.Vector3(Math.cos(th) * rad, y, Math.sin(th) * rad).multiplyScalar(R));
  }
  const arcMat = new THREE.LineBasicMaterial({ color: 0x2dd4bf, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending });
  const strides = [9, 14, 19, 23];
  for (let i = 0; i < NODEN; i += 2) { // ~20 arcs, evenly seeded around the sphere
    const a = nodeVerts[i], b = nodeVerts[(i + strides[(i / 2) % strides.length]) % NODEN];
    if (a.distanceTo(b) < 0.9) continue;
    const pts = greatCircle(a, b, R);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), arcMat.clone());
    world.add(line);
    const comet = new THREE.Sprite(new THREE.SpriteMaterial({ map: DISC, color: 0x9ffff0, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    comet.scale.setScalar(0.13); world.add(comet);
    arcs.push({ pts, comet, line, off: Math.random() });
  }
  // beacons at every node (evenly spread)
  const np = []; nodeVerts.forEach((v) => np.push(v.x, v.y, v.z));
  const ng = new THREE.BufferGeometry(); ng.setAttribute("position", new THREE.Float32BufferAttribute(np, 3));
  world.add(new THREE.Points(ng, new THREE.PointsMaterial({ size: 0.11, map: DISC, color: 0x9ffff0, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })));

  // stars
  const sp = []; for (let i = 0; i < 800; i++) { const v = new THREE.Vector3().randomDirection().multiplyScalar(15 + Math.random() * 24); sp.push(v.x, v.y, v.z); }
  const sg = new THREE.BufferGeometry(); sg.setAttribute("position", new THREE.Float32BufferAttribute(sp, 3));
  gScene.add(new THREE.Points(sg, new THREE.PointsMaterial({ size: 0.06, map: DISC, color: 0x6f8a99, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false })));

  addEventListener("resize", () => { if (!gRenderer) return; gCam.aspect = innerWidth / innerHeight; gCam.updateProjectionMatrix(); gRenderer.setSize(innerWidth, innerHeight); }, { passive: true });
  return true;
}

let gPhase = 0, gSpin = 0;
function globeTick() {
  if (!gRenderer) return;
  requestAnimationFrame(globeTick);
  if (!gRunning) return;
  gSpin += 0.0009;
  gCam.position.z += (gState.z - gCam.position.z) * 0.06;
  world.rotation.y = gSpin + gState.spin;
  world.rotation.x += (gState.tilt - world.rotation.x) * 0.06;
  gPhase += 0.0038;
  for (const a of arcs) {
    const p = (gPhase + a.off) % 1;
    a.comet.position.copy(a.pts[Math.min(a.pts.length - 1, Math.floor(p * a.pts.length))]);
    a.comet.material.opacity = Math.sin(p * Math.PI) * (0.5 + gState.glow);
    a.line.material.opacity = 0.1 + gState.glow * 0.4;
  }
  gRenderer.render(gScene, gCam);
}

/* ============================================================================
   CITY — interactive LOD1 war-damage reconstruction (illustrative)
   ============================================================================ */
const ccanvas = document.getElementById("city");
let cRenderer, cScene, cCam, cityGroup, scanMesh, cRunning = false, revealed = false;
let damaged = [];

function initCity() {
  if (!ccanvas) return false;
  try { cRenderer = new THREE.WebGLRenderer({ canvas: ccanvas, antialias: true, alpha: true }); }
  catch { return false; }
  const w = ccanvas.clientWidth || 800, h = ccanvas.clientHeight || 520;
  cRenderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  cRenderer.setSize(w, h, false);
  cScene = new THREE.Scene();
  cScene.fog = new THREE.FogExp2(0x05070b, 0.018);
  cCam = new THREE.PerspectiveCamera(48, w / h, 0.1, 400);
  cCam.position.set(0, 34, 60);
  cCam.lookAt(0, 9, 0);

  cScene.add(new THREE.AmbientLight(0x44637a, 1.35));
  const key = new THREE.DirectionalLight(0xcaf4ec, 1.7); key.position.set(28, 60, 24); cScene.add(key);
  const rim = new THREE.DirectionalLight(0x2dd4bf, 0.8); rim.position.set(-44, 24, -30); cScene.add(rim);

  // ground + grid
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(220, 220), new THREE.MeshStandardMaterial({ color: 0x0a1018, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.1; cScene.add(ground);
  const grid = new THREE.GridHelper(220, 44, 0x16323a, 0x0e1c22); grid.position.y = 0; cScene.add(grid);

  cityGroup = new THREE.Group(); cScene.add(cityGroup);

  // deterministic pseudo-random so the layout is stable across loads
  let seed = 1337; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

  const intactMat = new THREE.MeshStandardMaterial({ color: 0x1c5560, roughness: 0.8, metalness: 0.05, emissive: 0x0e4a54, emissiveIntensity: 0.55 });
  const damageMat = new THREE.MeshStandardMaterial({ color: 0x4a1014, roughness: 1, emissive: 0xff2d22, emissiveIntensity: 0.0 });
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x5fe9d8, transparent: true, opacity: 0.34 });
  const redEdgeMat = new THREE.LineBasicMaterial({ color: 0xff5b52, transparent: true, opacity: 0.65 });

  const span = 88, blocksW = 9, cell = span / blocksW, road = cell * 0.34;
  const strike = new THREE.Vector2(2, 4); // near centre so the damage zone is always in frame

  for (let gx = 0; gx < blocksW; gx++) {
    for (let gz = 0; gz < blocksW; gz++) {
      // 2-3 buildings per block
      const per = 1 + Math.floor(rnd() * 3);
      for (let b = 0; b < per; b++) {
        const bx = -span / 2 + gx * cell + road + rnd() * (cell - road) * 0.7;
        const bz = -span / 2 + gz * cell + road + rnd() * (cell - road) * 0.7;
        const fw = (cell - road) * (0.32 + rnd() * 0.4);
        const fd = (cell - road) * (0.32 + rnd() * 0.4);
        const d = Math.hypot(bx - strike.x, bz - strike.y);
        const isDmg = d < 21 && rnd() < 1 - d / 27;
        let storeys = 3 + Math.floor(rnd() * 9);
        if (rnd() < 0.07) storeys += 9; // occasional tower
        const hFull = storeys * 1.8;
        const h = isDmg ? hFull * (0.5 + rnd() * 0.32) : hFull; // damaged = partial collapse (visible red shell)
        const geo = new THREE.BoxGeometry(fw, h, fd);
        const m = new THREE.Mesh(geo, isDmg ? damageMat.clone() : intactMat);
        m.position.set(bx, h / 2, bz);
        m.userData.full = h; m.scale.y = 0.0001; // for reveal
        cityGroup.add(m);
        m.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), isDmg ? redEdgeMat : edgeMat));
        if (isDmg) {
          damaged.push(m);
          // rubble flecks
          for (let r = 0; r < 3; r++) {
            const rb = new THREE.Mesh(new THREE.BoxGeometry(0.6 + rnd(), 0.5 + rnd(), 0.6 + rnd()), damageMat.clone());
            rb.position.set(bx + (rnd() - 0.5) * fw * 1.6, 0.4, bz + (rnd() - 0.5) * fd * 1.6);
            cityGroup.add(rb);
          }
        }
      }
    }
  }

  // damage-zone ground ring (where the SAR backscatter-drop clusters)
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(13, 16.5, 56),
    new THREE.MeshBasicMaterial({ color: 0xff3b30, transparent: true, opacity: 0.22, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  ring.rotation.x = -Math.PI / 2; ring.position.set(strike.x, 0.06, strike.y); cityGroup.add(ring);

  // SAR scan plane (sweeps; flags damage as it passes)
  scanMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(span + 24, 40),
    new THREE.MeshBasicMaterial({ color: 0x5ef0db, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false })
  );
  scanMesh.position.set(0, 18, -span / 2 - 12); // vertical radar curtain, swept along z
  cScene.add(scanMesh);

  // hover-orbit
  ccanvas.addEventListener("pointermove", (e) => {
    const r = ccanvas.getBoundingClientRect();
    cityTargetAz = ((e.clientX - r.left) / r.width - 0.5) * 1.3;
  });
  return true;
}

let cityAz = 0, cityTargetAz = 0, scanX = 0, scanRun = false;
function cityTick() {
  if (!cRenderer) return;
  requestAnimationFrame(cityTick);
  const w = ccanvas.clientWidth, h = ccanvas.clientHeight;
  if (ccanvas.width !== Math.floor(w * Math.min(devicePixelRatio, 2))) cRenderer.setSize(w, h, false);
  cityAz += (cityTargetAz - cityAz) * 0.05;
  const baseAz = reduced ? 0.55 : 0.55 + performance.now() * 0.00004;
  const az = baseAz + cityAz, rad = 58;
  cCam.position.set(Math.sin(az) * rad, 32, Math.cos(az) * rad);
  cCam.lookAt(0, 9, 0);

  if (scanRun && !reduced) {
    scanX += 0.8;
    scanMesh.position.z = -46 + scanX;
    scanMesh.material.opacity = 0.16 + 0.05 * Math.sin(performance.now() * 0.01);
    for (const m of damaged) {
      if (scanMesh.position.z >= m.position.z && m.material.emissiveIntensity < 0.95) {
        m.material.emissiveIntensity = Math.min(0.98, m.material.emissiveIntensity + 0.1);
      }
    }
    if (scanX > 100) { scanX = 0; scanRun = false; setTimeout(() => { scanRun = true; }, 2200); }
  }
  cRenderer.render(cScene, cCam);
}

function revealCity() {
  if (revealed) return; revealed = true; cRunning = true;
  requestAnimationFrame(cityTick);
  damaged.forEach((m) => (m.material.emissiveIntensity = 0.72)); // visibly red from the start; scan intensifies
  if (reduced) { cityGroup.children.forEach((m) => { if (m.scale) m.scale.y = 1; }); damaged.forEach((m) => (m.material.emissiveIntensity = 0.95)); return; }
  // staggered rise
  const meshes = cityGroup.children.filter((m) => m.userData.full);
  meshes.forEach((m, i) => {
    if (gsap) gsap.to(m.scale, { y: 1, duration: 0.9, delay: 0.2 + i * 0.004, ease: "power2.out" });
    else m.scale.y = 1;
  });
  setTimeout(() => { scanRun = true; }, 1400);
}

/* ============================================================================
   GLOBE SCROLL STORY
   ============================================================================ */
function initStory() {
  if (!gsap || !ScrollTrigger || reduced || !gRenderer) return;
  gsap.timeline({ scrollTrigger: { trigger: ".hero", start: "top top", endTrigger: '[data-chapter="fusion"]', end: "bottom center", scrub: 1 } })
    .to(gState, { z: 5.7, tilt: 0.06, spin: 0.9, glow: 0.7 })
    .to(gState, { z: 4.3, tilt: 0.26, spin: 1.7, glow: 1.0 });
  gsap.to(gcanvas, {
    opacity: 0,
    scrollTrigger: { trigger: ".damage", start: "top 90%", end: "top 45%", scrub: true, onUpdate: (s) => { gRunning = s.progress < 0.98; }, onLeaveBack: () => { gRunning = true; } },
  });
}

/* ============================================================================
   OBSERVERS — reveals, counters, terminal, city
   ============================================================================ */
function animateCount(el) {
  const target = +el.dataset.count, suffix = el.dataset.suffix || "";
  if (reduced) { el.textContent = target.toLocaleString() + suffix; return; }
  const dur = 1500, t0 = performance.now();
  (function step(now) { const k = Math.min(1, (now - t0) / dur); el.textContent = Math.round(target * (1 - Math.pow(1 - k, 3))).toLocaleString() + suffix; if (k < 1) requestAnimationFrame(step); })(t0);
}
function initObservers() {
  document.querySelectorAll(".reveal, .section-head, .chapter-card, .shot, .tier, .terminal, .live-grid, .license-card, .hero-stats, .cap").forEach((el) => el.classList.add("reveal"));
  const rIO = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); rIO.unobserve(e.target); } }), { threshold: 0.16 });
  document.querySelectorAll(".reveal").forEach((el) => rIO.observe(el));
  const cIO = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { animateCount(e.target); cIO.unobserve(e.target); } }), { threshold: 0.5 });
  document.querySelectorAll("[data-count]").forEach((el) => cIO.observe(el));
  const term = document.getElementById("term-code");
  if (term) { const tIO = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { typeTerminal(term); tIO.disconnect(); } }), { threshold: 0.4 }); tIO.observe(document.getElementById("terminal")); }
  if (ccanvas) { const dIO = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { revealCity(); dIO.disconnect(); } }), { threshold: 0.3 }); dIO.observe(document.querySelector(".damage")); }
}

/* ---- agent terminal -------------------------------------------------------*/
const TERM = [
  { t: "$ ", c: "pr" }, { t: "velocity ask ", c: "k" }, { t: '"assess damage in beirut-dahieh"\n', c: "s" },
  { t: "→ focus_area + lod1(aoi=beirut-dahieh)\n\n", c: "c" },
  { t: "{\n", c: "" },
  { t: '  "method"', c: "k" }, { t: ": ", c: "" }, { t: '"Sentinel-1 VV log-ratio, pre/post"', c: "s" }, { t: ",\n", c: "" },
  { t: '  "window"', c: "k" }, { t: ": ", c: "" }, { t: '"2024-08-20 → 2024-11-25"', c: "s" }, { t: ",\n", c: "" },
  { t: '  "buildings"', c: "k" }, { t: ": ", c: "" }, { t: "1,914", c: "s" }, { t: ", ", c: "" },
  { t: '"collapse_candidates"', c: "k" }, { t: ": ", c: "" }, { t: "212", c: "s" }, { t: ",\n", c: "" },
  { t: '  "confidence"', c: "k" }, { t: ": ", c: "" }, { t: '"CHANGE, not damage — validate vs UNOSAT"', c: "s" }, { t: "\n}\n\n", c: "" },
  { t: "✓ 212 collapse candidates · extruded to LOD1 · flagged red", c: "c" },
];
function typeTerminal(el) {
  if (reduced) { TERM.forEach((s) => { const sp = document.createElement("span"); sp.className = s.c; sp.textContent = s.t; el.appendChild(sp); }); return; }
  el.classList.add("cursor"); let si = 0, ci = 0, cur = null;
  (function step() {
    if (si >= TERM.length) { el.classList.remove("cursor"); return; }
    const seg = TERM[si];
    if (ci === 0) { cur = document.createElement("span"); cur.className = seg.c; el.appendChild(cur); }
    cur.textContent += seg.t[ci++];
    if (ci >= seg.t.length) { si++; ci = 0; }
    setTimeout(step, seg.t[ci - 1] === "\n" ? 120 : 11 + Math.random() * 20);
  })();
}

/* ---- live snapshot --------------------------------------------------------*/
async function initLive() {
  const note = document.getElementById("live-note");
  try {
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(`${API}/api/intel/situation`, { signal: ctrl.signal }); clearTimeout(to);
    if (!r.ok) throw 0; const d = await r.json();
    const map = { aircraft: d?.aircraft?.total, military: d?.aircraft?.military, vessels: d?.vessels?.total, jamming: d?.gps_jamming?.flagged_cells, incidents: d?.fusion_alerts?.length, cables: DEMO.cables };
    document.querySelectorAll("#live-grid [data-count]").forEach((el, i) => { const k = ["aircraft", "military", "vessels", "jamming", "incidents", "cables"][i]; if (Number.isFinite(map[k])) el.dataset.count = map[k]; });
    if (note) note.textContent = "Live — sampled from a running backend just now.";
  } catch { if (note) note.textContent = "Backend not reachable from here — showing a demo snapshot."; }
}

/* ---- HUD ------------------------------------------------------------------*/
function initHud() {
  const clock = document.getElementById("hud-clock"), coord = document.getElementById("hud-coord");
  if (!clock) return; const pad = (n) => String(n).padStart(2, "0");
  setInterval(() => {
    const d = new Date();
    clock.textContent = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
    if (coord && !reduced) coord.textContent = `LAT ${(Math.sin(d.getTime() / 7000) * 60).toFixed(1)} · LON ${(Math.cos(d.getTime() / 5200) * 140).toFixed(1)}`;
  }, 1000);
}

/* ---- boot -----------------------------------------------------------------*/
const gOk = initGlobe();
if (gOk && !reduced) requestAnimationFrame(globeTick); else if (gOk) globeTick();
initCity();
initStory(); initObservers(); initLive(); initHud();
