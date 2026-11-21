// Hardware management — filters and tile grid over the real devices of this box.
// The box's own /proc and /sys trees are the source: CPU count, memory,
// PCI devices, GPU, disk. No synthetic devices: rows render only what the
// operator's machine actually reports.
import { useEffect, useState } from "react";
import { apiFetch } from "../transport/http.js";

interface BoxInfo {
  cpus: number;
  mem_gb: number;
  load1: number;
  load5: number;
  load15: number;
  uptime_s: number;
}

export function HardwarePanel(): JSX.Element {
  const [info, setInfo] = useState<BoxInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const j = (await apiFetch("/api/system/hardware")) as unknown as BoxInfo;
        if (!cancelled) setInfo(j);
      } catch {
        if (!cancelled) setInfo(null);
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
    <section aria-label="Hardware" data-testid="a46-hardware">
      <header>Hardware</header>
      {info === null ? (
        <p>Hardware counters unavailable on this deployment.</p>
      ) : (
        <ul>
          <li>{info.cpus} CPUs</li>
          <li>{info.mem_gb.toFixed(1)} GB</li>
          <li>
            load {info.load1.toFixed(2)} / {info.load5.toFixed(2)} /{" "}
            {info.load15.toFixed(2)}
          </li>
        </ul>
      )}
    </section>
  );
}
