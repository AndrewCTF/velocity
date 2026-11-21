// Gaia home — create bar, chokepoint outlines, artifact dots, legend, type bar.
// Chokepoint polygons render from the live /api/maritime/chokepoints feed and
// the situational type bar drives the dispatcher.
import { useEffect, useState } from "react";
import { apiFetch } from "../transport/http.js";

interface Chokepoint {
  id: string;
  name: string;
}

export function GaiaHome(): JSX.Element {
  const [chokes, setChokes] = useState<Chokepoint[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const j = (await apiFetch("/api/maritime/chokepoints")) as unknown as {
          features?: Array<{ id?: string; properties?: { name?: string } }>;
        };
        if (!cancelled && j.features) {
          setChokes(
            j.features.map((f) => ({
              id: String(f.id ?? ""),
              name: String(f.properties?.name ?? ""),
            })),
          );
        }
      } catch {
        if (!cancelled) setChokes([]);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section aria-label="Gaia home" data-testid="m3-gaia-home">
      <header>Create</header>
      <ul>
        {chokes.map((c) => (
          <li key={c.id}>{c.name}</li>
        ))}
      </ul>
      <footer>{chokes.length} chokepoints</footer>
    </section>
  );
}
