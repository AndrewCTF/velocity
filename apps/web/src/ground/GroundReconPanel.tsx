// GroundReconPanel — right-rail tab. Given an AOI (set by right-click "Ground
// recon here"), it enriches the area with: ground-level photos (Panoramax +
// KartaView), a weather read-out, a satellite area chip, and — in the desktop
// app only — real CUDA detection drawn as boxes over the photos. A traffic-sim
// section (cam → detect → animated vehicles on the globe) is wired in P2.

import { useEffect, useState } from 'react';
import type * as Cesium from 'cesium';
import { Widget, SectionLabel, MicroLabel, Caveat, Btn } from '../shell/instruments.js';
import { CoordEntry } from '../globe/CoordEntry.js';
import { apiFetch } from '../transport/http.js';
import { isDesktop } from '../transport/desktop.js';
import { useGround } from './groundStore.js';
import { PanoramaViewer } from './PanoramaViewer.js';
import { WeatherCard } from '../weather/WeatherCard.js';
import { TrafficSimSection } from '../sim/TrafficSimSection.js';
import type { GroundPhotoFeature } from './types.js';

function recentIso(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function AreaChip({ lat, lon, radiusKm }: { lat: number; lon: number; radiusKm: number }): JSX.Element {
  const [err, setErr] = useState(false);
  // Keyless /api/imagery/chip returns image bytes; same-origin so an <img> can
  // load it directly (same reason ChipLayer uses no apiFetch). `date` is required
  // by the route — pass a recent one (Sentinel revisit ~5 d) so we get real
  // pixels instead of today's empty pass.
  const src = `/api/imagery/chip?lat=${lat}&lon=${lon}&radius_km=${radiusKm}&date=${recentIso(14)}&source=auto`;
  return (
    <Widget title="Area imagery" count={`${radiusKm.toFixed(1)} km`}>
      {err ? (
        <div className="flex aspect-video w-full items-center justify-center rounded-sm border border-line bg-bg-2 text-[10px] text-txt-3">
          no imagery for this area
        </div>
      ) : (
        <img
          src={src}
          alt="AOI satellite chip"
          className="w-full rounded-sm border border-line"
          onError={() => setErr(true)}
        />
      )}
      <MicroLabel>Sentinel/Maxar · not live</MicroLabel>
    </Widget>
  );
}

export function GroundReconPanel({ viewer }: { viewer: unknown }): JSX.Element {
  const aoi = useGround((s) => s.aoi);
  const fetchSeq = useGround((s) => s.fetchSeq);
  const photos = useGround((s) => s.photos);
  const loading = useGround((s) => s.loading);
  const error = useGround((s) => s.error);
  const note = useGround((s) => s.note);
  const selectedId = useGround((s) => s.selectedId);
  const refresh = useGround((s) => s.refresh);
  const setPhotos = useGround((s) => s.setPhotos);
  const setError = useGround((s) => s.setError);
  const setLoading = useGround((s) => s.setLoading);
  const select = useGround((s) => s.select);
  // viewer is consumed by the P2 traffic-sim controller; keep the prop so the
  // mount site (App rightTabs) mirrors EntityPanel's signature.
  void viewer;

  // Fetch nearby ground photos whenever the AOI changes or refresh() is pressed.
  useEffect(() => {
    if (!aoi) return;
    let cancelled = false;
    setLoading(true);
    apiFetch(`/api/ground/nearby?lat=${aoi.lat}&lon=${aoi.lon}&radius_km=${aoi.radiusKm}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`ground ${r.status}`))))
      .then((fc: { features?: Array<Record<string, unknown>>; note?: string }) => {
        if (cancelled) return;
        const feats: GroundPhotoFeature[] = (fc.features ?? []).map((f) => {
          const p = (f.properties ?? {}) as Record<string, unknown>;
          const coords = (f.geometry as { coordinates?: [number, number, number] } | undefined)?.coordinates ?? [0, 0];
          return {
            source: String(p.source ?? ''),
            photo_id: String(p.photo_id ?? ''),
            name: String(p.name ?? ''),
            lat: coords[1],
            lon: coords[0],
            heading: (p.heading as number | null) ?? null,
            captured_at: (p.captured_at as string | null) ?? null,
            thumb_url: String(p.thumb_url ?? ''),
            photo_url: String(p.photo_url ?? ''),
          };
        });
        setPhotos(feats, fc.note ?? null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'ground failed');
      });
    return () => {
      cancelled = true;
    };
  }, [aoi, fetchSeq, setPhotos, setError, setLoading]);

  if (!aoi) {
    return (
      <Widget title="Ground Recon">
        <Caveat level="NO AOI" tone="warn" />
        <p className="text-[10px] text-txt-3 mt-2 leading-snug">
          Right-click the map → <span className="text-txt-1">Ground recon here</span> to load
          street-level photos, weather, area imagery, and (in the desktop app) live detection boxes.
        </p>
        <div className="mt-2 space-y-1">
          <MicroLabel>or recon at coordinates</MicroLabel>
          <CoordEntry
            viewer={viewer as Cesium.Viewer | null}
            onPlace={(lat, lon) => useGround.getState().openAt({ lat, lon, radiusKm: 2 })}
          />
        </div>
      </Widget>
    );
  }

  return (
    <div className="space-y-2">
      <Widget title="Ground Recon" count={`${aoi.lat.toFixed(3)}, ${aoi.lon.toFixed(3)}`}>
        <div className="flex items-center justify-between">
          <MicroLabel>{isDesktop() ? 'desktop · CUDA detect ready' : 'website · detect off'}</MicroLabel>
          <Btn size="sm" onClick={refresh} title="Re-fetch photos">
            refresh
          </Btn>
        </div>
        {loading && <MicroLabel>loading photos…</MicroLabel>}
        {error && <span className="mono text-[10px] text-alert">{error}</span>}
        <div className="mt-2 space-y-1">
          <MicroLabel>or recon at coordinates</MicroLabel>
          <CoordEntry
            viewer={viewer as Cesium.Viewer | null}
            onPlace={(lat, lon) => useGround.getState().openAt({ lat, lon, radiusKm: 2 })}
          />
        </div>
      </Widget>

      <WeatherCard lat={aoi.lat} lon={aoi.lon} />
      <AreaChip lat={aoi.lat} lon={aoi.lon} radiusKm={aoi.radiusKm} />
      <SplatSection />

      <Widget title="Ground photos" count={`${photos.length}`}>
        {photos.length === 0 && !loading ? (
          <MicroLabel>{note ?? 'no ground photos in this area'}</MicroLabel>
        ) : (
          <div className="grid grid-cols-3 gap-1">
            {photos.map((p) => {
              const key = `${p.source}:${p.photo_id}`;
              return (
                <button
                  key={key}
                  type="button"
                  title={`${p.source} ${p.name}`}
                  onClick={() => select(selectedId === key ? null : key)}
                  className={`aspect-square overflow-hidden rounded-sm border bg-bg-2 ${
                    selectedId === key ? 'border-accent-line' : 'border-line'
                  }`}
                >
                  <img
                    src={p.thumb_url}
                    alt={p.name}
                    className="w-full h-full object-cover"
                    draggable={false}
                    loading="lazy"
                    // Broken thumb → hide the broken-image glyph, leave the muted tile.
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).style.display = 'none';
                    }}
                  />
                </button>
              );
            })}
          </div>
        )}
        {note && photos.length > 0 && <MicroLabel>{note}</MicroLabel>}
      </Widget>

      <SectionLabel title="Selected view" />
      <PanoramaViewer />

      <SectionLabel title="Traffic sim" />
      <TrafficSimSection
        viewer={viewer as Cesium.Viewer | null}
        center={aoi ? { lat: aoi.lat, lon: aoi.lon } : null}
      />
    </div>
  );
}

// ── 3D Gaussian Splat of the AOI from its ground photos ──────────────────────
// POSTs the AOI's full-res ground photos to the existing /api/recon/jobs
// pipeline (Pi3X SfM → gsplat), polls the job, and links into /studio for the
// rendered splat (StudioPage already owns the THREE.js viewer). Note: street
// panos are a best-effort SfM input; splat quality varies — flagged honestly.
function SplatSection(): JSX.Element {
  const photos = useGround((s) => s.photos);
  const [jobId, setJobId] = useState<string | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const r = await apiFetch(`/api/recon/jobs/${encodeURIComponent(jobId)}`);
        if (!r.ok) return;
        const j = (await r.json()) as { status?: string; stage?: string };
        if (cancelled) return;
        setStage(j.status ?? j.stage ?? 'working');
        if (j.status === 'done') {
          setStage('done');
          return;
        }
        if (j.status !== 'failed') window.setTimeout(() => void poll(), 2000);
      } catch {
        /* keep polling */
      }
    };
    void poll();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  const onBuild = async (): Promise<void> => {
    if (photos.length < 3) {
      setErr('need ≥3 ground photos for a reconstruction');
      return;
    }
    setErr(null);
    setStage('uploading');
    try {
      const fd = new FormData();
      // Take up to 12 photos; fetch each full-res image and append as a file.
      const slice = photos.slice(0, 12);
      await Promise.all(
        slice.map(async (p, i) => {
          const r = await apiFetch(p.photo_url);
          if (!r.ok) throw new Error(`photo ${r.status}`);
          const blob = await r.blob();
          fd.append('files', blob, `ground-${i}.jpg`);
        }),
      );
      const r = await apiFetch('/api/recon/jobs', { method: 'POST', body: fd });
      if (!r.ok) throw new Error(`recon ${r.status}`);
      const j = (await r.json()) as { job_id?: string };
      if (!j.job_id) throw new Error('no job_id');
      setJobId(j.job_id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'recon failed');
      setStage(null);
    }
  };

  return (
    <Widget title="3D splat" count={stage ?? '—'}>
      <MicroLabel>{photos.length} ground photos available</MicroLabel>
      {err && <div className="mono text-[10px] text-alert mt-1">{err}</div>}
      <div className="mt-2 flex items-center gap-1.5">
        <Btn size="sm" tone="accent" onClick={() => void onBuild()} disabled={stage === 'uploading' || photos.length < 3}>
          build splat
        </Btn>
        {jobId && stage === 'done' && (
          <a
            className="mono text-[10px] px-2 py-1 border border-accent-line text-accent rounded-sm"
            href={`/studio?job=${encodeURIComponent(jobId)}`}
            target="_blank"
            rel="noreferrer"
          >
            open in studio ↗
          </a>
        )}
        {jobId && stage !== 'done' && <MicroLabel>{stage}…</MicroLabel>}
      </div>
    </Widget>
  );
}
