// Spark splat viewer — THREE.js, renders FULL spherical harmonics (no DC-only
// compromise), WebGL2/WebGPU. Builds a minimal THREE scene; rebuilt per URL.
// Extracted out of StudioPage.tsx (Reconstruction Studio) so the City 3D app
// (docs/dashboard-workflows-plan.md §4) can reuse the exact same viewer for
// non-recon scene sources (local files, pasted URLs) without duplicating the
// THREE/Spark wiring. Behavior is unchanged from the inline version; the only
// additions are optional `className` and `onStats` props (both additive).
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export interface CamPose {
  position: number[];
  target: number[];
  up: number[];
}

export interface SplatStats {
  numSplats: number | null;
}

export function SplatView({
  url,
  cam,
  className = 'absolute inset-0',
  onStats,
}: {
  url: string;
  cam: CamPose | null;
  // Additive: lets callers (e.g. CityApp) size/position the host differently
  // than Studio's absolute-fill panel. Defaults to the original behavior.
  className?: string;
  // Additive: best-effort splat-count readout once the mesh finishes loading.
  // Omitted entirely (never fabricated) if Spark doesn't expose a count.
  onStats?: (stats: SplatStats) => void;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let raf = 0;
    let disposed = false;
    const w = host.clientWidth || 960;
    const h = host.clientHeight || 720;

    const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h);
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, w / h, 0.01, 1000);
    camera.position.set(0, 0, 5);
    const controls = new OrbitControls(camera, renderer.domElement);

    const spark = new SparkRenderer({ renderer });
    scene.add(spark);

    // Spark detects the file type from the URL extension; renders full SH.
    const mesh = new SplatMesh({
      url,
      onLoad: () => {
        if (disposed) return;
        // Frame on a real training viewpoint (camera.json) — guessing put the
        // camera inside the cloud ("spilled paint"). cam is in the splat's
        // median-centered space, matching the served .ply.
        if (cam) {
          camera.up.set(cam.up[0]!, cam.up[1]!, cam.up[2]!);
          camera.position.set(cam.position[0]!, cam.position[1]!, cam.position[2]!);
          controls.target.set(cam.target[0]!, cam.target[1]!, cam.target[2]!);
        }
        controls.update();
        if (import.meta.env.DEV) {
          (window as unknown as { __sv?: unknown }).__sv = { renderer, scene, camera, mesh, spark };
        }
        if (onStats) {
          // Best-effort: only read a count if Spark actually exposes one on
          // this build — never fabricate a number.
          const n = (mesh as unknown as { numSplats?: number; packedSplats?: { numSplats?: number } });
          const count = typeof n.numSplats === 'number'
            ? n.numSplats
            : typeof n.packedSplats?.numSplats === 'number'
              ? n.packedSplats.numSplats
              : null;
          onStats({ numSplats: count });
        }
      },
    });
    scene.add(mesh);

    const onResize = (): void => {
      const ww = host.clientWidth;
      const hh = host.clientHeight;
      if (!ww || !hh) return;
      camera.aspect = ww / hh;
      camera.updateProjectionMatrix();
      renderer.setSize(ww, hh);
    };
    window.addEventListener('resize', onResize);

    const loop = (): void => {
      raf = requestAnimationFrame(loop);
      controls.update();
      renderer.render(scene, camera);
    };
    loop();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      controls.dispose();
      try {
        (mesh as unknown as { dispose?: () => void }).dispose?.();
      } catch {
        /* already gone */
      }
      // SparkRenderer holds its own GPU resources; drop them before the
      // WebGLRenderer so nothing dangles on the context we're about to lose.
      try {
        (spark as unknown as { dispose?: () => void }).dispose?.();
      } catch {
        /* already gone */
      }
      renderer.dispose();
      // dispose() frees three.js caches but NOT the underlying GL context;
      // browsers cap live contexts (~16) and blank the oldest. City 3D swaps
      // scenes rapidly (one context per url), so force the context release.
      try {
        renderer.forceContextLoss();
      } catch {
        /* not available on this renderer build */
      }
      host.replaceChildren();
    };
    // onStats is a best-effort readout, not a reactive dependency; re-running
    // the effect for a new callback identity would rebuild the whole scene.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, cam]);

  return <div ref={hostRef} className={className} />;
}
