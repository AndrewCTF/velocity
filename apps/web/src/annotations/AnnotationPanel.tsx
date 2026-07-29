// Annotations editor — the left-rail "Annotate" tab.
//
// This offered three shapes, four fixed colours and a label. It now drives the
// SHARED draft (annotationStore `useAnnoDraft`), so whatever is set here is also
// what the map toolbar's Annotate tool places — the two surfaces used to
// disagree, and the toolbar could only ever drop an unlabelled yellow dot.

import { useEffect, useRef, useState } from 'react';
import * as Cesium from 'cesium';
import {
  MapPin, Minus, Circle, Square, Pentagon, MoveUpRight, PieChart, Type,
  Eye, EyeOff, Lock, Unlock, Trash2, Pencil, Crosshair, Undo2, Redo2,
} from 'lucide-react';
import { Widget, Btn, SectionLabel, MicroLabel } from '../shell/instruments.js';
import { getDrawController } from '../globe/draw.js';
import { CoordEntry } from '../globe/CoordEntry.js';
import { useMapTools } from '../globe/mapTools.js';
import {
  useAnnotations,
  useAnnoDraft,
  draftBase,
  saveAnnotations,
  loadAnnotations,
  annotationsToGeoJSON,
  annotationsFromGeoJSON,
  annotationColor,
  DEFAULT_STYLE,
  THREAT_COLOR,
  type AnnoKind,
  type Threat,
} from './annotationStore.js';

const THREATS: Threat[] = ['hostile', 'friendly', 'neutral', 'unknown'];

// Every kind the store and renderer support, with the draw mode each needs.
const KINDS: readonly { id: AnnoKind; icon: typeof MapPin; label: string }[] = [
  { id: 'point', icon: MapPin, label: 'Point' },
  { id: 'line', icon: Minus, label: 'Line' },
  { id: 'arrow', icon: MoveUpRight, label: 'Arrow' },
  { id: 'polygon', icon: Pentagon, label: 'Polygon' },
  { id: 'rect', icon: Square, label: 'Box' },
  { id: 'circle', icon: Circle, label: 'Circle' },
  { id: 'sector', icon: PieChart, label: 'Sector' },
  { id: 'text', icon: Type, label: 'Text' },
];

const selectCls =
  'bg-bg-2 border border-line rounded-sm text-[10px] text-txt-1 px-1.5 py-1 mono w-full focus:outline-none focus:border-accent-line';

export function AnnotationPanel(): JSX.Element {
  const annos = useAnnotations((s) => s.annotations);
  const add = useAnnotations((s) => s.add);
  const update = useAnnotations((s) => s.update);
  const remove = useAnnotations((s) => s.remove);
  const clear = useAnnotations((s) => s.clear);
  const undo = useAnnotations((s) => s.undo);
  const redo = useAnnotations((s) => s.redo);
  const pastLen = useAnnotations((s) => s.past.length);
  const futureLen = useAnnotations((s) => s.future.length);

  const draft = useAnnoDraft();
  const style = { ...DEFAULT_STYLE, ...draft.style };

  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const draw = getDrawController();
  const noDraw = draw == null;

  // The ontology round-trip existed and was called from nowhere, so a saved
  // workspace was never read back. Load once on mount, best effort.
  useEffect(() => {
    void loadAnnotations();
  }, []);

  // Undo/redo keys, scoped to this panel being mounted.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key.toLowerCase() !== 'z') return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  // Start a draw for the currently-selected kind. The map toolbar's Annotate
  // tool runs the same geometry through the same draft.
  const startDraw = (): void => {
    if (!draw) return;
    const k = draft.kind;
    if (k === 'line' || k === 'arrow' || k === 'freehand') {
      setStatus('Click points on the map; right-click to finish.');
      draw.drawPolyline((verts) => {
        add({ ...draftBase(), coords: verts.map((v) => [v.lon, v.lat]) });
        setStatus(null);
      });
    } else if (k === 'polygon' || k === 'corridor') {
      setStatus('Click the corners; right-click to close the shape.');
      draw.drawPolygon((ring) => {
        add({ ...draftBase(), coords: ring.map((v) => [v.lon, v.lat]) });
        setStatus(null);
      });
    } else if (k === 'rect') {
      setStatus('Click two opposite corners.');
      draw.drawRect((a, b) => {
        add({
          ...draftBase(),
          coords: [
            [a.lon, a.lat],
            [b.lon, a.lat],
            [b.lon, b.lat],
            [a.lon, b.lat],
          ],
        });
        setStatus(null);
      });
    } else if (k === 'circle' || k === 'sector') {
      setStatus('Click the centre, then click again to set the radius.');
      draw.drawCircle((c, r) => {
        add({ ...draftBase(), center: { lat: c.lat, lon: c.lon }, radiusKm: +r.toFixed(2) });
        setStatus(null);
      });
    } else {
      setStatus('Click the map to place it, or type coordinates below.');
      draw.placePoint((p) => {
        add({ ...draftBase(), coords: [[p.lon, p.lat]] });
        setStatus(null);
      });
    }
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    const r = await saveAnnotations();
    setBusy(false);
    setStatus(
      r.ok
        ? `Saved ${annos.length} annotation${annos.length === 1 ? '' : 's'}.`
        : r.status === 401 || r.status === 403
          ? 'Sign in to persist to the workspace. Your drawings are kept on this device.'
          : `Save failed (HTTP ${r.status || 'no response'}).`,
    );
  };

  const exportGeoJSON = (): void => {
    const blob = new Blob([annotationsToGeoJSON()], { type: 'application/geo+json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `annotations-${new Date().toISOString().slice(0, 10)}.geojson`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importGeoJSON = (f: File): void => {
    void f.text().then((t) => {
      const n = annotationsFromGeoJSON(t);
      setStatus(
        n > 0
          ? `Imported ${n} annotation${n === 1 ? '' : 's'}.`
          : 'Nothing to import from that file.',
      );
    });
  };

  const flyTo = (lon: number, lat: number): void => {
    if (!draw) return;
    useMapTools.getState().setTool('pan');
    draw.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, 300_000),
      duration: 1.0,
    });
  };

  const shown = filter
    ? annos.filter((a) =>
        `${a.label} ${a.kind} ${a.group ?? ''}`.toLowerCase().includes(filter.toLowerCase()),
      )
    : annos;

  return (
    <div className="space-y-2 p-2 h-full overflow-y-auto">
      <Widget title="Annotate" count={`${annos.length}`}>
        <SectionLabel title="Shape" />
        <div className="grid grid-cols-4 gap-1 mt-1">
          {KINDS.map((k) => {
            const I = k.icon;
            const on = draft.kind === k.id;
            return (
              <button
                key={k.id}
                type="button"
                title={k.label}
                aria-pressed={on}
                onClick={() => draft.set({ kind: k.id })}
                className={`flex flex-col items-center gap-0.5 rounded-sm border py-1 transition-colors ${
                  on
                    ? 'border-accent-line bg-accent-dim text-accent'
                    : 'border-line text-txt-2 hover:text-txt-0'
                }`}
              >
                <I size={13} strokeWidth={1.75} aria-hidden />
                <span className="text-[9px] mono">{k.label}</span>
              </button>
            );
          })}
        </div>

        <SectionLabel title="Colour" />
        <div className="flex gap-1 mt-1 items-center">
          {THREATS.map((t) => (
            <button
              key={t}
              type="button"
              title={t}
              aria-pressed={draft.threat === t && !draft.style.color}
              onClick={() => {
                const { color: _drop, ...rest } = draft.style;
                draft.set({ threat: t, style: rest });
              }}
              className={`flex-1 text-[10px] mono py-1 rounded-sm border capitalize transition-colors ${
                draft.threat === t && !draft.style.color
                  ? 'border-accent-line bg-accent-dim text-txt-0'
                  : 'border-line text-txt-2 hover:text-txt-0'
              }`}
            >
              <span style={{ color: THREAT_COLOR[t] }}>●</span>
            </button>
          ))}
          {/* Native colour input rather than a picker component: the platform
              already ships one, and this is the only value here that needs to
              be arbitrary. */}
          <input
            type="color"
            aria-label="Custom colour"
            title="Custom colour"
            value={draft.style.color ?? THREAT_COLOR[draft.threat]}
            onChange={(e) => draft.setStyle({ color: e.target.value })}
            className="w-7 h-[26px] bg-transparent border border-line rounded-sm cursor-pointer p-0"
          />
        </div>

        <SectionLabel title="Style" />
        <div className="grid grid-cols-2 gap-x-2 gap-y-1 mt-1">
          <label className="flex flex-col gap-0.5">
            <MicroLabel>Width {style.width}</MicroLabel>
            <input
              type="range"
              min={1}
              max={10}
              step={1}
              value={style.width}
              onChange={(e) => draft.setStyle({ width: Number(e.target.value) })}
              className="w-full accent-[var(--accent)]"
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <MicroLabel>Fill {Math.round(style.fillOpacity * 100)}%</MicroLabel>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round(style.fillOpacity * 100)}
              onChange={(e) => draft.setStyle({ fillOpacity: Number(e.target.value) / 100 })}
              className="w-full accent-[var(--accent)]"
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <MicroLabel>Line</MicroLabel>
            <select
              className={selectCls}
              value={style.dash}
              onChange={(e) => draft.setStyle({ dash: e.target.value as 'solid' | 'dash' | 'dot' })}
            >
              <option value="solid">solid</option>
              <option value="dash">dashed</option>
              <option value="dot">dotted</option>
            </select>
          </label>
          <label className="flex flex-col gap-0.5">
            <MicroLabel>Text {style.fontSize}px</MicroLabel>
            <input
              type="range"
              min={9}
              max={22}
              step={1}
              value={style.fontSize}
              onChange={(e) => draft.setStyle({ fontSize: Number(e.target.value) })}
              className="w-full accent-[var(--accent)]"
            />
          </label>
        </div>

        <label className="flex flex-col gap-0.5 mt-2">
          <MicroLabel>Label (optional)</MicroLabel>
          <input
            className={selectCls}
            placeholder="e.g. OBJ BRAVO"
            value={draft.label}
            onChange={(e) => draft.set({ label: e.target.value })}
          />
        </label>

        <div className="grid grid-cols-3 gap-1.5 mt-2">
          <Btn tone="accent" onClick={startDraw} disabled={noDraw}>
            Draw
          </Btn>
          <Btn onClick={() => draw?.finish()} disabled={noDraw}>
            Finish
          </Btn>
          <Btn
            onClick={() => {
              draw?.cancel();
              setStatus(null);
            }}
            disabled={noDraw}
          >
            Cancel
          </Btn>
        </div>
        <div className="mt-1 text-[9px] text-txt-3 leading-snug">
          Or pick Annotate on the map toolbar and click straight onto the globe. Both
          place whatever is selected here.
        </div>

        <CoordEntry
          viewer={draw?.viewer ?? null}
          placeholder="lat, lon or a place name"
          onPlace={(lat: number, lon: number, placeLabel?: string) => {
            const base = draftBase();
            add({
              ...base,
              label: base.label || placeLabel || '',
              coords: [[lon, lat]],
            });
          }}
        />
      </Widget>

      <Widget title="Placed" count={`${annos.length}`}>
        <div className="flex items-center justify-end gap-1">
          <button
            type="button"
            title="Undo (Ctrl+Z)"
            aria-label="Undo"
            disabled={pastLen === 0}
            onClick={undo}
            className="text-txt-3 hover:text-txt-0 disabled:opacity-30"
          >
            <Undo2 size={12} strokeWidth={1.75} aria-hidden />
          </button>
          <button
            type="button"
            title="Redo (Ctrl+Shift+Z)"
            aria-label="Redo"
            disabled={futureLen === 0}
            onClick={redo}
            className="text-txt-3 hover:text-txt-0 disabled:opacity-30"
          >
            <Redo2 size={12} strokeWidth={1.75} aria-hidden />
          </button>
        </div>

        {annos.length > 3 && (
          <input
            className={`${selectCls} mt-1`}
            placeholder="filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        )}

        <div className="mt-1 max-h-[240px] overflow-auto flex flex-col gap-0.5">
          {shown.map((a) => (
            <div key={a.id} className="rounded-sm border border-line px-1.5 py-1">
              <div className="flex items-center gap-1.5">
                <span style={{ color: annotationColor(a) }} aria-hidden>
                  ●
                </span>
                {editId === a.id ? (
                  <input
                    autoFocus
                    className={selectCls}
                    value={a.label}
                    onChange={(e) => update(a.id, { label: e.target.value })}
                    onBlur={() => setEditId(null)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === 'Escape') setEditId(null);
                    }}
                  />
                ) : (
                  <span className="flex-1 text-[10px] mono text-txt-1 truncate">
                    {a.label || <span className="text-txt-3">{a.kind}</span>}
                  </span>
                )}
                <button
                  type="button"
                  title="Fly to"
                  aria-label={`Fly to ${a.label || a.kind}`}
                  onClick={() => {
                    const c = a.coords?.[0] ?? (a.center ? [a.center.lon, a.center.lat] : null);
                    if (c) flyTo(c[0]!, c[1]!);
                  }}
                  className="text-txt-3 hover:text-accent"
                >
                  <Crosshair size={11} strokeWidth={1.75} aria-hidden />
                </button>
                <button
                  type="button"
                  title={a.hidden ? 'Show' : 'Hide'}
                  aria-label={a.hidden ? 'Show' : 'Hide'}
                  onClick={() => update(a.id, { hidden: !a.hidden })}
                  className="text-txt-3 hover:text-txt-0"
                >
                  {a.hidden ? (
                    <EyeOff size={11} strokeWidth={1.75} aria-hidden />
                  ) : (
                    <Eye size={11} strokeWidth={1.75} aria-hidden />
                  )}
                </button>
                <button
                  type="button"
                  title={a.locked ? 'Unlock' : 'Lock'}
                  aria-label={a.locked ? 'Unlock' : 'Lock'}
                  // Lock has to bypass update(), which itself refuses to touch a
                  // locked annotation — otherwise nothing could ever unlock one.
                  onClick={() =>
                    useAnnotations.setState((s) => ({
                      annotations: s.annotations.map((x) =>
                        x.id === a.id ? { ...x, locked: !x.locked } : x,
                      ),
                    }))
                  }
                  className="text-txt-3 hover:text-txt-0"
                >
                  {a.locked ? (
                    <Lock size={11} strokeWidth={1.75} aria-hidden />
                  ) : (
                    <Unlock size={11} strokeWidth={1.75} aria-hidden />
                  )}
                </button>
                <button
                  type="button"
                  title="Rename and restyle"
                  aria-label="Rename and restyle"
                  onClick={() => setEditId(editId === a.id ? null : a.id)}
                  className="text-txt-3 hover:text-txt-0"
                >
                  <Pencil size={11} strokeWidth={1.75} aria-hidden />
                </button>
                <button
                  type="button"
                  title="Delete"
                  aria-label="Delete"
                  onClick={() => remove(a.id)}
                  className="text-txt-3 hover:text-danger"
                >
                  <Trash2 size={11} strokeWidth={1.75} aria-hidden />
                </button>
              </div>
              {editId === a.id && (
                <div className="flex gap-1 mt-1">
                  {THREATS.map((t) => (
                    <button
                      key={t}
                      type="button"
                      title={t}
                      onClick={() => {
                        const { color: _drop, ...rest } = a.style ?? {};
                        update(a.id, { threat: t, style: rest });
                      }}
                      className="flex-1 text-[10px] py-0.5 rounded-sm border border-line hover:border-accent-line"
                    >
                      <span style={{ color: THREAT_COLOR[t] }}>●</span>
                    </button>
                  ))}
                  <input
                    type="color"
                    aria-label="Colour"
                    value={a.style?.color ?? THREAT_COLOR[a.threat]}
                    onChange={(e) => update(a.id, { style: { ...a.style, color: e.target.value } })}
                    className="w-7 h-[22px] bg-transparent border border-line rounded-sm cursor-pointer p-0"
                  />
                </div>
              )}
            </div>
          ))}
          {shown.length === 0 && (
            <div className="text-[10px] text-txt-3 py-2">
              {annos.length === 0 ? 'Nothing placed yet.' : 'No annotation matches that filter.'}
            </div>
          )}
        </div>

        {status && <div className="mt-2 text-[10px] text-txt-2">{status}</div>}

        <div className="grid grid-cols-2 gap-1.5 mt-2">
          <Btn tone="accent" onClick={() => void save()} disabled={busy}>
            {busy ? 'saving…' : 'Save'}
          </Btn>
          <Btn onClick={exportGeoJSON} disabled={annos.length === 0}>
            Export
          </Btn>
          <Btn onClick={() => fileRef.current?.click()}>Import</Btn>
          <Btn
            onClick={() => {
              // Two-step rather than a modal: "Clear all" had no confirmation at
              // all, and one misclick wiped everything.
              if (!confirmClear) {
                setConfirmClear(true);
                window.setTimeout(() => setConfirmClear(false), 4000);
                return;
              }
              clear();
              setConfirmClear(false);
            }}
            disabled={annos.length === 0}
          >
            {confirmClear ? 'Confirm' : 'Clear all'}
          </Btn>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".geojson,.json,application/geo+json,application/json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) importGeoJSON(f);
            e.target.value = '';
          }}
        />
      </Widget>
    </div>
  );
}
