// Client for the thin backend reasoning route. The browser computes the sim;
// this asks the model (DeepSeek reason tier, via /api/sim/reason) to narrate the
// numbers. Returns null on transport failure; the route itself returns
// { ok:false, error } when the model is unavailable.

import { apiFetch } from '../transport/http.js';

export interface SimOutcome {
  description: string;
  probability: number;
  rationale: string;
}

export interface SimReasonResult {
  ok: boolean;
  error?: string;
  model?: string | null;
  backend?: string | null;
  assessment?: string;
  outcomes?: SimOutcome[];
  casualties_estimate?: string;
  economic_impact?: string;
  escalation_risk?: string;
  second_order?: string[];
  assumptions?: string[];
  confidence?: string;
  raw?: string;
}

export async function reasonSim(
  scenario: unknown,
  outcome: unknown,
  question?: string,
  signal?: AbortSignal,
): Promise<SimReasonResult | null> {
  const r = await apiFetch('/api/sim/reason', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario, outcome, ...(question ? { question } : {}) }),
    ...(signal ? { signal } : {}),
  });
  if (!r.ok) return null;
  return (await r.json()) as SimReasonResult;
}
