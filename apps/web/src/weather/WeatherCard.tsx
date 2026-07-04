// Current-conditions read-out for a point, via the keyless Open-Meteo proxy.
// Used by the Weather right-rail tab and the Ground Recon panel.
import { useEffect, useState } from 'react';
import { Widget, KV, KVRow, MicroLabel } from '../shell/instruments.js';
import { apiFetch } from '../transport/http.js';

interface Weather {
  temperature_2m?: number;
  relative_humidity_2m?: number;
  wind_speed_10m?: number;
  wind_direction_10m?: number;
  cloud_cover?: number;
  pressure_msl?: number;
}

export function WeatherCard({ lat, lon }: { lat: number; lon: number }): JSX.Element {
  const [wx, setWx] = useState<Weather | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setWx(null);
    setErr(null);
    apiFetch(`/api/weather/openmeteo?lat=${lat}&lon=${lon}`)
      .then((r) => {
        if (r.status === 503) throw new Error('unavailable (commercial mode)');
        if (!r.ok) throw new Error(`weather ${r.status}`);
        return r.json();
      })
      .then((j: { current?: Weather }) => {
        if (!cancelled) setWx(j.current ?? null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : 'weather failed');
      });
    return () => {
      cancelled = true;
    };
  }, [lat, lon]);

  return (
    <Widget title="Weather" count={wx ? `${Math.round(wx.temperature_2m ?? 0)}°C` : '—'}>
      {err ? (
        <MicroLabel>{err}</MicroLabel>
      ) : wx ? (
        <KV>
          <KVRow k="Temp" v={`${Math.round(wx.temperature_2m ?? 0)} °C`} />
          <KVRow k="Wind" v={`${Math.round(wx.wind_speed_10m ?? 0)} km/h @ ${Math.round(wx.wind_direction_10m ?? 0)}°`} />
          <KVRow k="Cloud" v={`${Math.round(wx.cloud_cover ?? 0)} %`} />
          <KVRow k="Humidity" v={`${Math.round(wx.relative_humidity_2m ?? 0)} %`} />
          <KVRow k="Pressure" v={`${Math.round(wx.pressure_msl ?? 0)} hPa`} />
        </KV>
      ) : (
        <MicroLabel>loading…</MicroLabel>
      )}
    </Widget>
  );
}
