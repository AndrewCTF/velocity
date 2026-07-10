#!/usr/bin/env python3
"""Stage D2 — no-stereo pose/heading fallback.

When there is no multi-view stereo (so no splat can be built — the common case),
we still get geometric constraints from a SINGLE VHR tile + a public DEM:

  * Shadow cue: an object of height H under a sun at elevation e casts a shadow of
    length L = H / tan(e), pointing away from the sun (shadow_az = solar_az + 180).
    Given a timestamp+location we compute the sun position analytically (NOAA/Meeus
    solar algorithm, no external dep); a measured shadow then yields object height,
    and a measured shadow *direction* pins the camera/scene heading and cross-checks
    the timestamp. Conversely a measured shadow length + known height yields the
    solar elevation → a latitude/season band.

  * Silhouette cue: the query photo's horizon / building-ridge / field-edge profile
    is matched (1-D circular cross-correlation) against a skyline profile sampled
    from a DEM/DSM at the candidate viewpoint → recovers viewing heading.

This is the cheaper branch that "works far more often" (doc §2 D2). It is pure
numpy (+ optional PIL for overlays), so it runs in either venv. The heavy DEM I/O
(rasterio) and real VHR footprint extraction live in apps/api/.venv; this module
provides the composable geometry core + a synthetic self-check. A live end-to-end
run additionally needs a DEM tile (Copernicus GLO-30) and a shadow/edge mask from
the VHR — see `silhouette_from_dsm()` which consumes an rpc_stereo DSM .npz.

Usage:
  python dsm_fallback.py --self-check
  python dsm_fallback.py --lat 48.85 --lon 2.35 --datetime 2021-06-21T10:00:00 \
      --shadow-len-m 17.3 --object-height-m 10   # -> sun geom + consistency
"""
from __future__ import annotations

import argparse
import datetime as _dt
import math

import numpy as np


# --------------------------------------------------------------------------- #
# Solar position (NOAA / Meeus). Inputs in UTC. Returns degrees.
# --------------------------------------------------------------------------- #
def _julian_day(dt: _dt.datetime) -> float:
    dt = dt.astimezone(_dt.timezone.utc) if dt.tzinfo else dt.replace(tzinfo=_dt.timezone.utc)
    y, m = dt.year, dt.month
    d = (dt.day + (dt.hour + (dt.minute + dt.second / 60) / 60) / 24)
    if m <= 2:
        y -= 1
        m += 12
    a = y // 100
    b = 2 - a + a // 4
    return int(365.25 * (y + 4716)) + int(30.6001 * (m + 1)) + d + b - 1524.5


def solar_declination(dt: _dt.datetime) -> float:
    """Solar declination (deg). Meeus low-precision; good to ~0.01 deg."""
    jc = (_julian_day(dt) - 2451545.0) / 36525.0
    gml = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360.0
    gma = 357.52911 + jc * (35999.05029 - 0.0001537 * jc)
    ecc = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc)
    sc = (math.sin(math.radians(gma)) * (1.914602 - jc * (0.004817 + 0.000014 * jc))
          + math.sin(math.radians(2 * gma)) * (0.019993 - 0.000101 * jc)
          + math.sin(math.radians(3 * gma)) * 0.000289)
    true_long = gml + sc
    omega = 125.04 - 1934.136 * jc
    app_long = true_long - 0.00569 - 0.00478 * math.sin(math.radians(omega))
    obliq = (23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60)
    obliq_corr = obliq + 0.00256 * math.cos(math.radians(omega))
    decl = math.degrees(math.asin(math.sin(math.radians(obliq_corr))
                                  * math.sin(math.radians(app_long))))
    return decl


def _equation_of_time(dt: _dt.datetime) -> float:
    """Equation of time (minutes)."""
    jc = (_julian_day(dt) - 2451545.0) / 36525.0
    gml = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360.0
    gma = 357.52911 + jc * (35999.05029 - 0.0001537 * jc)
    ecc = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc)
    obliq = (23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60)
    omega = 125.04 - 1934.136 * jc
    obliq_corr = obliq + 0.00256 * math.cos(math.radians(omega))
    y = math.tan(math.radians(obliq_corr / 2)) ** 2
    gml_r, gma_r = math.radians(gml), math.radians(gma)
    eot = (y * math.sin(2 * gml_r) - 2 * ecc * math.sin(gma_r)
           + 4 * ecc * y * math.sin(gma_r) * math.cos(2 * gml_r)
           - 0.5 * y * y * math.sin(4 * gml_r) - 1.25 * ecc * ecc * math.sin(2 * gma_r))
    return math.degrees(eot) * 4  # radians->deg->minutes


def solar_position(lat: float, lon: float, dt: _dt.datetime) -> tuple[float, float]:
    """Return (elevation_deg, azimuth_deg) of the sun. Azimuth clockwise from North.
    dt is UTC (naive treated as UTC)."""
    dt = dt.astimezone(_dt.timezone.utc) if dt.tzinfo else dt.replace(tzinfo=_dt.timezone.utc)
    decl = math.radians(solar_declination(dt))
    eot = _equation_of_time(dt)
    minutes = dt.hour * 60 + dt.minute + dt.second / 60
    true_solar_time = (minutes + eot + 4 * lon) % 1440  # deg-lon * 4 min/deg
    ha = true_solar_time / 4 - 180  # hour angle deg (0 at solar noon)
    ha_r = math.radians(ha)
    lat_r = math.radians(lat)
    cos_zen = (math.sin(lat_r) * math.sin(decl)
               + math.cos(lat_r) * math.cos(decl) * math.cos(ha_r))
    cos_zen = max(-1.0, min(1.0, cos_zen))
    zen = math.acos(cos_zen)
    elev = 90 - math.degrees(zen)
    # azimuth
    denom = math.cos(lat_r) * math.sin(zen)
    if abs(denom) < 1e-9:
        az = 180.0
    else:
        cos_az = (math.sin(lat_r) * math.cos(zen) - math.sin(decl)) / denom
        cos_az = max(-1.0, min(1.0, cos_az))
        az = math.degrees(math.acos(cos_az))
        az = az if ha > 0 else (360 - az)  # afternoon -> west
        az = (180 + az) % 360  # NOAA convention: measured clockwise from north
    return elev, az


# --------------------------------------------------------------------------- #
# Shadow geometry
# --------------------------------------------------------------------------- #
def shadow_length(height: float, elev_deg: float) -> float:
    """Ground shadow length for a vertical object of `height` under sun elevation."""
    e = math.radians(max(0.1, elev_deg))
    return height / math.tan(e)


def height_from_shadow(length: float, elev_deg: float) -> float:
    e = math.radians(max(0.1, elev_deg))
    return length * math.tan(e)


def shadow_azimuth(solar_az_deg: float) -> float:
    """Direction the shadow points (away from the sun), clockwise from north."""
    return (solar_az_deg + 180) % 360


def measure_shadow(mask: np.ndarray, base_xy: tuple[float, float]) -> tuple[float, float]:
    """From a binary shadow mask + the object's ground-contact pixel, return
    (length_px, direction_deg) where direction is image-frame azimuth measured
    clockwise from image-up (+row = down). length = farthest shadow pixel from base."""
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return 0.0, 0.0
    bx, by = base_xy
    d = np.hypot(xs - bx, ys - by)
    k = int(np.argmax(d))
    dx, dy = xs[k] - bx, ys[k] - by
    length = float(d[k])
    # image azimuth clockwise from up: atan2(dx, -dy)
    direction = math.degrees(math.atan2(dx, -dy)) % 360
    return length, direction


# --------------------------------------------------------------------------- #
# Silhouette / skyline heading match
# --------------------------------------------------------------------------- #
def skyline_profile(angles_deg: np.ndarray, heights: np.ndarray) -> np.ndarray:
    """Normalise a horizon-elevation profile for correlation (zero-mean/unit-std)."""
    h = heights.astype(np.float64)
    return (h - h.mean()) / (h.std() + 1e-9)


def silhouette_from_dsm(dsm: np.ndarray, gla: np.ndarray, glo: np.ndarray,
                        origin: tuple[float, float, float],
                        eye_lat: float, eye_lon: float, eye_h: float,
                        n_az: int = 360, max_km: float = 5.0) -> np.ndarray:
    """Sample a horizon-elevation profile (deg above level) around a viewpoint from
    an rpc_stereo DSM. Cheap ray-march per azimuth; returns (n_az,) elevations.
    Composes with rpc_stereo's DSM .npz output (dsm, gla, glo, origin)."""
    lat0, lon0, h0 = origin
    mlat = 111320.0
    mlon = 111320.0 * math.cos(math.radians(lat0))
    prof = np.full(n_az, -90.0)
    LO, LA = np.meshgrid(glo, gla)
    for i in range(n_az):
        az = math.radians(360 * i / n_az)
        max_el = -90.0
        for r in np.linspace(20, max_km * 1000, 60):
            dlat = (r * math.cos(az)) / mlat
            dlon = (r * math.sin(az)) / mlon
            la, lo = eye_lat + dlat, eye_lon + dlon
            iy = int(np.argmin(np.abs(gla - la)))
            ix = int(np.argmin(np.abs(glo - lo)))
            z = dsm[iy, ix]
            if np.isnan(z):
                continue
            el = math.degrees(math.atan2(z - eye_h, r))
            max_el = max(max_el, el)
        prof[i] = max_el
    return prof


def estimate_heading(query_profile: np.ndarray, dem_profile: np.ndarray) -> tuple[float, float]:
    """Best heading (deg) aligning a query horizon profile to a DEM skyline profile
    via circular cross-correlation. Returns (heading_deg, correlation).

    Convention: heading is the azimuth offset `h` (deg) such that
    query[i] ≈ dem[(i + h_idx) % n] — i.e. the query's left edge looks toward DEM
    azimuth `h`. Equivalently query == roll(dem, -h_idx)."""
    q = skyline_profile(None, query_profile)
    d = skyline_profile(None, dem_profile)
    n = len(d)
    if len(q) != n:
        q = np.interp(np.linspace(0, len(q), n, endpoint=False), np.arange(len(q)), q)
        q = (q - q.mean()) / (q.std() + 1e-9)
    corr = np.array([np.dot(q, np.roll(d, -s)) for s in range(n)]) / n
    s = int(np.argmax(corr))
    return 360.0 * s / n, float(corr[s])


# --------------------------------------------------------------------------- #
# Self-check
# --------------------------------------------------------------------------- #
def self_check() -> bool:
    ok = True

    # (1) solar declination at solstices / equinox
    dec_jun = solar_declination(_dt.datetime(2021, 6, 21, 12))
    dec_dec = solar_declination(_dt.datetime(2021, 12, 21, 12))
    dec_mar = solar_declination(_dt.datetime(2021, 3, 20, 12))
    print(f"declination Jun21={dec_jun:.2f} (want ~+23.44), "
          f"Dec21={dec_dec:.2f} (~-23.44), Mar20={dec_mar:.2f} (~0)")
    ok &= abs(dec_jun - 23.44) < 0.4 and abs(dec_dec + 23.44) < 0.4 and abs(dec_mar) < 0.6

    # (2) solar-noon elevation identity: at HA=0, elev == 90 - |lat - decl|.
    for lat, lon in [(48.85, 2.35), (0.0, 0.0), (-33.87, 151.21)]:
        # find UTC solar noon: true_solar_time=720 -> minutes = 720 - eot - 4*lon
        dt0 = _dt.datetime(2021, 6, 21, 12)
        eot = _equation_of_time(dt0)
        minutes = (720 - eot - 4 * lon) % 1440
        noon = _dt.datetime(2021, 6, 21) + _dt.timedelta(minutes=minutes)
        elev, az = solar_position(lat, lon, noon)
        decl = solar_declination(noon)
        expect = 90 - abs(lat - decl)
        print(f"lat={lat:+.2f} solar-noon elev={elev:.2f} (want {expect:.2f}), az={az:.1f}")
        ok &= abs(elev - expect) < 0.3

    # (3) shadow length round-trip + direction recovery from a synthetic mask
    H, elev = 10.0, 30.0
    L = shadow_length(H, elev)
    Hr = height_from_shadow(L, elev)
    print(f"shadow: H=10,elev=30 -> L={L:.2f} (want 17.32); back H={Hr:.3f}")
    ok &= abs(L - 17.320) < 0.01 and abs(Hr - 10.0) < 1e-6
    # synth mask: base at (50,50); sun az=135 -> shadow az=315 (points to image up-left)
    solar_az = 135.0
    sh_az = shadow_azimuth(solar_az)  # 315
    mask = np.zeros((100, 100), bool)
    length_px = 20
    for t in range(length_px):
        px = int(50 + t * math.sin(math.radians(sh_az)))
        py = int(50 - t * math.cos(math.radians(sh_az)))
        if 0 <= px < 100 and 0 <= py < 100:
            mask[py, px] = True
    mlen, mdir = measure_shadow(mask, (50, 50))
    print(f"measured shadow dir={mdir:.1f} (want {sh_az:.1f}), len={mlen:.1f}px")
    ok &= abs(((mdir - sh_az + 180) % 360) - 180) < 3 and abs(mlen - length_px) < 2

    # (4) heading recovery from a synthetic skyline
    rng = np.random.default_rng(1)
    dem = rng.random(360) + 2 * np.sin(np.radians(np.arange(360) * 3))
    true_heading = 47
    # per estimate_heading convention: query[i] = dem[i + h] -> query = roll(dem, -h)
    query = np.roll(dem, -true_heading) + 0.03 * rng.standard_normal(360)
    est, corr = estimate_heading(query, dem)
    err = min((est - true_heading) % 360, (true_heading - est) % 360)
    print(f"heading est={est:.0f} (want {true_heading}), corr={corr:.2f}, err={err:.0f}deg")
    ok &= err <= 2

    print(f"\ndsm_fallback self-check {'OK' if ok else 'FAIL'}")
    return ok


def main() -> None:
    ap = argparse.ArgumentParser(description="Stage D2 shadow+silhouette fallback")
    ap.add_argument("--self-check", action="store_true")
    ap.add_argument("--lat", type=float)
    ap.add_argument("--lon", type=float)
    ap.add_argument("--datetime", help="UTC ISO, e.g. 2021-06-21T10:00:00")
    ap.add_argument("--shadow-len-m", type=float)
    ap.add_argument("--object-height-m", type=float)
    a = ap.parse_args()

    if a.self_check:
        import sys
        sys.exit(0 if self_check() else 1)

    if not (a.lat is not None and a.lon is not None and a.datetime):
        ap.error("--lat --lon --datetime required (or --self-check)")
    dt = _dt.datetime.fromisoformat(a.datetime)
    elev, az = solar_position(a.lat, a.lon, dt)
    print(f"sun: elevation={elev:.2f} deg, azimuth={az:.2f} deg "
          f"(clockwise from N); shadow points to {shadow_azimuth(az):.2f} deg")
    if a.object_height_m is not None:
        print(f"predicted shadow length for h={a.object_height_m} m: "
              f"{shadow_length(a.object_height_m, elev):.2f} m")
    if a.shadow_len_m is not None:
        print(f"object height implied by shadow {a.shadow_len_m} m: "
              f"{height_from_shadow(a.shadow_len_m, elev):.2f} m")
    if a.shadow_len_m is not None and a.object_height_m is not None:
        pred = shadow_length(a.object_height_m, elev)
        print(f"consistency: measured {a.shadow_len_m} m vs predicted {pred:.2f} m "
              f"(ratio {a.shadow_len_m / pred:.2f}) — off-ratio implies wrong time/lat/height")


if __name__ == "__main__":
    main()
