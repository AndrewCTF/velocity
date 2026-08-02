# packages/shared — the web↔api contract

Repo-wide rules: `/CLAUDE.md`.

Small on purpose: `layer.ts`, `observation.ts`, `config.ts`, re-exported from
`index.ts` and consumed by the frontend as `@osint/shared`. Nothing here is
frontend-only — a change lands on both sides of the wire.

`Observation.t` is the field to be careful with. The backend vessel store is
last-write-wins (`ObservationStore.add_many` assigns `_latest[id]`
unconditionally), so its meaning is "age of the DATA", never "age of the
response". Loosening that here turns a cached read into a correctness bug that
steals the MMSI from a live source. Read the AIS section of
`apps/api/CLAUDE.md` before touching it.
