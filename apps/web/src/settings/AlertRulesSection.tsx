// Alert-rule creation UI — the console had a real, tested backend
// (POST /api/alerts/rules, deliveries at /api/alerts/deliveries,
// app/routes/alert_rules.py) with zero UI to reach it (user-feedback study
// P6). A standing rule is an AOI (lat/lon/radius) + signal kinds + a minimum
// severity + a delivery channel, optionally pinned to one aircraft/vessel
// identity (icao24/mmsi/callsign) so the watch keeps following it once it
// leaves the drawn area (app/intel/watch.py).
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../transport/http.js';

// Mirrors app/routes/alert_rules.py::KINDS exactly — the route 400s on any
// kind not in this set, so keep the two lists in sync.
const KINDS = [
  'jamming',
  'dark_vessel',
  'military_air',
  'military_vessel',
  'incident',
  'quake',
  'fire',
  'ais_gap',
  'rendezvous',
  'loiter',
] as const;

const CHANNELS = ['inapp', 'discord', 'webhook'] as const;
type Channel = (typeof CHANNELS)[number];

// The list card used to always render `${rule.radius_nm} nm`, even for an
// identity-pinned rule created with no AOI at all (radius_nm null) — a fake
// geofence badge for a rule watch.py's has_identity gate never actually
// enforces (sam-2). Say what the rule really is instead.
function aoiLabel(rule: AlertRule): string {
  const hasIdentity = Boolean(rule.icao24 || rule.mmsi || rule.callsign);
  const hasAoi = rule.lat != null && rule.lon != null && rule.radius_nm != null;
  if (hasIdentity && hasAoi) return `identity pin · ${rule.radius_nm} nm`;
  if (hasIdentity) return 'identity pin · global';
  if (hasAoi) return `${rule.radius_nm} nm`;
  return '—';
}

interface AlertRule {
  id: string;
  label: string;
  lat: number | null;
  lon: number | null;
  radius_nm: number | null;
  kinds: string[];
  min_severity: number;
  channel: string;
  sink_url?: string | null;
  enabled: boolean;
  icao24?: string | null;
  mmsi?: string | null;
  callsign?: string | null;
  created_at?: string | null;
}

interface FormState {
  label: string;
  lat: string;
  lon: string;
  radius_nm: string;
  kinds: Set<string>;
  min_severity: number;
  channel: Channel;
  sink_url: string;
  icao24: string;
  mmsi: string;
  callsign: string;
}

const EMPTY_FORM: FormState = {
  label: '',
  lat: '',
  lon: '',
  radius_nm: '50',
  kinds: new Set(),
  min_severity: 1,
  channel: 'inapp',
  sink_url: '',
  icao24: '',
  mmsi: '',
  callsign: '',
};

export function AlertRulesSection(): JSX.Element {
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);

  const loadRules = useCallback(async () => {
    try {
      const r = await apiFetch('/api/alerts/rules');
      if (!r.ok) {
        setRulesError(`Could not load alert rules (HTTP ${r.status}).`);
        return;
      }
      setRulesError(null);
      setRules((await r.json()) as AlertRule[]);
    } catch {
      setRulesError('Gateway unreachable.');
    }
  }, []);

  useEffect(() => {
    void loadRules();
  }, [loadRules]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  const toggleKind = (kind: string): void => {
    setForm((f) => {
      const next = new Set(f.kinds);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return { ...f, kinds: next };
    });
  };

  const submit = async (): Promise<void> => {
    setError(null);
    setCreatedId(null);
    if (!form.label.trim()) {
      setError('Label is required.');
      return;
    }
    const hasIdentity = Boolean(
      form.icao24.trim() || form.mmsi.trim() || form.callsign.trim(),
    );
    // Number('') === 0, which IS finite — coercing a blank lat/lon straight to
    // Number() used to submit a real (0, 0) geofence for what the analyst meant
    // as "no AOI, just follow this identity." Read blankness from the raw
    // string first so an identity-only rule can omit the AOI instead of lying
    // about it, and a half-filled AOI is a hard error rather than a silent 0.
    const latRaw = form.lat.trim();
    const lonRaw = form.lon.trim();
    const latBlank = latRaw === '';
    const lonBlank = lonRaw === '';
    if (latBlank !== lonBlank) {
      setError('Lat and lon must both be set or both left blank.');
      return;
    }
    const hasAoi = !latBlank && !lonBlank;
    if (!hasAoi && !hasIdentity) {
      setError(
        'Provide either an identity field (icao24, mmsi, or callsign) or a complete lat/lon/radius AOI.',
      );
      return;
    }
    let aoi: { lat: number; lon: number; radius_nm: number } | null = null;
    if (hasAoi) {
      const lat = Number(latRaw);
      const lon = Number(lonRaw);
      const radiusRaw = form.radius_nm.trim();
      const radius_nm = radiusRaw === '' ? 50 : Number(radiusRaw);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        setError('Lat and lon must be numbers.');
        return;
      }
      // Mirror the backend AlertRuleIn Field constraints so a bad AOI is caught
      // before the round-trip (routes/alert_rules.py: lat ±90, lon ±180, radius 0<r≤5000).
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        setError('Lat must be -90..90 and lon -180..180.');
        return;
      }
      if (!Number.isFinite(radius_nm) || radius_nm <= 0 || radius_nm > 5000) {
        setError('Radius (nm) must be greater than 0 and at most 5000.');
        return;
      }
      aoi = { lat, lon, radius_nm };
    }
    if (form.channel !== 'inapp' && !form.sink_url.trim()) {
      setError(`Channel ${form.channel} requires a sink URL.`);
      return;
    }
    setBusy(true);
    try {
      const r = await apiFetch('/api/alerts/rules', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          label: form.label.trim(),
          ...(aoi ?? {}),
          kinds: Array.from(form.kinds),
          min_severity: form.min_severity,
          channel: form.channel,
          sink_url: form.channel === 'inapp' ? null : form.sink_url.trim(),
          icao24: form.icao24.trim() || null,
          mmsi: form.mmsi.trim() || null,
          callsign: form.callsign.trim() || null,
        }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as { detail?: string } | null;
        setError(body?.detail ?? `Could not create the rule (HTTP ${r.status}).`);
        return;
      }
      const created = (await r.json()) as AlertRule;
      setCreatedId(created.id);
      setForm(EMPTY_FORM);
      void loadRules();
    } catch {
      setError('Gateway unreachable.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string): Promise<void> => {
    try {
      const r = await apiFetch(`/api/alerts/rules/${id}`, { method: 'DELETE' });
      if (!r.ok && r.status !== 204) return;
      void loadRules();
    } catch {
      /* non-fatal */
    }
  };

  return (
    <div className="flex flex-col gap-2.5">
      {rules.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {rules.map((rule) => (
            <div
              key={rule.id}
              className="flex items-center justify-between gap-2 rounded-sm border border-line bg-bg-2/50 px-2.5 py-1.5"
            >
              <div className="flex flex-col min-w-0">
                <span className="mono text-[11px] text-txt-1 truncate">{rule.label}</span>
                <span className="mono text-[10px] text-txt-3 truncate">
                  {aoiLabel(rule)} · {rule.kinds.join(', ') || 'all kinds'} · sev≥
                  {rule.min_severity} · {rule.channel}
                </span>
              </div>
              <button
                type="button"
                onClick={() => void remove(rule.id)}
                className="mono text-[10px] px-2 py-0.5 border border-line rounded-sm text-txt-2 hover:border-alert-line hover:text-alert-fg shrink-0"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
      {rulesError && <p className="mono text-[10px] text-alert-fg">{rulesError}</p>}

      <div className="rounded-sm border border-line px-2.5 py-2 flex flex-col gap-2">
        <input
          type="text"
          value={form.label}
          onChange={(e) => set('label', e.target.value)}
          placeholder="Label (e.g. Strait of Hormuz watch)"
          className="w-full mono text-[10px] bg-bg-2 border border-line rounded-sm px-2 py-1 text-txt-1 placeholder:text-txt-3 focus:border-accent-line outline-none"
        />

        <div className="flex gap-1.5">
          <input
            type="number"
            value={form.lat}
            onChange={(e) => set('lat', e.target.value)}
            placeholder="lat"
            className="w-1/3 mono text-[10px] bg-bg-2 border border-line rounded-sm px-2 py-1 text-txt-1 placeholder:text-txt-3 focus:border-accent-line outline-none"
          />
          <input
            type="number"
            value={form.lon}
            onChange={(e) => set('lon', e.target.value)}
            placeholder="lon"
            className="w-1/3 mono text-[10px] bg-bg-2 border border-line rounded-sm px-2 py-1 text-txt-1 placeholder:text-txt-3 focus:border-accent-line outline-none"
          />
          <input
            type="number"
            value={form.radius_nm}
            onChange={(e) => set('radius_nm', e.target.value)}
            placeholder="radius (nm)"
            className="w-1/3 mono text-[10px] bg-bg-2 border border-line rounded-sm px-2 py-1 text-txt-1 placeholder:text-txt-3 focus:border-accent-line outline-none"
          />
        </div>

        <div>
          <div className="mono text-[10px] text-txt-3 mb-1">Signal kinds (blank = all)</div>
          <div className="flex flex-wrap gap-1">
            {KINDS.map((kind) => {
              const on = form.kinds.has(kind);
              return (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleKind(kind)}
                  className={`mono text-[10px] px-1.5 py-0.5 rounded-sm border ${
                    on
                      ? 'border-accent-line bg-accent-dim text-accent'
                      : 'border-line text-txt-3 hover:border-accent-line hover:text-txt-1'
                  }`}
                >
                  {kind}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="mono text-[10px] text-txt-3 shrink-0">Min severity</span>
          <input
            type="range"
            min={1}
            max={5}
            step={1}
            value={form.min_severity}
            aria-label="Minimum severity"
            onChange={(e) => set('min_severity', Number(e.target.value))}
            className="flex-1 accent-accent"
          />
          <span className="mono text-[10px] text-txt-1 w-3 text-right">
            {form.min_severity}
          </span>
        </div>

        <div className="flex gap-1.5" role="radiogroup" aria-label="Delivery channel">
          {CHANNELS.map((ch) => {
            const on = form.channel === ch;
            return (
              <button
                key={ch}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => set('channel', ch)}
                className={`flex-1 mono text-[10px] px-2 py-1 rounded-sm border ${
                  on
                    ? 'border-accent-line bg-accent-dim text-txt-0'
                    : 'border-line text-txt-2 hover:border-accent-line hover:text-txt-1'
                }`}
              >
                {ch}
              </button>
            );
          })}
        </div>

        {form.channel !== 'inapp' && (
          <input
            type="text"
            value={form.sink_url}
            onChange={(e) => set('sink_url', e.target.value)}
            placeholder={
              form.channel === 'discord' ? 'Discord webhook URL' : 'Webhook URL'
            }
            className="w-full mono text-[10px] bg-bg-2 border border-line rounded-sm px-2 py-1 text-txt-1 placeholder:text-txt-3 focus:border-accent-line outline-none"
          />
        )}

        <div className="flex gap-1.5">
          <input
            type="text"
            value={form.icao24}
            onChange={(e) => set('icao24', e.target.value)}
            placeholder="icao24 (optional)"
            className="flex-1 mono text-[10px] bg-bg-2 border border-line rounded-sm px-2 py-1 text-txt-1 placeholder:text-txt-3 focus:border-accent-line outline-none"
          />
          <input
            type="text"
            value={form.mmsi}
            onChange={(e) => set('mmsi', e.target.value)}
            placeholder="mmsi (optional)"
            className="flex-1 mono text-[10px] bg-bg-2 border border-line rounded-sm px-2 py-1 text-txt-1 placeholder:text-txt-3 focus:border-accent-line outline-none"
          />
          <input
            type="text"
            value={form.callsign}
            onChange={(e) => set('callsign', e.target.value)}
            placeholder="callsign (optional)"
            className="flex-1 mono text-[10px] bg-bg-2 border border-line rounded-sm px-2 py-1 text-txt-1 placeholder:text-txt-3 focus:border-accent-line outline-none"
          />
        </div>

        <button
          type="button"
          disabled={busy}
          onClick={() => void submit()}
          className="w-full mono text-[10px] px-2 py-1.5 border border-accent-line rounded-sm text-accent hover:bg-accent/10 disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create alert rule'}
        </button>

        {error && <p className="mono text-[10px] text-alert-fg">{error}</p>}
        {createdId && (
          <p className="mono text-[10px] text-ok">Rule created (id {createdId}).</p>
        )}
      </div>
    </div>
  );
}
