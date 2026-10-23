import { create } from "zustand";
import { apiFetch } from "../../../transport/http.js";

// Stories and countries for the document pins and the dossier panel.
// GET /api/news/edition (clustered, multi-source stories with ISO3 country
// tags) and GET /api/country/list (ISO3 -> name, region). Both fetched once
// per page load; the pins place a story at its country's Natural Earth label
// point, so a pin is country-level, never a claimed incident location.

export interface Story {
  id: string;
  title: string;
  category?: string;
  neutral_summary?: string;
  neutral_rewrite?: string;
  verified_facts?: unknown[];
  attributed_claims?: unknown[];
  countries?: string[];
  corroboration?: { source_count?: number; sources?: string[] };
  proofs?: { source?: string; url?: string; published?: string }[];
}

export interface Country {
  name: string;
  iso3: string;
  region?: string;
  sub_region?: string;
}

let editionP: Promise<Story[] | string> | null = null;
export function edition(): Promise<Story[] | string> {
  editionP ??= apiFetch("/api/news/edition")
    .then(async (r) =>
      r.ok
        ? (((await r.json()) as { stories?: Story[] }).stories ?? [])
        : `News edition unavailable (HTTP ${r.status})`,
    )
    .catch(() => "News edition unavailable");
  return editionP;
}

let countriesP: Promise<Map<string, Country>> | null = null;
export function countries(): Promise<Map<string, Country>> {
  countriesP ??= apiFetch("/api/country/list")
    .then(async (r) =>
      r.ok ? ((await r.json()) as Country[]) : ([] as Country[]),
    )
    .then((l) => new Map(l.map((c) => [c.iso3, c])))
    .catch(() => new Map<string, Country>());
  return countriesP;
}

export const useDossier = create<{
  story: Story | null;
  open: (s: Story) => void;
  close: () => void;
}>((set) => ({
  story: null,
  open: (story) => set({ story }),
  close: () => set({ story: null }),
}));

/** The dossier body: the story's own text fields, in reading order. */
export function storyParagraphs(s: Story): string[] {
  const t = (v: unknown): string | null =>
    typeof v === "string"
      ? v
      : v && typeof v === "object" && "text" in v && typeof v.text === "string"
        ? v.text
        : v &&
            typeof v === "object" &&
            "claim" in v &&
            typeof v.claim === "string"
          ? v.claim
          : null;
  return [
    s.neutral_summary,
    s.neutral_rewrite,
    ...(s.verified_facts ?? []).map(t),
    ...(s.attributed_claims ?? []).map(t),
  ].filter((x): x is string => typeof x === "string" && x.trim().length > 0);
}

/** Split text into plain and chip runs for the given names (longest first,
 *  whole-word, case-insensitive). */
export function chipRuns(
  text: string,
  names: string[],
): { t: string; chip: string | null }[] {
  const sorted = [...new Set(names.filter((n) => n.trim().length > 1))].sort(
    (a, b) => b.length - a.length,
  );
  if (!sorted.length) return [{ t: text, chip: null }];
  const esc = sorted.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`\\b(${esc.join("|")})\\b`, "gi");
  const out: { t: string; chip: string | null }[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ t: text.slice(last, i), chip: null });
    const hit =
      sorted.find((n) => n.toLowerCase() === m[0].toLowerCase()) ?? m[0];
    out.push({ t: m[0], chip: hit });
    last = i + m[0].length;
  }
  if (last < text.length) out.push({ t: text.slice(last), chip: null });
  return out;
}
