import { useEffect } from 'react';
import { useAlerts, useConnection } from '../state/stores.js';
import type { Alert } from '@osint/shared';
import { apiFetch, hasStaticApiKey, withWsKey } from '../transport/http.js';
import { useAuth } from '../auth/AuthContext.js';

// How often we re-POST /api/alerts/watch-session. The backend geofence
// evaluator (intel.watch) reads the caller's RLS-scoped rules with whatever
// Supabase token this session last handed over; tokens expire (~1 h), so a stale
// token's reads 401 and that session goes quiet. Re-registering well inside the
// token lifetime refreshes the stored token (register_session is idempotent on
// user_id) so the evaluator keeps reading. 4 min is comfortably under the
// default access-token TTL.
const WATCH_SESSION_REFRESH_MS = 4 * 60 * 1000;

// Subscribes to /ws/alerts and pushes every incoming alert into useAlerts.
// Mounted once high in the tree so the connection survives re-renders.
// Also publishes ws lifecycle to useConnection so the CommandBar can show
// a live/down pill — operators need to know if the silence is "no alerts"
// or "we're disconnected".
export function AlertSubscriber(): null {
  const push = useAlerts((s) => s.push);
  const setWs = useConnection((s) => s.setWs);
  const { session, loading } = useAuth();
  useEffect(() => {
    // Auth still resolving (first getSession in flight): don't declare the
    // socket down yet — that's the "/ws/alerts shows down on mount" bug. Hold
    // at 'connecting'; this effect re-runs once `loading` flips and reconnects
    // with a settled credential. (Without this, mounting before the session
    // resolved showed a permanent "down" pill even for logged-in operators.)
    if (loading) {
      setWs('connecting');
      return () => {};
    }
    // Settled and keyless: an open-mode backend (ALLOW_UNAUTHENTICATED) accepts
    // the upgrade without a key, an enforcing one rejects it before it opens.
    // We can't tell which we're on from here, so try ONCE: adopt the socket if
    // it opens, and if it dies before ever opening, stay closed with no retry
    // loop (the old always-skip showed a permanent "LINK down" pill on every
    // open-mode box; the pre-existing concern — onclose/onerror backoff spamming
    // the console against an enforcing backend — only applies to retries).
    const keylessProbe = !session && !hasStaticApiKey();

    let ws: WebSocket | null = null;
    let backoff = 1000;
    let stopped = false;
    let everOpened = false;

    const connect = () => {
      if (stopped) return;
      setWs('connecting');
      ws = new WebSocket(withWsKey('/ws/alerts'));
      ws.onopen = () => {
        backoff = 1000;
        everOpened = true;
        setWs('open');
      };
      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data as string);
          if (data && (data.kind === 'heartbeat' || !data.id)) return;
          push(data as Alert);
        } catch {
          /* drop bad frame */
        }
      };
      ws.onclose = () => {
        if (stopped) return;
        setWs('closed');
        // Keyless probe rejected before it ever opened: enforcing backend,
        // nothing to reconnect to. One attempt, no backoff spam.
        if (keylessProbe && !everOpened) {
          stopped = true;
          return;
        }
        window.setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 15_000);
      };
      ws.onerror = () => {
        setWs('closed');
        ws?.close();
      };
    };
    connect();
    return () => {
      stopped = true;
      ws?.close();
    };
    // Depend on the token string, not the `session` object: supabase emits a
    // fresh session identity on TOKEN_REFRESHED / refocus, which would tear
    // down and reconnect /ws/alerts hourly and on every window focus. The
    // socket only cares whether we're authed (token present) — the specific
    // token is carried by withWsKey at connect time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [push, setWs, session?.access_token, loading]);

  // Register this signed-in session with the backend geofence evaluator so its
  // background loop has a token for the caller's per-user RLS reads. Gated on a
  // real Supabase `session`: current_user (the route dependency) needs a valid
  // token with a `sub`, which a static API key alone does not carry — so the
  // keyless / static-key case never POSTs (it would just 401). Re-POSTs on an
  // interval to keep the stored token fresh, and DELETEs on unmount/sign-out.
  useEffect(() => {
    if (loading || !session) return () => {};
    let cancelled = false;

    const register = () => {
      // Fire-and-forget: a failed registration just means the evaluator won't
      // read this user's rules until the next tick — it must not break alerts.
      void apiFetch('/api/alerts/watch-session', { method: 'POST' }).catch(
        () => {},
      );
    };

    register();
    const timer = window.setInterval(register, WATCH_SESSION_REFRESH_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      // Best-effort de-registration. keepalive lets it survive a tab close.
      void apiFetch('/api/alerts/watch-session', {
        method: 'DELETE',
        keepalive: true,
      }).catch(() => {});
      void cancelled;
    };
  }, [session, loading]);

  return null;
}
