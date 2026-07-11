// Deterministic render tests for the airport/port/base entity-panel cards
// (docs/places-airspace-plan.md §5). AirportCard/PortCard/BaseCard take plain
// props (mirrors VesselClassCard's testable prop-driven pattern), so these
// mount the cards directly — no Cesium viewer needed. apiFetch is mocked at
// the transport boundary (pattern from osint/OsintEntityPanel.test.tsx) for
// AirportCard's live METAR fetch.

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AirportCard } from './AirportCard.js';
import { PortCard } from './PortCard.js';
import { BaseCard } from './BaseCard.js';
import type { AirportEnrichment, PortEnrichment, Runway } from '../transport/entity.js';

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

// KJFK runway from the real committed airports_detail.json fixture — one
// runway with matching le/he ILS CAT (I/I).
const KJFK_RUNWAY: Runway = {
  le_ident: '04L',
  he_ident: '22R',
  length_ft: 12079,
  width_ft: 200,
  surface: 'PEM',
  lighted: true,
  closed: false,
  ils_category: 'I',
  ils_category_le: 'I',
  ils_category_he: 'I',
};

// EGLL runway — non-US, ils_category null throughout (§7: never guess).
const EGLL_RUNWAY: Runway = {
  le_ident: '09L',
  he_ident: '27R',
  length_ft: 12799,
  width_ft: 164,
  surface: 'ASP',
  lighted: true,
  closed: false,
  ils_category: null,
  ils_category_le: null,
  ils_category_he: null,
};

function airportFixture(overrides: Partial<AirportEnrichment> = {}): AirportEnrichment {
  return {
    kind: 'airport',
    icao: 'KJFK',
    iata: 'JFK',
    name: 'John F Kennedy Intl',
    lat: 40.64,
    lon: -73.78,
    elevation_ft: 13,
    municipality: 'New York',
    iso: 'US',
    atype: 'large',
    scheduled_service: true,
    military: false,
    runways: [KJFK_RUNWAY],
    frequencies: [{ type: 'TWR', desc: 'KENNEDY TWR', mhz: 119.1 }],
    runway_count: 1,
    max_runway_length_ft: 12079,
    liveatc_url: 'https://www.liveatc.net/search/?icao=KJFK',
    candidate_mounts: ['https://s1-fmt2.liveatc.net/kjfk_twr', 'https://s1-bos.liveatc.net/kjfk_twr'],
    candidate_mounts_best_effort: true,
    source: 'ourairports+faa-nasr',
    ...overrides,
  };
}

const METAR_VFR = {
  data: [
    {
      icaoId: 'KJFK',
      wdir: 50,
      wspd: 7,
      visib: '10+',
      altim: 1012.3,
      temp: 23.9,
      dewp: 20.6,
      fltCat: 'VFR',
      rawOb: 'METAR KJFK 110851Z 05007KT 10SM BKN110 BKN250 24/21 A2989',
    },
  ],
};

const METAR_LIFR_FOG = {
  data: [
    {
      icaoId: 'KJFK',
      wdir: 'VRB',
      wspd: 3,
      visib: 0.5,
      altim: 1008.0,
      temp: 5,
      dewp: 5,
      fltCat: 'LIFR',
      rawOb: 'METAR KJFK 110851Z VRB03KT 1/2SM FG VV002 05/05 A2977',
    },
  ],
};

describe('AirportCard', () => {
  it('renders the runways table with an ILS CAT badge for a US fixture', async () => {
    mockedFetch.mockResolvedValue(jsonResponse(METAR_VFR));
    render(<AirportCard enrichment={airportFixture()} />);
    expect(screen.getByText('04L / 22R')).toBeInTheDocument();
    expect(screen.getByText('CAT I')).toBeInTheDocument();
    expect(screen.getByText('CIVIL')).toBeInTheDocument();
    // Wait for the METAR fetch to resolve before the test tears down.
    expect(await screen.findByText('VFR')).toBeInTheDocument();
  });

  it('shows — for ILS CAT on a non-US runway rather than guessing', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ data: [] }));
    const fixture = airportFixture({
      icao: 'EGLL',
      iata: 'LHR',
      name: 'Heathrow',
      iso: 'GB',
      runways: [EGLL_RUNWAY],
      runway_count: 1,
      max_runway_length_ft: 12799,
      liveatc_url: null,
      candidate_mounts: [],
      candidate_mounts_best_effort: false,
    });
    render(<AirportCard enrichment={fixture} />);
    expect(screen.getByText('09L / 27R')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(await screen.findByText(/METAR unavailable/)).toBeInTheDocument();
  });

  it('renders a flight-category/fog chip from a LIFR METAR fixture', async () => {
    mockedFetch.mockResolvedValue(jsonResponse(METAR_LIFR_FOG));
    render(<AirportCard enrichment={airportFixture()} />);
    expect(await screen.findByText('LIFR')).toBeInTheDocument();
    expect(screen.getByText('low vis / fog')).toBeInTheDocument();
  });

  it('renders the military badge when the airport is flagged military', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ data: [] }));
    const fixture = airportFixture({ military: true, liveatc_url: null, candidate_mounts: [] });
    render(<AirportCard enrichment={fixture} />);
    expect(screen.getByText('MILITARY')).toBeInTheDocument();
    expect(await screen.findByText(/METAR unavailable/)).toBeInTheDocument();
  });

  it('gracefully reports METAR unavailable when the upstream has no report', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ data: [] }));
    render(<AirportCard enrichment={airportFixture()} />);
    expect(await screen.findByText(/METAR unavailable/)).toBeInTheDocument();
  });

  it('renders the LiveATC audio player with a candidate mount and falls back on error', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ data: [] }));
    render(<AirportCard enrichment={airportFixture()} />);
    fireEvent.click(screen.getByText(/try live stream/));
    expect(screen.getByText(/best-effort stream, may be unavailable/)).toBeInTheDocument();
    const audio = document.querySelector('audio');
    expect(audio).toBeTruthy();
    expect(audio?.getAttribute('src')).toBe('https://s1-fmt2.liveatc.net/kjfk_twr');
    fireEvent.error(audio!);
    expect(screen.getByText('stream unavailable')).toBeInTheDocument();
    expect(await screen.findByText(/METAR unavailable/)).toBeInTheDocument();
  });
});

describe('PortCard', () => {
  function portFixture(overrides: Partial<PortEnrichment> = {}): PortEnrichment {
    return {
      kind: 'port',
      wpi: '31140',
      name: 'Rotterdam',
      lat: 51.9,
      lon: 4.5,
      op_status: 'Unknown',
      harborSize: 'Large',
      harborType: 'Coastal Natural',
      shelter: 'Good',
      repairs: 'Major',
      dryDock: 'Large',
      railway: 'Yes',
      portSecurity: 'Unknown',
      harborUse: 'Commercial',
      cargoPierDepth: 15,
      channelDepth: 15,
      source: 'nga-wpi',
      ...overrides,
    };
  }

  it('renders WPI fields including the honest Unknown op-status', () => {
    render(<PortCard enrichment={portFixture()} />);
    expect(screen.getByText('Unknown')).toBeInTheDocument(); // op_status
    expect(screen.getByText('Large')).toBeInTheDocument(); // harborSize
    expect(screen.getByText(/Repairs: Major/)).toBeInTheDocument();
    expect(screen.getByText(/Cargo pier/)).toBeInTheDocument();
  });

  it('hides the max-vessel block when no maxVessel fields are present (sparse WPI)', () => {
    render(<PortCard enrichment={portFixture()} />);
    expect(screen.queryByText('Max vessel')).not.toBeInTheDocument();
  });

  it('renders the max-vessel block when the WPI carries those fields', () => {
    render(
      <PortCard
        enrichment={portFixture({ maxVesselLength: 400, maxVesselBeam: 60, maxVesselDraft: 20 })}
      />,
    );
    expect(screen.getByText('Max vessel')).toBeInTheDocument();
    expect(screen.getByText('400 m')).toBeInTheDocument();
  });
});

describe('BaseCard', () => {
  it('renders name, branch, and coordinates with no fabricated capability data', () => {
    render(<BaseCard name="Ramstein Air Base" branch="air" lat={49.4369} lon={7.6003} />);
    expect(screen.getByText('Ramstein Air Base')).toBeInTheDocument();
    expect(screen.getByText('Air')).toBeInTheDocument();
    expect(screen.getByText('49.4369, 7.6003')).toBeInTheDocument();
  });
});
