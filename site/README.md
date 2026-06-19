# projectvelocity.org — landing site

Self-contained marketing/landing site for Velocity. No build step: plain HTML +
CSS + a Three.js/GSAP scroll story. Dependencies are vendored under `vendor/`,
so it runs offline and there's no runtime CDN.

## Run locally

```bash
python3 -m http.server 5599 --directory site
# open http://localhost:5599
```

(Any static server works — `npx serve site`, etc. Open via http, not `file://`,
so the ES-module import map resolves.)

## Deploy to projectvelocity.org

It's static — point any static host at this folder:

- **Cloudflare Pages / Netlify / Vercel:** project root = `site/`, build command =
  *(none)*, output dir = `site/` (or `.`). Add the custom domain `projectvelocity.org`.
- **GitHub Pages:** publish the `site/` subfolder.

## Wire the live snapshot (optional)

The "Live snapshot" section shows a baked demo by default, because the public API
may not allow cross-origin embedding. To pull real numbers, set the backend base
before `main.js` loads and make sure the backend sends permissive CORS for
`/api/intel/situation`:

```html
<script>window.VELOCITY_API = "https://api.your-host.example";</script>
```

It fetches with a 4s timeout and silently falls back to the demo snapshot on any
error — so a missing or locked-down API never breaks the page.

## Customize

- **Copy / sections:** `index.html`
- **Theme (colors, fonts, layout):** `styles.css` (CSS variables at the top)
- **3D globe + scroll story + counters + terminal:** `main.js`
- **Screenshots:** `assets/` (globe / europe / entity-panel / tour.gif)

## Licensing note (baked into the page)

The page is explicit about it: Velocity's **code is Apache-2.0** (fork, rebrand,
host, resell). Upstream **data feeds carry their own terms** — several are
non-commercial (ACLED, adsb.fi, OpenSky). The paid tiers are therefore **BYOK**:
commercial builds ship without the non-commercial feeds, and each operator brings
keys for data they're licensed to use. See the repo `NOTICE` for per-source terms.
