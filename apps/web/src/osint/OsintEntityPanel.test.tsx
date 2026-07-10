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
