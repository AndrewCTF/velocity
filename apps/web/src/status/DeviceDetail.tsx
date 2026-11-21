// Device detail — the real CPU of this box (temperature from k10temp, load
// from /proc/loadavg). Renders only what the box reports; unavailable fields
// stay out rather than being estimated.
import { useEffect, useState } from "react";
import { apiFetch } from "../transport/http.js";

interface CpuDetail {
  load1: number;
  load5: number;
  load15: number;
  temp_c: number | null;
}

export function DeviceDetail(): JSX.Element {
  const [cpu, setCpu] = useState<CpuDetail | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const j = (await apiFetch("/api/system/cpu")) as unknown as CpuDetail;
        if (!cancelled) setCpu(j);
      } catch {
        if (!cancelled) setCpu(null);
      }
    };
    void load();
    const id = window.setInterval(load, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  return (
    <section aria-label="Device detail" data-testid="a47-device">
      <header>CPU</header>
      {cpu === null ? (
        <p>CPU counters unavailable on this deployment.</p>
      ) : (
        <ul>
          <li>
            load {cpu.load1.toFixed(2)} / {cpu.load5.toFixed(2)} /{" "}
            {cpu.load15.toFixed(2)}
          </li>
          <li>{cpu.temp_c === null ? "temp unavailable" : `${cpu.temp_c}°C`}</li>
        </ul>
      )}
    </section>
  );
}
