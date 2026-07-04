import { useState } from 'react';
import { SectionLabel, MicroLabel, Caveat, Btn } from '../shell/instruments.js';
import { useImageryDiff } from './imageryDiffStore.js';

// Before/after satellite chips for an AOI (the Gotham "Satellite observation /
// Ship Density Model" popup). Two dated chips side-by-side from the keyless chip
// endpoint (real imagery — Sentinel/Maxar where available, GIBS coarse fallback).
// The endpoint returns None / an error image rather than inventing a frame. The
// detection callout is NOTIONAL (no segmentation model wired) and labelled so.

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function chipUrl(lat: number, lon: number, date: string): string {
  return `/api/imagery/chip?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&radius_km=6&date=${date}&source=auto`;
}

export function ImageryDiff({ aoi }: { aoi: { lat: number; lon: number } }): JSX.Element {
  const [before, setBefore] = useState(isoDaysAgo(21));
  const [after, setAfter] = useState(isoDaysAgo(2));

  return (
    <div className="space-y-2">
      <SectionLabel title="Satellite observation" />
      <p className="mono text-[10px] text-txt-3">
        AOI {aoi.lat.toFixed(3)}, {aoi.lon.toFixed(3)} · 6 km
      </p>
      <div className="flex gap-2">
        <DateField label="Before" value={before} onChange={setBefore} />
        <DateField label="After" value={after} onChange={setAfter} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Chip date={before} url={chipUrl(aoi.lat, aoi.lon, before)} />
        <Chip date={after} url={chipUrl(aoi.lat, aoi.lon, after)} />
      </div>
      <Caveat level="NOTIONAL" note="auto-detection illustrative — no model wired" tone="warn" />
    </div>
  );
}

function DateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}): JSX.Element {
  return (
    <label className="flex-1">
      <MicroLabel>{label}</MicroLabel>
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-0.5 w-full bg-bg-2 border border-line rounded-sm px-1.5 py-1 text-[10px] text-txt-1"
      />
    </label>
  );
}

function Chip({ date, url }: { date: string; url: string }): JSX.Element {
  const [err, setErr] = useState(false);
  return (
    <div className="relative rounded-sm overflow-hidden border border-line bg-bg-2 aspect-square">
      {err ? (
        <div className="absolute inset-0 flex items-center justify-center text-[10px] text-txt-3 text-center px-2">
          no imagery for {date}
        </div>
      ) : (
        <img
          src={url}
          alt={`AOI on ${date}`}
          className="w-full h-full object-cover"
          onError={() => setErr(true)}
        />
      )}
      <span className="absolute bottom-0 left-0 mono text-[10px] text-txt-0 bg-black/60 px-1.5 py-0.5">
        {date}
      </span>
    </div>
  );
}

// Floating popup wrapper (map context menu → "Imagery diff here").
export function ImageryDiffPopup(): JSX.Element | null {
  const { open, aoi, close } = useImageryDiff();
  if (!open || !aoi) return null;
  return (
    <div className="fixed z-[1000] left-1/2 top-20 -translate-x-1/2 w-[360px] rounded-md border border-line-2 bg-bg-1/95 backdrop-blur shadow-2xl p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="mono text-[10px] tracking-[0.6px] uppercase text-txt-2">Imagery diff</span>
        <Btn size="sm" onClick={close}>
          ✕ Close
        </Btn>
      </div>
      <ImageryDiff aoi={aoi} />
    </div>
  );
}
