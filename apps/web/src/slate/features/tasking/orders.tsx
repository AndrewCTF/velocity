import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { create } from "zustand";
import "./tasking.css";
import { BpIcon } from "../../../shell/BpIcon.js";
import { apiFetch } from "../../../transport/http.js";
import { toast } from "../../../shell/toast.js";
import { useDetected } from "../../../situations/detectedStore.js";
import { usePortName } from "../../SlateSituations.js";

// Task orders (features-b copy G53 "Submit task order" with its review
// checklist, G38 the order-status popover behind a top-bar counter).
//
// What is real here: a commercial SAR order needs a provider account
// (GET /api/imagery/tasking/providers says whether one is configured), so the
// order this console can place is the governed one: Submit queues an
// `add_watch` action proposal (POST /api/actions/proposals), a standing
// geofence alert over the collection area, for operator approval. The status
// chain is that proposal's life: queued, received, approved through the
// audited dispatch (POST /api/actions/proposals/{id}/approve), rule created.
// Nothing is approved without a click.

export interface Order {
  pid: string;
  sat: string;
  area: string;
  lat: number;
  lon: number;
  state: "queued" | "approved" | "rejected" | "failed";
  rule?: string;
  why?: string;
}

export const useOrders = create<{
  orders: Order[];
  add: (o: Order) => void;
  patch: (pid: string, p: Partial<Order>) => void;
}>((set) => ({
  orders: [],
  add: (o) => set((s) => ({ orders: [o, ...s.orders] })),
  patch: (pid, p) =>
    set((s) => ({
      orders: s.orders.map((o) => (o.pid === pid ? { ...o, ...p } : o)),
    })),
}));

const box = (
  left: number,
  top: number,
  width?: number,
  height?: number,
  extra: CSSProperties = {},
): CSSProperties => ({
  position: "absolute",
  left,
  top,
  width,
  height,
  ...extra,
});

type Stage = { name: string; ok: boolean | null; note: string };

function Check({ ok }: { ok: boolean | null }): JSX.Element {
  if (ok === null) return <span className="sl-ospin" />;
  return (
    <span className={`sl-ocheck${ok ? "" : " no"}`}>
      <BpIcon name={ok ? "tick" : "cross"} size={12} />
    </span>
  );
}

const hm = (ms: number): string =>
  `${new Date(ms).toISOString().slice(11, 16)}Z`;

/** G53: the submit-task-order modal (frame box 655,386 692x320). */
export function OrderModal({
  onClose,
  onSubmitted,
}: {
  onClose: () => void;
  onSubmitted: () => void;
}): JSX.Element | null {
  const det = useDetected((s) => s.det);
  const sar = useDetected((s) => s.sar);
  const port = usePortName((s) => s.name);
  const [prov, setProv] = useState<{ n: number; on: string[] } | string | null>(
    null,
  );
  const [desc, setDesc] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const review = useCallback((): void => {
    setProv(null);
    apiFetch("/api/imagery/tasking/providers")
      .then(async (r) => {
        if (!r.ok)
          return setProv(`Provider list unavailable (HTTP ${r.status})`);
        const j = (await r.json()) as {
          providers?: { label: string; configured: boolean }[];
        };
        const l = j.providers ?? [];
        setProv({
          n: l.length,
          on: l.filter((p) => p.configured).map((p) => p.label),
        });
      })
      .catch(() => setProv("Provider list unavailable"));
  }, []);
  useEffect(review, [review]);
  if (!det) return null;
  const pass = sar && typeof sar === "object" ? sar : null;
  const sat = pass?.satName ?? "Sentinel-1";
  const area = port ?? `${det.lat.toFixed(2)}, ${det.lon.toFixed(2)}`;
  const text = desc ?? `Requesting SAR collection tasking for ${sat}`;
  const stages: Stage[] = [
    {
      name: "Pass window (SGP4)",
      ok: pass ? true : sar === null ? null : false,
      note: pass
        ? `${sat} ${hm(pass.startMs)}, peak ${pass.maxElevDeg.toFixed(0)}°`
        : sar === null
          ? "Propagating..."
          : "No pass in 48 h",
    },
    {
      name: "Provider account",
      ok:
        prov === null
          ? null
          : typeof prov === "string"
            ? false
            : prov.on.length > 0,
      note:
        prov === null
          ? "Checking..."
          : typeof prov === "string"
            ? prov
            : prov.on.length
              ? prov.on.join(", ")
              : `none of ${prov.n} configured; queues a watch`,
    },
    {
      name: "Sanctions screen",
      ok: det.sanctions_failed.length === 0,
      note: det.sanctions_failed.length
        ? `not loaded: ${det.sanctions_failed.join(", ")}`
        : `${det.sanctions_lists.length} lists loaded`,
    },
    { name: "Operator approval", ok: null, note: "requested on submit" },
  ];
  const done = stages.slice(0, 3).filter((s) => s.ok === true).length;
  const submit = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const r = await apiFetch("/api/actions/proposals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "add_watch",
          params: {
            target_id: `situation:detected:${det.lat.toFixed(3)},${det.lon.toFixed(3)}`,
            label: `SAR collection ${sat} · ${area}`.slice(0, 120),
            lat: det.lat,
            lon: det.lon,
            radius_nm: Math.max(1, Math.round((det.r_km / 1.852) * 10) / 10),
          },
          confidence: 0,
        }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => null)) as {
          detail?: unknown;
        } | null;
        setErr(
          `Order not queued (HTTP ${r.status}${typeof j?.detail === "string" ? `: ${j.detail}` : ""})`,
        );
        return;
      }
      const j = (await r.json()) as { id: string };
      useOrders.getState().add({
        pid: j.id,
        sat,
        area,
        lat: det.lat,
        lon: det.lon,
        state: "queued",
      });
      toast.ok(`Task order queued for approval: ${sat} over ${area}`);
      onSubmitted();
    } catch {
      setErr("Order not queued: network error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="sl-task-backdrop" onClick={onClose}>
      <div
        className="sl-g53"
        role="dialog"
        aria-label="Submit task order"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={box(1, 1, 690, 28, {
            background: "#101418",
            borderBottom: "1px solid #20282b",
          })}
        />
        <div
          className="t"
          style={box(15, 5, undefined, undefined, {
            fontSize: 14,
            color: "#f1f4f6",
          })}
        >
          Submit task order for <b>SAR collection</b>
        </div>
        <button
          type="button"
          className="sl-link"
          style={box(658, 7, 16, 16, { color: "#e5e8eb" })}
          aria-label="Close"
          onClick={onClose}
        >
          <BpIcon name="cross" size={16} />
        </button>
        <div
          className="t"
          style={box(20, 43, undefined, undefined, {
            fontSize: 12.5,
            letterSpacing: ".04em",
            color: "#c4ced3",
          })}
        >
          DESCRIPTION
        </div>
        <div
          className="t"
          style={box(221, 43, undefined, undefined, {
            fontSize: 12.5,
            letterSpacing: ".04em",
            color: "#c4ced3",
          })}
        >
          REQUIRED REVIEW
        </div>
        <div style={box(20, 70, 166, 164, { background: "#202a2e" })} />
        {editing ? (
          <textarea
            className="sl-odesc"
            style={box(26, 76, 154, 120)}
            value={text}
            maxLength={300}
            onChange={(e) => setDesc(e.target.value)}
            aria-label="Order description"
          />
        ) : (
          <div className="sl-odesct" style={box(31, 81, 145, 110)}>
            {text}
          </div>
        )}
        <button
          type="button"
          className="t sl-link"
          style={box(31, 204, undefined, undefined, {
            fontSize: 15,
            color: "#5da7ef",
          })}
          onClick={() => setEditing((v) => !v)}
        >
          {editing ? "Done editing" : "Edit description"}
        </button>
        <div
          className="t"
          style={box(221, 71, 440, undefined, {
            fontSize: 12.5,
            fontStyle: "italic",
            color: done === 3 ? "#4fd6a0" : "#9fabb2",
          })}
        >
          {done === 3
            ? "All review stages are complete"
            : `${done} of 3 review stages complete`}
        </div>
        {stages.map((st, i) => (
          <div key={st.name}>
            <span
              style={box(222, 100 + 35.5 * i, 24, 24, {
                display: "grid",
                placeItems: "center",
              })}
            >
              <Check ok={st.ok} />
            </span>
            <div
              className="t"
              style={box(255, 102 + 35.5 * i, undefined, undefined, {
                fontSize: 15.5,
                fontWeight: 600,
                color: "#f6f7f9",
              })}
            >
              {st.name}
            </div>
            <div
              className="t"
              style={box(465, 103 + 35.5 * i, 215, undefined, {
                fontSize: 12.5,
                color: "#9fabb2",
                fontStyle: st.ok === null ? "italic" : undefined,
                overflow: "hidden",
                textOverflow: "ellipsis",
              })}
              title={st.note}
            >
              {st.note}
            </div>
          </div>
        ))}
        {err && (
          <div
            className="t"
            style={box(221, 245, 450, undefined, {
              fontSize: 13,
              color: "#f0838b",
              overflow: "hidden",
              textOverflow: "ellipsis",
            })}
            title={err}
          >
            {err}
          </div>
        )}
        <button
          type="button"
          className="sl-g53b"
          style={box(21, 270, 74, 29)}
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          type="button"
          className="sl-g53b"
          style={box(376, 270, 134, 29)}
          onClick={review}
        >
          Restart review
        </button>
        <button
          type="button"
          className="sl-g53b"
          style={box(521, 270, 151, 29)}
          disabled={busy || !pass}
          title={
            !pass ? "No pass to order" : "Queue the order for operator approval"
          }
          onClick={() => void submit()}
        >
          {busy ? "Submitting..." : "Submit task order"}
        </button>
      </div>
    </div>
  );
}

/** G38: top-bar counter with the latest order's approval chain. */
export function OrderCounter(): JSX.Element | null {
  const orders = useOrders((s) => s.orders);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [open]);
  if (!orders.length) return null;
  const o = orders[0]!;
  const pending = orders.filter((x) => x.state === "queued").length;
  const decide = async (how: "approve" | "reject"): Promise<void> => {
    setBusy(true);
    try {
      const r = await apiFetch(
        `/api/actions/proposals/${encodeURIComponent(o.pid)}/${how}`,
        { method: "POST" },
      );
      if (!r.ok) {
        useOrders
          .getState()
          .patch(o.pid, { state: "failed", why: `HTTP ${r.status}` });
        return;
      }
      if (how === "reject") {
        useOrders.getState().patch(o.pid, { state: "rejected" });
        return;
      }
      const j = (await r.json()) as {
        ok?: boolean;
        message?: string;
        result?: Record<string, unknown>;
      };
      useOrders.getState().patch(o.pid, {
        state: j.ok === false ? "failed" : "approved",
        ...(j.message ? { why: j.message } : {}),
      });
    } finally {
      setBusy(false);
    }
  };
  const steps: [string, boolean | null][] = [
    [
      "Request the pass to be tasked",
      o.state === "approved" ? true : o.state === "queued" ? null : false,
    ],
    ["Request received", true],
    [
      o.state === "rejected" ? "Rejected by operator" : "Approved by operator",
      o.state === "approved" ? true : o.state === "queued" ? null : false,
    ],
    [
      o.state === "failed"
        ? `Tasking failed${o.why ? `: ${o.why}` : ""}`
        : o.state === "rejected"
          ? "No tasking: order rejected"
          : "Tasking received (area watch created)",
      o.state === "approved" ? true : o.state === "queued" ? null : false,
    ],
  ];
  return (
    <div ref={ref} className="sl-ordwrap">
      <button
        type="button"
        className="sl-ordcnt"
        aria-expanded={open}
        aria-label={`Task orders, ${pending} pending`}
        title="Task orders"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="dot">
          <BpIcon name="arrow-up" size={18} />
        </span>
        <span className="n">{pending}</span>
      </button>
      {open && (
        <div className="sl-g38" role="dialog" aria-label="Tasking order status">
          <div
            className="t"
            style={box(18, 10, 285, undefined, {
              fontSize: 16,
              fontWeight: 700,
              color: "#f6f7f9",
              overflow: "hidden",
              textOverflow: "ellipsis",
            })}
          >
            Tasking order for {o.sat}
          </div>
          <div
            className="t"
            style={box(18, 30, undefined, undefined, {
              fontSize: 13.5,
              color: "#9fabb2",
            })}
          >
            {o.area}
          </div>
          {steps.map(([t, ok], i) => (
            <div key={i}>
              <span
                style={box(21, 63 + 34 * i, 24, 24, {
                  display: "grid",
                  placeItems: "center",
                })}
              >
                <Check ok={ok} />
              </span>
              <div
                className="t"
                style={box(53, 65 + 34 * i, 255, undefined, {
                  fontSize: 16,
                  color: "#f1f4f6",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                })}
                title={t}
              >
                {t}
              </div>
            </div>
          ))}
          {o.state === "queued" && (
            <div
              className="acts"
              style={box(53, 200, 250, 26, { display: "flex", gap: 8 })}
            >
              <button
                type="button"
                className="sl-g53b"
                style={{ position: "static", height: 26, padding: "0 12px" }}
                disabled={busy}
                onClick={() => void decide("approve")}
              >
                Approve
              </button>
              <button
                type="button"
                className="sl-g53b"
                style={{ position: "static", height: 26, padding: "0 12px" }}
                disabled={busy}
                onClick={() => void decide("reject")}
              >
                Reject
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
