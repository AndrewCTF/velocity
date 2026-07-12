import { useEffect, useMemo, useRef, useState } from 'react';
import { useEvidence, type EvidenceObject } from './evidenceStore.js';
import { useSituations } from '../situations/situationStore.js';
import { apiFetch } from '../transport/http.js';
import { SectionLabel, Btn, MicroLabel, Widget, Badge } from '../shell/instruments.js';
import { toast } from '../shell/toast.js';

// Evidence locker (roadmap P1) — chain-of-custody capture. Preserve a URL, a
// file, or a moment of the live world as a content-addressed, hash-verified,
// custody-logged exhibit; verify a stored blob against its hash; download the
// original bytes; and attach an exhibit into a case (Situation). The "prove it"
// half of the investigation loop.

const METHOD_LABEL: Record<string, string> = {
  url: 'URL',
  file_upload: 'file',
  screenshot: 'screenshot',
  feed_freeze: 'live-freeze',
};

function fmtBytes(n?: number): string {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Auth'd image thumbnail: fetch the blob through apiFetch (carries the Bearer /
// X-API-Key) then objectURL it, so images render on a signed-in remote box too —
// a raw <img src=/api/evidence/…/blob> can't set the auth header and would 401.
function EvidenceThumb({ sha, alt }: { sha: string; alt: string }): JSX.Element | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    void (async () => {
      try {
        const r = await apiFetch(`/api/evidence/${encodeURIComponent(sha)}/blob`);
        if (!r.ok || cancelled) return;
        const blob = await r.blob();
        // Re-check AFTER the blob await: if we unmounted during it, cleanup
        // already ran (url was still null then), so allocate nothing — otherwise
        // the object URL would leak until page reload.
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      } catch {
        /* leave blank */
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [sha]);
  if (!src) return null;
  return (
    <img
      src={src}
      alt={alt}
      className="block max-h-40 w-auto rounded-sm border border-line-2"
      draggable={false}
    />
  );
}

function download(obj: EvidenceObject): void {
  // Fetch with auth, then trigger a browser download of the original bytes.
  const sha = obj.props.sha256;
  void (async () => {
    try {
      const r = await apiFetch(`/api/evidence/${encodeURIComponent(sha)}/blob`);
      if (!r.ok) {
        toast.error(r.status === 409 ? 'blob failed hash verification' : `download failed (${r.status})`);
        return;
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = obj.props.filename || `${sha.slice(0, 16)}`;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Defer the revoke: Firefox (and Safari with a detached anchor) abort the
      // save if the blob URL is revoked in the same tick as click(), before the
      // download stream has read it. Give it time, then reclaim the memory.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      toast.error('download failed (network)');
    }
  })();
}

function EvidenceRow({ obj }: { obj: EvidenceObject }): JSX.Element {
  const p = obj.props;
  const attach = useEvidence((s) => s.attach);
  const verify = useEvidence((s) => s.verify);
  const situations = useSituations((s) => s.situations);
  const [sit, setSit] = useState('');
  const [verified, setVerified] = useState<boolean | null>(null);

  const isImage = (p.media_type || '').startsWith('image/');

  const onVerify = async (): Promise<void> => {
    const ok = await verify(p.sha256);
    setVerified(ok);
    if (ok) toast.ok('hash verified — bytes unaltered');
    else toast.error('hash MISMATCH — blob altered or missing');
  };

  const onAttach = async (): Promise<void> => {
    if (!sit) return;
    const ok = await attach(p.sha256, sit);
    if (ok) toast.ok('attached to case');
    else toast.error('attach failed');
  };

  return (
    <li className="rounded-sm border border-line bg-bg-1/70 px-2.5 py-2 space-y-1.5">
      <div className="flex items-center gap-2">
        <Badge tone="neutral">{METHOD_LABEL[p.capture_method] ?? p.capture_method}</Badge>
        <span className="text-[11px] text-txt-0 truncate flex-1" title={p.title ?? ''}>
          {p.title || p.filename || p.sha256.slice(0, 16)}
        </span>
        {verified !== null && (
          <Badge tone={verified ? 'ok' : 'alert'}>{verified ? 'verified' : 'ALTERED'}</Badge>
        )}
      </div>
      {isImage && <EvidenceThumb sha={p.sha256} alt={p.title ?? 'evidence'} />}
      <div className="mono text-[10px] text-txt-3 break-all" title="SHA-256 (content address)">
        sha256 {p.sha256}
      </div>
      <div className="flex flex-wrap items-center gap-2 mono text-[10px] text-txt-3">
        <span>{fmtBytes(p.size_bytes)}</span>
        <span>{p.media_type}</span>
        {p.captured_at && <span>{p.captured_at}</span>}
        {p.source_url && (
          <a href={p.source_url} target="_blank" rel="noreferrer" className="text-accent truncate max-w-[200px]">
            {p.source_url}
          </a>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Btn size="sm" onClick={() => void onVerify()}>
          verify
        </Btn>
        <Btn size="sm" onClick={() => download(obj)}>
          download
        </Btn>
        <select
          value={sit}
          onChange={(e) => setSit(e.target.value)}
          className="mono text-[10px] bg-bg-2 border border-line-2 rounded-sm px-1.5 py-1 text-txt-1 max-w-[150px]"
          aria-label="attach to case"
        >
          <option value="">attach to case…</option>
          {situations.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <Btn size="sm" tone="accent" disabled={!sit} onClick={() => void onAttach()}>
          attach
        </Btn>
      </div>
    </li>
  );
}

export function EvidencePanel(): JSX.Element {
  const items = useEvidence((s) => s.items);
  const loading = useEvidence((s) => s.loading);
  const busy = useEvidence((s) => s.busy);
  const error = useEvidence((s) => s.error);
  const load = useEvidence((s) => s.load);
  const captureUrl = useEvidence((s) => s.captureUrl);
  const upload = useEvidence((s) => s.upload);
  const loadSituations = useSituations((s) => s.load);

  const [url, setUrl] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void load();
    void loadSituations();
  }, [load, loadSituations]);

  const onCaptureUrl = async (): Promise<void> => {
    const u = url.trim();
    if (!u) return;
    const obj = await captureUrl(u);
    if (obj) {
      setUrl('');
      toast.ok('URL captured & hashed');
    } else {
      toast.error('capture failed');
    }
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const f = e.target.files?.[0];
    if (!f) return;
    const obj = await upload(f);
    if (obj) toast.ok('file captured & hashed');
    else toast.error('upload failed');
    if (fileRef.current) fileRef.current.value = '';
  };

  const verifiedCount = useMemo(() => items.length, [items]);

  return (
    <div className="p-3 space-y-3">
      <Widget title="Preserve evidence">
        <p className="text-[11px] text-txt-3 mb-2">
          Every capture is content-addressed by SHA-256 at ingest and logged with an
          append-only chain of custody. The hash is the identity — a tampered copy
          can never masquerade as the original.
        </p>
        <div className="space-y-1.5">
          <MicroLabel>capture a URL (page/image/JSON)</MicroLabel>
          <div className="flex items-center gap-1.5">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void onCaptureUrl();
              }}
              placeholder="https://…"
              className="flex-1 mono text-[11px] bg-bg-2 border border-line-2 rounded-sm px-2 py-1.5 text-txt-1"
            />
            <Btn tone="accent" size="sm" disabled={busy || !url.trim()} onClick={() => void onCaptureUrl()}>
              capture
            </Btn>
          </div>
        </div>
        <div className="mt-2 space-y-1.5">
          <MicroLabel>upload a file / image / video</MicroLabel>
          <input
            ref={fileRef}
            type="file"
            onChange={(e) => void onFile(e)}
            disabled={busy}
            className="block w-full text-[11px] text-txt-2 file:mr-2 file:rounded-sm file:border file:border-line-2 file:bg-bg-2 file:px-2 file:py-1 file:text-txt-1 file:mono file:text-[10px]"
          />
        </div>
        {busy && <p className="text-[10px] text-txt-3 mt-1">capturing…</p>}
        {error && <p className="text-[10px] text-warn mt-1">{error}</p>}
        <p className="text-[10px] text-txt-3 mt-2">
          Screenshots and live-feed freezes are captured contextually from the globe
          Selection panel ("preserve as evidence").
        </p>
      </Widget>

      <div className="flex items-center gap-2">
        <SectionLabel title="Evidence" count={verifiedCount} className="flex-1" />
      </div>
      {loading && items.length === 0 && <p className="text-[11px] text-txt-3">loading…</p>}
      {!loading && items.length === 0 && (
        <p className="text-txt-3 text-[11px]">
          No evidence captured yet. Preserve a URL or file above, or use "preserve as
          evidence" from a selected entity.
        </p>
      )}
      <ul className="space-y-1.5">
        {items.map((obj) => (
          <EvidenceRow key={obj.id} obj={obj} />
        ))}
      </ul>
    </div>
  );
}
