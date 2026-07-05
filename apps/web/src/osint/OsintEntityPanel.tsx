// Selection panel for positionless digital-OSINT entities (domain: / ip: / …).
// EntityPanel builds its snapshot from a live Cesium entity; these ids have none,
// so — exactly like SituationPanel — they get their own panel. Cards self-fetch
// the keyless connector endpoints (/api/osint/*) and null out when empty, the
// same pattern as ConnectionsCard.

import { type CSSProperties, useEffect, useState } from 'react';
import { apiFetch } from '../transport/http.js';
import { Widget, SectionLabel } from '../shell/instruments.js';
import { useInvestigation } from '../graph/investigationStore.js';

function targetOf(id: string): string {
  const i = id.indexOf(':');
  return i < 0 ? id : id.slice(i + 1);
}

// Small self-fetch hook: GET /api/osint/<endpoint>?target=… once per target.
function useOsint<T>(endpoint: string, target: string): { data: T | null; loading: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setData(null);
    setLoading(true);
    const aborter = new AbortController();
    apiFetch(`/api/osint/${endpoint}?target=${encodeURIComponent(target)}`, { signal: aborter.signal })
      .then((r) => (r.ok ? (r.json() as Promise<T>) : null))
      .then((j) => setData(j))
      .catch(() => undefined)
      .finally(() => setLoading(false));
    return () => aborter.abort();
  }, [endpoint, target]);
  return { data, loading };
}

function Row({ k, v }: { k: string; v: React.ReactNode }): JSX.Element {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11, padding: '2px 0' }}>
      <span style={{ color: 'var(--txt-3)' }}>{k}</span>
      <span style={{ color: 'var(--txt-1)', textAlign: 'right', wordBreak: 'break-all' }}>{v}</span>
    </div>
  );
}

// ── cards ────────────────────────────────────────────────────────────────────

interface Whois {
  registrar?: string; created?: string; expires?: string; registrant_email?: string;
  nameservers?: string[]; status?: string[]; name?: string; cidr?: string; country?: string; note?: string;
}

function WhoisCard({ target }: { target: string }): JSX.Element | null {
  const { data } = useOsint<Whois>('whois', target);
  if (!data || data.note) return null;
  const has = data.registrar || data.created || data.name || data.cidr;
  if (!has) return null;
  return (
    <Widget title="WHOIS / RDAP">
      {data.registrar && <Row k="registrar" v={data.registrar} />}
      {data.name && <Row k="net name" v={data.name} />}
      {data.country && <Row k="country" v={data.country} />}
      {data.cidr && <Row k="range" v={data.cidr} />}
      {data.created && <Row k="created" v={data.created.slice(0, 10)} />}
      {data.expires && <Row k="expires" v={data.expires.slice(0, 10)} />}
      {data.registrant_email && <Row k="reg. email" v={data.registrant_email} />}
      {data.nameservers?.length ? <Row k="nameservers" v={data.nameservers.join(', ')} /> : null}
    </Widget>
  );
}

interface Dns { records?: Record<string, string[]>; ips?: string[] }

function DnsCard({ target }: { target: string }): JSX.Element | null {
  const { data } = useOsint<Dns>('dns', target);
  const rec = data?.records;
  if (!rec || Object.keys(rec).length === 0) return null;
  return (
    <Widget title="DNS" count={data?.ips?.length ?? 0}>
      {Object.entries(rec).map(([type, vals]) => (
        <Row key={type} k={type} v={vals.slice(0, 6).join(', ')} />
      ))}
    </Widget>
  );
}

interface Certs { subdomains?: string[]; subdomain_count?: number; truncated?: boolean; note?: string }

function InfraCard({ target }: { target: string }): JSX.Element | null {
  const { data } = useOsint<Certs>('certs', target);
  if (!data || !data.subdomains?.length) return null;
  return (
    <Widget title="Subdomains (crt.sh)" count={data.subdomain_count ?? 0}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {data.subdomains.slice(0, 40).map((s) => (
          <span
            key={s}
            style={{ fontSize: 10, color: 'var(--txt-2)', background: 'rgba(255,255,255,0.05)', padding: '1px 5px', borderRadius: 3 }}
          >
            {s}
          </span>
        ))}
      </div>
      {data.truncated && (
        <div style={{ fontSize: 10, color: 'var(--txt-3)', marginTop: 4 }}>
          showing 40 of {data.subdomain_count}
        </div>
      )}
    </Widget>
  );
}

interface IpGeo { city?: string; country?: string; org?: string; asn?: string; lat?: number; lon?: number; reverse?: string; note?: string }

function IpGeoCard({ target }: { target: string }): JSX.Element | null {
  const { data } = useOsint<IpGeo>('ip', target);
  if (!data || data.note) return null;
  return (
    <Widget title="IP geolocation">
      {data.org && <Row k="org" v={data.org} />}
      {data.asn && <Row k="ASN" v={data.asn} />}
      {(data.city || data.country) && <Row k="location" v={[data.city, data.country].filter(Boolean).join(', ')} />}
      {data.reverse && <Row k="reverse" v={data.reverse} />}
      {data.lat != null && data.lon != null && <Row k="coords" v={`${data.lat}, ${data.lon}`} />}
    </Widget>
  );
}

interface Shodan { ports?: number[]; hostnames?: string[]; tags?: string[]; vulns?: string[] }

function ShodanCard({ target }: { target: string }): JSX.Element | null {
  const { data } = useOsint<Shodan>('shodan', target);
  if (!data || (!data.ports?.length && !data.vulns?.length)) return null;
  return (
    <Widget title="Exposure (Shodan InternetDB)" count={data.ports?.length ?? 0}>
      {data.ports?.length ? <Row k="open ports" v={data.ports.join(', ')} /> : null}
      {data.hostnames?.length ? <Row k="hostnames" v={data.hostnames.join(', ')} /> : null}
      {data.tags?.length ? <Row k="tags" v={data.tags.join(', ')} /> : null}
      {data.vulns?.length ? (
        <Row k="CVEs" v={<span style={{ color: 'var(--alert)' }}>{data.vulns.slice(0, 12).join(', ')}</span>} />
      ) : null}
    </Widget>
  );
}

interface Threat { pulse_count?: number; pulses?: string[]; tags?: string[] }

function ThreatCard({ target }: { target: string }): JSX.Element | null {
  const { data } = useOsint<Threat>('threat', target);
  if (!data || !data.pulse_count) return null;
  return (
    <Widget title="Threat-intel (AlienVault OTX)" count={data.pulse_count ?? 0}>
      {data.tags?.length ? <Row k="tags" v={<span style={{ color: 'var(--alert)' }}>{data.tags.join(', ')}</span>} /> : null}
      {data.pulses?.slice(0, 8).map((p) => (
        <div key={p} style={{ fontSize: 11, color: 'var(--txt-2)', padding: '1px 0' }}>• {p}</div>
      ))}
    </Widget>
  );
}

interface Github {
  found?: boolean; name?: string; company?: string; location?: string; email?: string;
  bio?: string; public_repos?: number; followers?: number; created_at?: string; profile_url?: string;
}

function GithubCard({ target }: { target: string }): JSX.Element | null {
  const { data } = useOsint<Github>('github', target);
  if (!data || !data.found) return null;
  return (
    <Widget title="GitHub" count={data.public_repos ?? 0}>
      {data.name && <Row k="name" v={data.name} />}
      {data.company && <Row k="company" v={data.company} />}
      {data.location && <Row k="location" v={data.location} />}
      {data.email && <Row k="email" v={data.email} />}
      {data.bio && <Row k="bio" v={data.bio} />}
      {data.followers != null && <Row k="followers" v={data.followers} />}
      {data.created_at && <Row k="since" v={data.created_at.slice(0, 10)} />}
      {data.profile_url && <Row k="profile" v={data.profile_url} />}
    </Widget>
  );
}

interface Gitlab { found?: boolean; name?: string; profile_url?: string }

function GitlabCard({ target }: { target: string }): JSX.Element | null {
  const { data } = useOsint<Gitlab>('gitlab', target);
  if (!data || !data.found) return null;
  return (
    <Widget title="GitLab">
      {data.name && <Row k="name" v={data.name} />}
      {data.profile_url && <Row k="profile" v={data.profile_url} />}
    </Widget>
  );
}

interface UsernameSites { present_on?: string[] }

function UsernameSitesCard({ target }: { target: string }): JSX.Element | null {
  const { data } = useOsint<UsernameSites>('username', target);
  if (!data || !data.present_on?.length) return null;
  return (
    <Widget title="Handle presence" count={data.present_on.length}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {data.present_on.map((s) => (
          <span key={s} style={{ fontSize: 10, color: 'var(--txt-2)', background: 'rgba(255,255,255,0.05)', padding: '1px 5px', borderRadius: 3 }}>
            {s}
          </span>
        ))}
      </div>
    </Widget>
  );
}

interface Gravatar {
  found?: boolean; display_name?: string; about?: string; location?: string; profile_url?: string;
  accounts?: { service?: string; url?: string; username?: string }[];
}

function GravatarCard({ target }: { target: string }): JSX.Element | null {
  const { data } = useOsint<Gravatar>('gravatar', target);
  if (!data || !data.found) return null;
  return (
    <Widget title="Gravatar profile" count={data.accounts?.length ?? 0}>
      {data.display_name && <Row k="name" v={data.display_name} />}
      {data.location && <Row k="location" v={data.location} />}
      {data.about && <Row k="about" v={data.about} />}
      {data.accounts?.length ? (
        <Row k="accounts" v={data.accounts.map((a) => a.service || a.username).filter(Boolean).join(', ')} />
      ) : null}
      {data.profile_url && <Row k="profile" v={data.profile_url} />}
    </Widget>
  );
}

interface Hibp { checked?: boolean; breach_count?: number; breaches?: { name?: string }[]; note?: string }

function HibpCard({ target }: { target: string }): JSX.Element | null {
  const { data } = useOsint<Hibp>('hibp', target);
  if (!data) return null;
  if (!data.checked) {
    return data.note ? (
      <Widget title="Breaches (HIBP)">
        <div style={{ fontSize: 10, color: 'var(--txt-3)' }}>{data.note}</div>
      </Widget>
    ) : null;
  }
  if (!data.breach_count) return null;
  return (
    <Widget title="Breaches (HIBP)" count={data.breach_count ?? 0}>
      <Row k="breaches" v={<span style={{ color: 'var(--alert)' }}>{data.breaches?.map((b) => b.name).join(', ')}</span>} />
    </Widget>
  );
}

// ── panel ─────────────────────────────────────────────────────────────────────

export function OsintEntityPanel({ id }: { id: string }): JSX.Element {
  const kind = id.split(':', 1)[0] ?? '';
  const target = targetOf(id);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16 }}>
      <div>
        <SectionLabel title={kind.toUpperCase()} />
        <div style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 13, color: 'var(--txt-0)', wordBreak: 'break-all', marginTop: 4 }}>
          {target}
        </div>
      </div>
      <button
        onClick={() => useInvestigation.getState().searchAround(id)}
        style={btnStyle}
      >
        ⊹ Search around
      </button>

      {kind === 'domain' && (
        <>
          <WhoisCard target={target} />
          <DnsCard target={target} />
          <InfraCard target={target} />
          <ThreatCard target={target} />
        </>
      )}
      {kind === 'ip' && (
        <>
          <WhoisCard target={target} />
          <IpGeoCard target={target} />
          <ShodanCard target={target} />
          <ThreatCard target={target} />
        </>
      )}
      {kind === 'username' && (
        <>
          <GithubCard target={target} />
          <GitlabCard target={target} />
          <UsernameSitesCard target={target} />
        </>
      )}
      {kind === 'email' && (
        <>
          <GravatarCard target={target} />
          <HibpCard target={target} />
          <ThreatCard target={target} />
        </>
      )}
      {kind !== 'domain' && kind !== 'ip' && kind !== 'username' && kind !== 'email' && (
        <ThreatCard target={target} />
      )}
    </div>
  );
}

const btnStyle: CSSProperties = {
  background: 'rgba(255,255,255,0.08)',
  border: '1px solid rgba(255,255,255,0.2)',
  borderRadius: 4,
  color: 'inherit',
  padding: '6px 10px',
  cursor: 'pointer',
  fontSize: 12,
  alignSelf: 'flex-start',
};
