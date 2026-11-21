import { useState } from "react";
import * as Cesium from "cesium";
import { apiFetch } from "../../../transport/http.js";
import { altitudeForWidth, flyToPosition } from "../../../globe/camera.js";
import { useConfirm } from "../../../shell/Modal.js";
import {
  useSituations,
  type Situation,
} from "../../../situations/situationStore.js";
import "./saved.css";

// The working half of a saved situation: give it an area, pull contacts into
// it, ask the reasoning model for explanations and actions, delete it. The
// store and the routes behind every button already existed; the Slate panel
// showed a saved situation read-only, so a new or old one was a dead end.

/** A map rectangle (degrees) as a situation area: its centre and the radius of
 *  the largest circle that fits inside it, in km. */
export function rectArea(
  w: number,
  s: number,
  e: number,
  n: number,
): { centroid: { lat: number; lon: number }; radius_km: number } {
  const east = e < w ? e + 360 : e; // the view straddles the antimeridian
  let lon = (w + east) / 2;
  if (lon > 180) lon -= 360;
  const lat = (s + n) / 2;
  const wideKm = (east - w) * 111.32 * Math.cos((lat * Math.PI) / 180);
  const tallKm = (n - s) * 110.57;
  const r = Math.min(wideKm, tallKm) / 2;
  return {
    centroid: { lat: +lat.toFixed(4), lon: +lon.toFixed(4) },
    radius_km: Math.round(Math.min(2000, Math.max(1, r))),
  };
}

/** What the camera shows now, as a situation area; null off the globe. */
export function viewArea(
  viewer: Cesium.Viewer | null,
): ReturnType<typeof rectArea> | null {
  if (!viewer || viewer.isDestroyed()) return null;
  const r = viewer.camera.computeViewRectangle();
  if (!r) return null;
  const d = Cesium.Math.toDegrees;
  return rectArea(d(r.west), d(r.south), d(r.east), d(r.north));
}

/** The sentence for a failed COA proposal. Exported for tests. */
export function proposeError(
  status: number,
  body: { error?: string; model?: string | null } | null,
): string {
  if (status === 401) return "Sign in to propose explanations and actions.";
  const err = body?.error ?? "";
  if (/no models installed/i.test(err))
    return "No local chat model is installed, so AI proposals are off. Set one up in Settings, Local AI.";
  if (/does not support chat/i.test(err))
    return `AI proposals unavailable: the configured model (${body?.model ?? "unknown"}) cannot chat. Choose a chat model in Settings, Local AI.`;
  if (status >= 400) return `AI proposals unavailable (HTTP ${status}).`;
  return `AI proposals unavailable (${body?.model ? `model ${body.model}` : "no model configured"}).`;
}

export function SavedSitBar({
  sit,
  viewer,
  selected,
  linked,
  onLinked,
  onDeleted,
}: {
  sit: Situation;
  viewer: Cesium.Viewer | null;
  selected: string | null;
  linked: string[];
  onLinked: () => void;
  onDeleted: () => void;
}): JSX.Element {
  const update = useSituations((s) => s.update);
  const remove = useSituations((s) => s.remove);
  const linkChild = useSituations((s) => s.linkChild);
  const { confirm, confirmElement } = useConfirm();
  const already = selected !== null && linked.includes(selected);
  const addTitle = !selected
    ? "Select a contact on the map first"
    : already
      ? "Already in this situation"
      : `Add ${selected} to this situation`;
  return (
    <div className="sl-sitbar">
      <button
        type="button"
        className="sl-xbtn"
        disabled={!sit.centroid || !viewer}
        title={sit.centroid ? "Fly the map to this area" : "No area set yet"}
        onClick={() => {
          if (!viewer || !sit.centroid) return;
          flyToPosition(
            viewer,
            sit.centroid.lon,
            sit.centroid.lat,
            altitudeForWidth(viewer, Math.max(400_000, sit.radius_km * 3_000)),
            1.0,
          );
        }}
      >
        Fly to area
      </button>
      <button
        type="button"
        className="sl-xbtn"
        disabled={!viewer}
        title="Set this situation's area to what the map shows now"
        onClick={() => {
          const a = viewArea(viewer);
          if (a) void update(sit.id, a);
        }}
      >
        Use map view
      </button>
      <button
        type="button"
        className="sl-xbtn"
        disabled={!selected || already}
        title={addTitle}
        onClick={() => {
          if (selected)
            void linkChild(sit.id, selected).then((ok) => ok && onLinked());
        }}
      >
        Add selected
      </button>
      <button
        type="button"
        className="sl-xbtn sl-del"
        title="Delete this situation"
        onClick={() => {
          void confirm({
            title: "Delete situation",
            body: `Delete "${sit.name}"? Its links go with it; the contacts stay.`,
            confirmLabel: "Delete",
            tone: "danger",
          }).then((yes) => {
            if (!yes) return;
            void remove(sit.id);
            onDeleted();
          });
        }}
      >
        Delete
      </button>
      {confirmElement}
    </div>
  );
}

interface Proposal {
  title: string;
  side: "enemy" | "friendly";
  likelihood: string;
  rationale: string;
}

let seq = 0;

/** "Propose with AI" over the situation's linked evidence, then Keep (saved as
 *  a coa: object linked to the situation) or Dismiss each card. */
export function ProposeCoas({
  sitId,
  onKept,
}: {
  sitId: string;
  onKept: () => void;
}): JSX.Element {
  const linkChild = useSituations((s) => s.linkChild);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [items, setItems] = useState<Proposal[]>([]);
  const [forId, setForId] = useState(sitId);
  if (forId !== sitId) {
    // a different situation opened: its proposals are not this one's
    setForId(sitId);
    setItems([]);
    setNote(null);
  }

  const propose = async (): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      const r = await apiFetch(
        `/api/situations/${encodeURIComponent(sitId)}/coa/propose`,
        { method: "POST" },
      );
      const body = (await r.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
        model?: string | null;
        coas?: Record<string, unknown>[];
      } | null;
      if (!r.ok || !body?.ok) {
        setNote(proposeError(r.status, body));
        return;
      }
      const fresh = (body.coas ?? []).map((c) => ({
        title: String(c.title ?? "Untitled"),
        side: c.side === "friendly" ? ("friendly" as const) : ("enemy" as const),
        likelihood: String(c.likelihood ?? "med"),
        rationale: String(c.rationale ?? ""),
      }));
      setItems(fresh);
      if (fresh.length === 0)
        setNote(
          "The model found too little evidence. Add contacts to the situation first.",
        );
    } catch {
      setNote("AI proposals unavailable (request failed).");
    } finally {
      setBusy(false);
    }
  };

  const keep = async (p: Proposal): Promise<void> => {
    const id = `coa:${Date.now().toString(36)}-${(seq++).toString(36)}`;
    const r = await apiFetch("/api/ontology/object", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        props: { kind: "coa", ...p, status: "confirmed", source: "AI, kept by analyst" },
      }),
    }).catch(() => null);
    if (!r?.ok) {
      setNote(`Not saved (HTTP ${r?.status ?? "error"}).`);
      return;
    }
    if (await linkChild(sitId, id)) {
      setItems((xs) => xs.filter((x) => x !== p));
      onKept();
    }
  };

  return (
    <div className="sl-propose">
      <button
        type="button"
        className="sl-xbtn"
        disabled={busy}
        onClick={() => void propose()}
        title="Ask the reasoning model for explanations and actions from this situation's linked contacts"
      >
        {busy ? "Proposing…" : "Propose with AI"}
      </button>
      {note && <p className="sl-note">{note}</p>}
      {items.map((p, i) => (
        <div key={`${i}:${p.title}`} className="sl-prop">
          <div className="sl-prop-h">
            <span className="sl-prop-t">{p.title}</span>
            <span className={`chip${p.side === "enemy" ? " r" : ""}`}>
              {p.side === "enemy" ? "Explanation" : "Action"}
            </span>
          </div>
          <span className="sl-prop-by">
            Hypothetical · {p.likelihood} likelihood
          </span>
          {p.rationale && <p className="sl-prop-r">{p.rationale}</p>}
          <div className="sl-prop-b">
            <button type="button" className="sl-xbtn" onClick={() => void keep(p)}>
              Keep
            </button>
            <button
              type="button"
              className="sl-xbtn"
              onClick={() => setItems((xs) => xs.filter((x) => x !== p))}
            >
              Dismiss
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
