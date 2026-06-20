import { useEffect } from 'react';
import { useAlerts, useConnection } from '../state/stores.js';
import type { Alert } from '@osint/shared';
import { hasApiKey, withWsKey } from '../transport/http.js';

// Subscribes to /ws/alerts and pushes every incoming alert into useAlerts.
// Mounted once high in the tree so the connection survives re-renders.
// Also publishes ws lifecycle to useConnection so the CommandBar can show
// a live/down pill — operators need to know if the silence is "no alerts"
// or "we're disconnected".
export function AlertSubscriber(): null {
  const push = useAlerts((s) => s.push);
  const setWs = useConnection((s) => s.setWs);
  useEffect(() => {
    // Keyless mode: the backend's require_ws_key rejects before the upgrade
    // completes, so the socket "closed before connection established" and the
    // onclose/onerror backoff loop spams the console. Skip the WebSocket
    // entirely when there's no credential — there's nothing to connect to.
    if (!hasApiKey()) {
      setWs('closed');
      return () => {};
    }

    let ws: WebSocket | null = null;
    let backoff = 1000;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      setWs('connecting');
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(withWsKey(`${proto}://${window.location.host}/ws/alerts`));
      ws.onopen = () => {
        backoff = 1000;
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
  }, [push, setWs]);
  return null;
}
