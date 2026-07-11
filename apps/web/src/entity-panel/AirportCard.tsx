import { useEffect, useState } from 'react';
import { Widget, Badge, Caveat, KV, KVRow, MicroLabel, type BadgeTone } from '../shell/instruments.js';
import { fetchMetar, type AirportEnrichment, type Metar, type Runway } from '../transport/entity.js';

// ── ILS CAT badge ────────────────────────────────────────────────────────
// CAT data is FAA NASR (ils_rf.txt) — US-only. `ils_category*` is null for
// every non-US runway and for US runways with no ILS at all; render '—' in
// both cases, never guess from length/lighting (docs/places-airspace-plan.md §7).
function IlsBadge({ cat }: { cat: string | null | undefined }): JSX.Element {
  if (!cat) return <span className="mono text-[10px] text-txt-3">—</span>;
  return <Badge tone="accent">CAT {cat}</Badge>;
}

function RunwayRow({ rw }: { rw: Runway }): JSX.Element {
  const ends = [rw.le_ident, rw.he_ident].filter(Boolean).join(' / ') || '—';
  const differs =
    rw.ils_category_le !== undefined &&
    rw.ils_category_he !== undefined &&
    rw.ils_category_le !== rw.ils_category_he;
  return (
    <tr className="border-t border-line/60">
      <td className="py-1 pr-2 mono text-[10.5px] text-txt-0 whitespace-nowrap">{ends}</td>
      <td className="py-1 pr-2 mono text-[10.5px] text-txt-1 text-right tabular-nums whitespace-nowrap">
        {typeof rw.length_ft === 'number' ? rw.length_ft.toLocaleString() : '—'} ft
      </td>
      <td className="py-1 pr-2 mono text-[10px] text-txt-2 uppercase whitespace-nowrap">{rw.surface || '—'}</td>
      <td className="py-1 pr-2 text-center">{rw.lighted ? '✓' : '—'}</td>
      <td className="py-1 pl-1">
        {differs ? (
          <div className="flex items-center gap-1 flex-wrap">
            <IlsBadge cat={rw.ils_category_le} />
            <span className="text-txt-3 text-[9px]">/</span>
            <IlsBadge cat={rw.ils_category_he} />
          </div>
        ) : (
          <IlsBadge cat={rw.ils_category} />
        )}
      </td>
    </tr>
  );
}

// ── METAR / live weather block ───────────────────────────────────────────
const FLTCAT_TONE: Record<string, BadgeTone> = {
  VFR: 'ok',
  MVFR: 'accent',
  IFR: 'alert',
  LIFR: 'mag',
};

function windArrow(wdir: number | string | null | undefined): JSX.Element | null {
  if (typeof wdir !== 'number') return null;
  // Meteorological convention: wdir is where the wind blows FROM. A down
  // arrow (pointing toward the direction wind flows) rotated by wdir shows
  // that flow direction on a screen where 0deg = up = north.
  return (
    <span
      aria-hidden
      className="inline-block text-txt-1"
      style={{ transform: `rotate(${wdir}deg)` }}
      title={`wind from ${wdir}°`}
    >
      ↓
    </span>
  );
}

function lowVisib(visib: number | string | null | undefined): boolean {
  if (typeof visib === 'number') return visib < 3;
  if (typeof visib === 'string') {
    const n = Number.parseFloat(visib);
    return Number.isFinite(n) && n < 3;
  }
  return false;
}

function MetarBlock({ icao }: { icao: string }): JSX.Element {
  const [metar, setMetar] = useState<Metar | null | undefined>(undefined); // undefined = loading
  useEffect(() => {
    setMetar(undefined);
    const aborter = new AbortController();
    fetchMetar(icao, aborter.signal)
      .then((m) => setMetar(m))
      .catch(() => setMetar(null));
    return () => aborter.abort();
  }, [icao]);

  if (metar === undefined) {
    return <p className="mono text-[10px] tracking-[0.5px] uppercase text-txt-3">resolving metar…</p>;
  }
  if (!metar) {
    return <p className="mono text-[10px] text-txt-3">METAR unavailable — non-reporting station</p>;
  }
  const fltCat = metar.fltCat ?? null;
  const fog = (fltCat === 'IFR' || fltCat === 'LIFR' || lowVisib(metar.visib)) ?? false;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        {fltCat && <Badge tone={FLTCAT_TONE[fltCat] ?? 'neutral'}>{fltCat}</Badge>}
        {fog && <Badge tone="warn">low vis / fog</Badge>}
      </div>
      <KV>
        <KVRow
          k="Wind"
          v={
            <span className="inline-flex items-center gap-1">
              {windArrow(metar.wdir)}
              {typeof metar.wdir === 'number' ? `${metar.wdir}°` : (metar.wdir ?? '—')}
              {typeof metar.wspd === 'number' ? ` @ ${metar.wspd} kt` : ''}
            </span>
          }
        />
        <KVRow k="Visibility" v={metar.visib != null ? `${metar.visib} sm` : '—'} />
        {typeof metar.temp === 'number' && <KVRow k="Temp" v={`${metar.temp.toFixed(0)}°C`} />}
        {typeof metar.altim === 'number' && <KVRow k="Altimeter" v={`${metar.altim.toFixed(1)} hPa`} />}
      </KV>
      {metar.rawOb && <p className="mono text-[9.5px] text-txt-3 leading-snug break-all">{metar.rawOb}</p>}
    </div>
  );
}

// ── LiveATC (best-effort, experimental) ──────────────────────────────────
function LiveAtcBlock({
  liveatcUrl,
  mounts,
}: {
  liveatcUrl: string;
  mounts: string[];
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [mountIdx, setMountIdx] = useState(0);
  const [streamError, setStreamError] = useState(false);
  const selected = mounts[mountIdx] ?? null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <a
          href={liveatcUrl}
          target="_blank"
          rel="noreferrer"
          className="mono text-[10px] text-accent hover:underline"
        >
          LiveATC search →
        </a>
        {mounts.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="mono text-[10px] text-txt-2 hover:text-txt-0 underline decoration-dotted"
          >
            {open ? 'hide stream' : 'try live stream (experimental)'}
          </button>
        )}
      </div>
      {open && selected && (
        <div className="space-y-1.5 rounded-sm border border-line bg-bg-2/60 p-2">
          <Caveat level="EXPERIMENTAL" note="best-effort stream, may be unavailable" tone="warn" />
          {mounts.length > 1 && (
            <select
              value={mountIdx}
              onChange={(e) => {
                setMountIdx(Number(e.target.value));
                setStreamError(false);
              }}
              className="mono text-[10px] bg-bg-1 border border-line rounded-sm px-1.5 py-1 text-txt-1"
            >
              {mounts.map((m, i) => (
                <option key={m} value={i}>
                  mount {i + 1}
                </option>
              ))}
            </select>
          )}
          {streamError ? (
            <p className="mono text-[10px] text-txt-3">stream unavailable</p>
          ) : (
            <audio
              controls
              src={selected}
              className="w-full h-8"
              onError={() => setStreamError(true)}
            />
          )}
        </div>
      )}
    </div>
  );
}

export function AirportCard({ enrichment }: { enrichment: AirportEnrichment }): JSX.Element {
  const runways = enrichment.runways ?? [];
  const frequencies = enrichment.frequencies ?? [];
  const mounts = enrichment.candidate_mounts ?? [];

  return (
    <Widget title="Airport">
      <div className="space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge tone={enrichment.military ? 'alert' : 'ok'}>{enrichment.military ? 'MILITARY' : 'CIVIL'}</Badge>
          {enrichment.atype && <Badge tone="neutral">{enrichment.atype}</Badge>}
          {enrichment.scheduled_service && <Badge tone="accent">scheduled service</Badge>}
        </div>

        <KV>
          <KVRow k="Runways" v={enrichment.runway_count ?? runways.length} />
          <KVRow
            k="Longest"
            v={
              typeof enrichment.max_runway_length_ft === 'number'
                ? `${enrichment.max_runway_length_ft.toLocaleString()} ft`
                : '—'
            }
          />
          <KVRow k="Elevation" v={typeof enrichment.elevation_ft === 'number' ? `${enrichment.elevation_ft} ft` : '—'} />
          {enrichment.municipality && <KVRow k="Municipality" v={enrichment.municipality} />}
        </KV>

        {runways.length > 0 && (
          <div>
            <MicroLabel>Runways</MicroLabel>
            <div className="mt-1 overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr>
                    <th className="mono text-[9px] uppercase text-txt-3 font-normal pb-1 pr-2">Ident</th>
                    <th className="mono text-[9px] uppercase text-txt-3 font-normal pb-1 pr-2 text-right">Length</th>
                    <th className="mono text-[9px] uppercase text-txt-3 font-normal pb-1 pr-2">Surface</th>
                    <th className="mono text-[9px] uppercase text-txt-3 font-normal pb-1 pr-2">Lit</th>
                    <th className="mono text-[9px] uppercase text-txt-3 font-normal pb-1 pl-1">ILS CAT</th>
                  </tr>
                </thead>
                <tbody>
                  {runways.map((rw, i) => (
                    <RunwayRow key={`${rw.le_ident ?? ''}-${rw.he_ident ?? ''}-${i}`} rw={rw} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {frequencies.length > 0 && (
          <div>
            <MicroLabel>Frequencies</MicroLabel>
            <KV className="mt-1">
              {frequencies.map((f, i) => (
                <KVRow key={`${f.type ?? ''}-${f.mhz ?? ''}-${i}`} k={f.type ?? '—'} v={typeof f.mhz === 'number' ? `${f.mhz} MHz` : '—'} />
              ))}
            </KV>
          </div>
        )}

        {enrichment.icao && (
          <div>
            <MicroLabel>Live weather</MicroLabel>
            <div className="mt-1">
              <MetarBlock icao={enrichment.icao} />
            </div>
          </div>
        )}

        {enrichment.liveatc_url && (
          <div>
            <MicroLabel>LiveATC</MicroLabel>
            <div className="mt-1">
              <LiveAtcBlock liveatcUrl={enrichment.liveatc_url} mounts={mounts} />
            </div>
          </div>
        )}
      </div>
    </Widget>
  );
}
