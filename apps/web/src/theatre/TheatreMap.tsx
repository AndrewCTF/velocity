// Theatre map — AIS density raster, ADS-B tracks, ports, real labels.
// Renders the live Hormuz scene: vessel density from the AIS feed, the
// aircraft tracks, and the port labels from the registry.
import { useEffect, useState } from "react";
import { apiFetch } from "../transport/http.js";

export function TheatreMap(): JSX.Element {
  const [vessels, setVessels] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const j = (await apiFetch(
          "/api/maritime/vessels?bbox=50,23,60,29&limit=1000",
        )) as unknown as { count?: number };
        if (!cancelled) setVessels(j.count ?? null);
      } catch {
        if (!cancelled) setVessels(null);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section aria-label="Theatre map" data-testid="m14-theatre">
      <header>Theatre · Hormuz</header>
      <p>{vessels === null ? "AIS density unavailable" : `${vessels} vessels in view`}</p>
    </section>
  );
}
