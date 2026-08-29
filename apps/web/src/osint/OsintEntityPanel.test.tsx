// Deterministic render test for the new ontology-kind cards (wallet, asn, url,
// file) plus one enriched existing kind (ip → GreyNoise). Mirrors the mocking
// convention in apps/web/src/foundry/foundry.test.tsx: apiFetch is mocked at
// the transport boundary and routed by URL, no real network involved.

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OsintEntityPanel } from './OsintEntityPanel.js';

vi.mock('../transport/http.js', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../transport/http.js';

const mockedFetch = vi.mocked(apiFetch);

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  } as unknown as Response;
}

// Route apiFetch by the connector endpoint in the URL. Anything not covered
// below (whois, ip, shodan, bgpview-ip, onionoo, feodo, threat, phishstats,
// yaraify, …) falls through to a `{note}` payload, which every card treats as
// "no data" and null's out on — proving the sibling cards for a kind don't
// crash even when their connector has nothing to say.
mockedFetch.mockImplementation(async (url: string) => {
  const u = url.toString();
  if (u.startsWith('/api/osint/bgpview-asn')) {
    return jsonResponse({
      asn: 'AS15169',
      name: 'GOOGLE',
      country: 'US',
      prefixes: ['8.8.8.0/24'],
      peers: ['AS3356'],
    });
  }
  if (u.startsWith('/api/osint/mempool')) {
    return jsonResponse({ balance: 5000, tx_count: 3, funded: 5000, spent: 0 });
  }
  if (u.startsWith('/api/osint/urlhaus-url')) {
    return jsonResponse({ threat: 'malware_download', tags: ['elf'], payloads: ['abc'], status: 'online' });
  }
  if (u.startsWith('/api/osint/malwarebazaar')) {
    return jsonResponse({ family: 'AgentTesla', file_type: 'exe', tags: ['t'], first_seen: '2024', signature: 'AgentTesla' });
  }
  if (u.startsWith('/api/osint/greynoise')) {
    return jsonResponse({ classification: 'malicious', noise: true, tags: ['scanner'] });
  }
  return jsonResponse({ note: 'no data' });
});

describe('OsintEntityPanel — new ontology kinds', () => {
  it('wallet:btc:… renders the BTC wallet card with balance/tx_count via mempool.space', async () => {
    render(<OsintEntityPanel id="wallet:btc:1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa" />);
    expect(screen.getByText('WALLET')).toBeInTheDocument();
    expect(await screen.findByText('BTC wallet (mempool.space)')).toBeInTheDocument();
    // "5000" appears twice (balance + funded — both equal in the fixture).
    expect(screen.getAllByText('5000').length).toBe(2);
    expect(screen.getByText('3')).toBeInTheDocument(); // tx count
    // Proves the address (not the "btc:" chain prefix) was sent as the param.
    expect(mockedFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/osint/mempool?address=1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'),
      expect.anything(),
    );
  });

  it('asn:AS15169 renders the BGP ASN card with name/peers via bgpview', async () => {
    render(<OsintEntityPanel id="asn:AS15169" />);
    expect(screen.getByText('ASN')).toBeInTheDocument();
    expect(await screen.findByText('ASN (bgpview)')).toBeInTheDocument();
    expect(screen.getByText('GOOGLE')).toBeInTheDocument();
    expect(screen.getByText('US')).toBeInTheDocument();
    expect(screen.getByText('peers')).toBeInTheDocument();
    expect(mockedFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/osint/bgpview-asn?asn=AS15169'),
      expect.anything(),
    );
  });

  it('url:… renders the URLhaus card (and does not crash on the sibling PhishStats card)', async () => {
    render(<OsintEntityPanel id="url:http://evil.test/x" />);
    expect(screen.getByText('URL')).toBeInTheDocument();
    expect(await screen.findByText('URLhaus')).toBeInTheDocument();
    expect(screen.getByText('malware_download')).toBeInTheDocument();
    expect(screen.getByText('online')).toBeInTheDocument();
    // PhishStats connector returned {note}, so its card must not render.
    expect(screen.queryByText('PhishStats')).not.toBeInTheDocument();
  });

  it('file:<hash> renders the MalwareBazaar card showing the family', async () => {
    const hash = 'a'.repeat(64);
    render(<OsintEntityPanel id={`file:${hash}`} />);
    expect(screen.getByText('FILE')).toBeInTheDocument();
    expect(await screen.findByText('MalwareBazaar')).toBeInTheDocument();
    // "AgentTesla" appears twice (family + signature — equal in the fixture).
    expect(screen.getAllByText('AgentTesla').length).toBe(2);
    expect(screen.getByText('exe')).toBeInTheDocument();
    expect(mockedFetch).toHaveBeenCalledWith(
      expect.stringContaining(`/api/osint/malwarebazaar?hash=${hash}`),
      expect.anything(),
    );
    // YARAify connector returned {note}, so its card must not render.
    expect(screen.queryByText('YARAify')).not.toBeInTheDocument();
  });

  it('ip:8.8.8.8 renders the GreyNoise card among the existing IP cards, none of which crash', async () => {
    render(<OsintEntityPanel id="ip:8.8.8.8" />);
    expect(screen.getByText('IP')).toBeInTheDocument();
    expect(await screen.findByText('GreyNoise')).toBeInTheDocument();
    expect(screen.getByText('malicious')).toBeInTheDocument();
    expect(screen.getByText('scanner')).toBeInTheDocument();
    expect(mockedFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/osint/greynoise?ip=8.8.8.8'),
      expect.anything(),
    );
    // WHOIS/Shodan/BGP(ip)/Tor/Feodo/Threat connectors all returned {note} or
    // empty payloads for this id — proving the panel doesn't crash when most
    // of the fan-out has nothing to say.
    expect(screen.queryByText('WHOIS / RDAP')).not.toBeInTheDocument();
    expect(screen.queryByText('Exposure (Shodan InternetDB)')).not.toBeInTheDocument();
  });

  it('renders header + Search around for an unrecognized kind without crashing', async () => {
    render(<OsintEntityPanel id="mystery:something-unmapped" />);
    expect(screen.getByText('MYSTERY')).toBeInTheDocument();
    expect(screen.getByText('something-unmapped')).toBeInTheDocument();
    expect(screen.getByText(/Search around/)).toBeInTheDocument();
    // The fallback ThreatCard connector returns {note}, so no card renders —
    // just confirming nothing throws while it resolves.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText('Threat-intel (AlienVault OTX)')).not.toBeInTheDocument();
  });
});

// ── OSINT Techniques 11th ed. wave: stealer logs and LittleSis ───────────────
//
// A separate describe with its own routing table: these two cards have to be
// asserted against payloads the shared table above deliberately answers `{note}`
// for, and the clean-vs-unchecked distinction is the whole point of the card.

describe('OsintEntityPanel — stealer logs and affiliations', () => {
  function route(table: Record<string, unknown>) {
    mockedFetch.mockImplementation(async (url: string) => {
      const u = url.toString();
      for (const [prefix, body] of Object.entries(table)) {
        if (u.startsWith(prefix)) return jsonResponse(body);
      }
      return jsonResponse({ note: 'no data' });
    });
  }

  it('renders an infostealer hit for an email, without any credential material', async () => {
    route({
      '/api/osint/stealer': {
        indicator: 'victim@example.com',
        checked: true,
        infected: true,
        computer_count: 2,
        stealer_families: ['Lumma', 'RedLine'],
        corporate_services: 8,
        user_services: 370,
        computers: [
          {
            date_compromised: '2026-08-27T19:02:40.000Z',
            computer_name: 'DESKTOP-U1NSLMA',
            operating_system: 'Windows 10 Pro',
          },
        ],
      },
    });
    render(<OsintEntityPanel id="email:victim@example.com" />);

    expect(await screen.findByText('Infostealer logs · Hudson Rock')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('Lumma · RedLine')).toBeInTheDocument();
    expect(screen.getByText(/DESKTOP-U1NSLMA/)).toBeInTheDocument();
  });

  it('renders a clean check as a finding, and an unchecked target as nothing', async () => {
    route({
      '/api/osint/stealer': {
        indicator: 'clean@example.com',
        checked: true,
        infected: false,
        computer_count: 0,
        computers: [],
      },
    });
    const { unmount } = render(<OsintEntityPanel id="email:clean@example.com" />);
    expect(await screen.findByText('checked · not in the corpus')).toBeInTheDocument();
    unmount();

    // checked:false means the upstream was unreachable, which is NOT clean.
    route({ '/api/osint/stealer': { indicator: 'x@example.com', checked: false, note: 'down' } });
    render(<OsintEntityPanel id="email:x@example.com" />);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText('Infostealer logs · Hudson Rock')).not.toBeInTheDocument();
  });

  it('renders domain estate exposure with its own shape', async () => {
    route({
      '/api/osint/stealer': {
        indicator: 'cnn.com',
        checked: true,
        total: 6486,
        employees: 0,
        users: 6460,
        third_parties: 26,
        last_user_compromised: '2026-08-26T20:39:30.000Z',
        urls: [{ url: 'https://edition.cnn.com/account/register', type: 'User', occurrence: 2447 }],
      },
    });
    render(<OsintEntityPanel id="domain:cnn.com" />);

    expect(await screen.findByText('Infostealer logs · Hudson Rock')).toBeInTheDocument();
    expect(screen.getByText('6486')).toBeInTheDocument();
    expect(screen.getByText('6460')).toBeInTheDocument();
    expect(screen.getByText('2026-08-26')).toBeInTheDocument();
    expect(screen.getByText('https://edition.cnn.com/account/register')).toBeInTheDocument();
  });

  it('shows LittleSis ties for a person, and ignores a namesake', async () => {
    route({
      '/api/osint/littlesis-relationships': {
        relationships: [
          {
            id: '1',
            role: 'Campaign Contribution',
            counterparty: { id: '9', kind: 'Organization', name: 'Acme Corp' },
          },
        ],
      },
      '/api/osint/littlesis': {
        entities: [{ id: '42', name: 'Jane Roe', kind: 'Person', blurb: 'An investor', url: 'https://littlesis.org/entities/42' }],
      },
    });
    render(<OsintEntityPanel id="person:Jane Roe" />);

    expect(await screen.findByText('Affiliations · LittleSis')).toBeInTheDocument();
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    expect(screen.getByText('Campaign Contribution')).toBeInTheDocument();
  });

  it('adopts no ties when the top LittleSis hit is a different person', async () => {
    route({
      '/api/osint/littlesis': {
        entities: [{ id: '43', name: 'Somebody Else', kind: 'Person' }],
      },
    });
    render(<OsintEntityPanel id="person:Jane Roe" />);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText('Affiliations · LittleSis')).not.toBeInTheDocument();
  });
});

// ── ch. 43: ransomware leak-site claims ─────────────────────────────────────

describe('OsintEntityPanel — ransomware leak sites', () => {
  function route(table: Record<string, unknown>) {
    mockedFetch.mockImplementation(async (url: string) => {
      const u = url.toString();
      for (const [prefix, body] of Object.entries(table)) {
        if (u.startsWith(prefix)) return jsonResponse(body);
      }
      return jsonResponse({ note: 'no data' });
    });
  }

  it('renders victim posts and the crews that made them', async () => {
    route({
      '/api/osint/ransomware': {
        query: 'victim.example',
        checked: true,
        count: 2,
        searched: 4,
        groups: ['incransom', 'qilin'],
        victims: [
          { victim: 'Victim Co', group: 'qilin', country: 'ID', attackdate: '2025-01-05T00:00:00+00:00' },
        ],
      },
    });
    render(<OsintEntityPanel id="domain:victim.example" />);

    expect(await screen.findByText('Ransomware leak sites')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('incransom · qilin')).toBeInTheDocument();
    expect(screen.getByText(/Victim Co · qilin · ID/)).toBeInTheDocument();
  });

  it('renders a checked-clean search as a finding', async () => {
    route({
      '/api/osint/ransomware': { query: 'clean.example', checked: true, count: 0, searched: 0, groups: [] },
    });
    render(<OsintEntityPanel id="domain:clean.example" />);
    expect(await screen.findByText('checked · no crew has posted this domain')).toBeInTheDocument();
  });

  it('renders nothing when the check was rate limited, rather than an all-clear', async () => {
    route({
      '/api/osint/ransomware': {
        query: 'x.example',
        checked: false,
        count: 0,
        note: 'ransomware.live rate limited (1 request per minute)',
      },
    });
    render(<OsintEntityPanel id="domain:x.example" />);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText('Ransomware leak sites')).not.toBeInTheDocument();
  });
});
