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

// Small self-fetch hook: GET /api/osint/<endpoint>?<param>=… once per value.
function useOsint<T>(endpoint: string, value: string, param: string = 'target'): { data: T | null; loading: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setData(null);
    setLoading(true);
    const aborter = new AbortController();
    apiFetch(`/api/osint/${endpoint}?${param}=${encodeURIComponent(value)}`, { signal: aborter.signal })
      .then((r) => (r.ok ? (r.json() as Promise<T>) : null))
      .then((j) => setData(j))
      .catch(() => undefined)
      .finally(() => setLoading(false));
    return () => aborter.abort();
  }, [endpoint, value, param]);
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

interface Wayback { subdomains?: string[]; subdomain_count?: number; url_count?: number; note?: string }

function WaybackCard({ target }: { target: string }): JSX.Element | null {
  const { data } = useOsint<Wayback>('wayback', target);
  if (!data || data.note || !data.subdomains?.length) return null;
  return (
    <Widget title="Wayback Machine" count={data.url_count ?? data.subdomain_count ?? 0}>
      <Row k="subdomains seen" v={data.subdomain_count ?? data.subdomains.length} />
      <Row k="sample" v={data.subdomains.slice(0, 8).join(', ')} />
    </Widget>
  );
}

interface UrlscanScan { url?: string; ip?: string; asn?: string; time?: string }
interface Urlscan { scans?: UrlscanScan[]; ips?: string[]; count?: number; note?: string }

function UrlscanCard({ target }: { target: string }): JSX.Element | null {
  const { data } = useOsint<Urlscan>('urlscan', target);
  if (!data || data.note || !data.scans?.length) return null;
  return (
    <Widget title="urlscan.io" count={data.count ?? data.scans.length}>
      {data.ips?.length ? <Row k="ips" v={data.ips.slice(0, 6).join(', ')} /> : null}
      {data.scans.slice(0, 5).map((s, i) => (
        <div key={s.url ?? i} style={{ fontSize: 11, color: 'var(--txt-2)', padding: '1px 0' }}>• {s.url}</div>
      ))}
    </Widget>
  );
}

interface BgpPrefix { prefix?: string; name?: string }
interface BgpAsn { asn?: number | string; name?: string; country?: string }
interface Bgp { prefixes?: BgpPrefix[]; asns?: BgpAsn[]; note?: string }

function BgpCard({ target }: { target: string }): JSX.Element | null {
  const { data } = useOsint<Bgp>('bgpview-ip', target, 'ip');
  if (!data || data.note || (!data.prefixes?.length && !data.asns?.length)) return null;
  return (
    <Widget title="BGP (bgpview)" count={data.prefixes?.length ?? 0}>
      {data.asns?.length ? (
        <Row k="ASNs" v={data.asns.map((a) => `${a.asn ?? ''} ${a.name ?? ''}`.trim()).join(', ')} />
      ) : null}
      {data.prefixes?.length ? <Row k="prefixes" v={data.prefixes.slice(0, 6).map((p) => p.prefix).join(', ')} /> : null}
    </Widget>
  );
}

interface Greynoise { classification?: string; name?: string; noise?: boolean; tags?: string[]; last_seen?: string; note?: string }

function GreynoiseCard({ target }: { target: string }): JSX.Element | null {
  const { data } = useOsint<Greynoise>('greynoise', target, 'ip');
  if (!data || data.note || !data.classification) return null;
  const malicious = data.classification === 'malicious';
  return (
    <Widget title="GreyNoise">
      <Row k="classification" v={<span style={{ color: malicious ? 'var(--alert)' : 'var(--txt-1)' }}>{data.classification}</span>} />
      {data.name && <Row k="actor" v={data.name} />}
      {data.tags?.length ? <Row k="tags" v={data.tags.join(', ')} /> : null}
      {data.last_seen && <Row k="last seen" v={data.last_seen} />}
    </Widget>
  );
}

interface TorExit { is_tor_exit?: boolean; nickname?: string; country?: string; note?: string }

function TorExitCard({ target }: { target: string }): JSX.Element | null {
  const { data } = useOsint<TorExit>('onionoo', target, 'ip');
  if (!data || data.note || !data.is_tor_exit) return null;
  return (
    <Widget title="Tor exit node">
      {data.nickname && <Row k="nickname" v={data.nickname} />}
      {data.country && <Row k="country" v={data.country} />}
    </Widget>
  );
}

interface Feodo { listed?: boolean; malware?: string; first_seen?: string; note?: string }

function FeodoCard({ target }: { target: string }): JSX.Element | null {
  const { data } = useOsint<Feodo>('feodo', target, 'ip');
  if (!data || data.note || !data.listed) return null;
  return (
    <Widget title="Feodo Tracker">
      <Row k="malware" v={<span style={{ color: 'var(--alert)' }}>{data.malware ?? 'listed'}</span>} />
      {data.first_seen && <Row k="first seen" v={data.first_seen} />}
    </Widget>
  );
}

interface EmailRep { reputation?: string; suspicious?: boolean; malicious?: boolean; breach?: boolean; profiles?: string[]; note?: string }

function EmailRepCard({ target }: { target: string }): JSX.Element | null {
  const { data } = useOsint<EmailRep>('emailrep', target);
  if (!data || data.note || !data.reputation) return null;
  return (
    <Widget title="EmailRep">
      <Row k="reputation" v={<span style={{ color: data.malicious ? 'var(--alert)' : 'var(--txt-1)' }}>{data.reputation}</span>} />
      {data.suspicious != null && <Row k="suspicious" v={String(data.suspicious)} />}
      {data.breach != null && <Row k="breach" v={String(data.breach)} />}
      {data.profiles?.length ? <Row k="profiles" v={data.profiles.join(', ')} /> : null}
    </Widget>
  );
}

interface Libravatar { has_avatar?: boolean; note?: string }

function LibravatarCard({ target }: { target: string }): JSX.Element | null {
  const { data } = useOsint<Libravatar>('libravatar', target);
  if (!data || data.note || !data.has_avatar) return null;
  return (
    <Widget title="Libravatar">
      <Row k="avatar" v="present" />
    </Widget>
  );
}

interface RedditPost { subreddit?: string; title?: string; created?: string }
interface Reddit { submissions?: RedditPost[]; subreddits?: string[]; count?: number; note?: string }

function RedditCard({ target }: { target: string }): JSX.Element | null {
  const { data } = useOsint<Reddit>('pullpush', target);
  if (!data || data.note || !data.submissions?.length) return null;
  return (
    <Widget title="Reddit (pullpush)" count={data.count ?? data.submissions.length}>
      {data.subreddits?.length ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {data.subreddits.slice(0, 20).map((s) => (
            <span key={s} style={{ fontSize: 10, color: 'var(--txt-2)', background: 'rgba(255,255,255,0.05)', padding: '1px 5px', borderRadius: 3 }}>
              {s}
            </span>
          ))}
        </div>
      ) : null}
    </Widget>
  );
}

interface UrlhausUrl { threat?: string; tags?: string[]; payloads?: string[]; status?: string; note?: string }

function UrlhausUrlCard({ target }: { target: string }): JSX.Element | null {
  const { data } = useOsint<UrlhausUrl>('urlhaus-url', target);
  if (!data || data.note || !data.threat) return null;
  return (
    <Widget title="URLhaus">
      <Row k="threat" v={<span style={{ color: 'var(--alert)' }}>{data.threat}</span>} />
      {data.status && <Row k="status" v={data.status} />}
      {data.tags?.length ? <Row k="tags" v={data.tags.join(', ')} /> : null}
      {data.payloads?.length ? <Row k="payloads" v={data.payloads.slice(0, 6).join(', ')} /> : null}
    </Widget>
  );
}

interface Phishstats { score?: number; tld?: string; ip?: string; count?: number; note?: string }

function PhishstatsCard({ target }: { target: string }): JSX.Element | null {
  const { data } = useOsint<Phishstats>('phishstats', target);
  if (!data || data.note || !data.count) return null;
  return (
    <Widget title="PhishStats" count={data.count ?? 0}>
      {data.score != null && <Row k="score" v={<span style={{ color: 'var(--alert)' }}>{data.score}</span>} />}
      {data.ip && <Row k="ip" v={data.ip} />}
      {data.tld && <Row k="tld" v={data.tld} />}
    </Widget>
  );
}

interface MalwareBazaar { family?: string; file_type?: string; tags?: string[]; first_seen?: string; signature?: string; note?: string }

function MalwareBazaarCard({ target }: { target: string }): JSX.Element | null {
  const { data } = useOsint<MalwareBazaar>('malwarebazaar', target, 'hash');
  if (!data || data.note || !data.family) return null;
  return (
    <Widget title="MalwareBazaar">
      <Row k="family" v={<span style={{ color: 'var(--alert)' }}>{data.family}</span>} />
      {data.file_type && <Row k="type" v={data.file_type} />}
      {data.signature && <Row k="signature" v={data.signature} />}
      {data.tags?.length ? <Row k="tags" v={data.tags.join(', ')} /> : null}
      {data.first_seen && <Row k="first seen" v={data.first_seen} />}
    </Widget>
  );
}

interface Yaraify { yara?: string[]; clamav?: string[]; note?: string }

function YaraifyCard({ target }: { target: string }): JSX.Element | null {
  const { data } = useOsint<Yaraify>('yaraify', target, 'hash');
  if (!data || data.note || (!data.yara?.length && !data.clamav?.length)) return null;
  return (
    <Widget title="YARAify">
      {data.yara?.length ? <Row k="yara" v={data.yara.join(', ')} /> : null}
      {data.clamav?.length ? <Row k="clamav" v={data.clamav.join(', ')} /> : null}
    </Widget>
  );
}

interface Mempool { balance?: number; tx_count?: number; funded?: number; spent?: number; note?: string }

function BtcWalletCard({ address }: { address: string }): JSX.Element | null {
  const { data } = useOsint<Mempool>('mempool', address, 'address');
  if (!data || data.note || data.tx_count == null) return null;
  return (
    <Widget title="BTC wallet (mempool.space)">
      {data.balance != null && <Row k="balance" v={data.balance} />}
      <Row k="tx count" v={data.tx_count} />
      {data.funded != null && <Row k="funded" v={data.funded} />}
      {data.spent != null && <Row k="spent" v={data.spent} />}
    </Widget>
  );
}

interface Blockscout { balance?: number | string; tx_count?: number; note?: string }

function EvmWalletCard({ address }: { address: string }): JSX.Element | null {
  const { data } = useOsint<Blockscout>('blockscout', address, 'address');
  if (!data || data.note || data.tx_count == null) return null;
  return (
    <Widget title="Wallet (blockscout)">
      {data.balance != null && <Row k="balance" v={data.balance} />}
      <Row k="tx count" v={data.tx_count} />
    </Widget>
  );
}

function WalletCard({ target }: { target: string }): JSX.Element | null {
  const ci = target.indexOf(':');
  const chain = ci < 0 ? '' : target.slice(0, ci);
  const address = ci < 0 ? target : target.slice(ci + 1);
  if (!address) return null;
  return chain === 'btc' ? <BtcWalletCard address={address} /> : <EvmWalletCard address={address} />;
}

interface BgpAsnDetail { asn?: number | string; name?: string; description?: string; country?: string; prefixes?: unknown[]; peers?: unknown[]; note?: string }

function BgpAsnCard({ target }: { target: string }): JSX.Element | null {
  const { data } = useOsint<BgpAsnDetail>('bgpview-asn', target, 'asn');
  if (!data || data.note || !data.name) return null;
  return (
    <Widget title="ASN (bgpview)">
      <Row k="name" v={data.name} />
      {data.description && <Row k="description" v={data.description} />}
      {data.country && <Row k="country" v={data.country} />}
      {data.prefixes?.length ? <Row k="prefixes" v={data.prefixes.length} /> : null}
      {data.peers?.length ? <Row k="peers" v={data.peers.length} /> : null}
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
          <WaybackCard target={target} />
          <UrlscanCard target={target} />
          <ThreatCard target={target} />
        </>
      )}
      {kind === 'ip' && (
        <>
          <WhoisCard target={target} />
          <IpGeoCard target={target} />
          <ShodanCard target={target} />
          <BgpCard target={target} />
          <GreynoiseCard target={target} />
          <TorExitCard target={target} />
          <FeodoCard target={target} />
          <ThreatCard target={target} />
        </>
      )}
      {kind === 'username' && (
        <>
          <GithubCard target={target} />
          <GitlabCard target={target} />
          <UsernameSitesCard target={target} />
          <RedditCard target={target} />
        </>
      )}
      {kind === 'email' && (
        <>
          <GravatarCard target={target} />
          <HibpCard target={target} />
          <EmailRepCard target={target} />
          <LibravatarCard target={target} />
          <ThreatCard target={target} />
        </>
      )}
      {kind === 'url' && (
        <>
          <UrlhausUrlCard target={target} />
          <PhishstatsCard target={target} />
        </>
      )}
      {kind === 'file' && (
        <>
          <MalwareBazaarCard target={target} />
          <YaraifyCard target={target} />
        </>
      )}
      {kind === 'wallet' && <WalletCard target={target} />}
      {kind === 'asn' && <BgpAsnCard target={target} />}
      {kind === 'tx' && null}
      {!['domain', 'ip', 'username', 'email', 'url', 'file', 'wallet', 'asn', 'tx'].includes(kind) && (
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
