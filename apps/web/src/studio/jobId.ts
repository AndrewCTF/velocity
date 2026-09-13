// Recon job ids are hex (apps/api recon.py mints them and validates the same
// shape). Anything else from ?job= or a response body never reaches an API path
// (ASVS V1.2.2): `../../admin` would otherwise walk the authed request elsewhere.
const JOB_ID = /^[0-9a-f]{6,32}$/;

export function validJobId(raw: unknown): string | null {
  return typeof raw === 'string' && JOB_ID.test(raw) ? raw : null;
}
