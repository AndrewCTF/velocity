#!/usr/bin/env python3
"""Phase A smoke test: prove the auth works against live Apple servers.

Usage:
    python smoke_test.py              # uses config.json in current dir
    python smoke_test.py config.json  # explicit path

Tests:
1. Fetch ResourceManifest (unsigned) → 200, valid protobuf
2. Bootstrap: parse manifest, fetch altitude XML, find Tokyo region
3. Sign a C3M tile URL → fetch → 200 and starts with C3M magic bytes

If step 3 returns 403, the token is dead. Report and stop.
"""

import asyncio
import json
import sys
from pathlib import Path

# add parent to path so apple3d is importable
sys.path.insert(0, str(Path(__file__).parent))

from apple3d.manifest import bootstrap, C3M_STYLE


async def main():
    config_path = Path(sys.argv[1] if len(sys.argv) > 1 else "config.json")
    if not config_path.exists():
        print(f"ERROR: {config_path} not found. Run extract_token.sh first.")
        sys.exit(1)

    config = json.loads(config_path.read_text())
    manifest_url = config["resourceManifestURL"]
    token_p1 = config["tokenP1"]

    print(f"tokenP1: {token_p1[:8]}...{token_p1[-4:]}")
    print(f"manifest URL: {manifest_url[:60]}...")

    # Step 1+2: bootstrap (fetches manifest + altitude XML)
    print("\n--- Bootstrapping ---")
    ctx = await bootstrap(manifest_url, token_p1)
    print(f"token_p2: {ctx.manifest.token_p2[:20]}...")
    print(f"cache_base_url: {ctx.manifest.cache_base_url}")
    print(f"style configs: {len(ctx.manifest.style_configs)}")
    for sc in ctx.manifest.style_configs:
        print(f"  style {sc.style_id}: {sc.url_prefix[:60]}...")
    print(f"altitude triggers: {len(ctx.triggers)}")
    print(f"C3M prefix: {ctx.c3m_prefix[:60]}...")
    print(f"C3MM prefix: {ctx.c3mm_prefix[:60]}...")

    # find Tokyo
    tokyo_lat, tokyo_lon = 35.6762, 139.6503
    try:
        region = ctx.find_region(tokyo_lat, tokyo_lon)
        print(f"\nTokyo region: {region.name} (region={region.region}, v={region.version})")
    except ValueError as e:
        print(f"\nWARNING: {e}")
        print("Trying first available region instead...")
        if ctx.triggers:
            region = ctx.triggers[0]
            print(f"Using: {region.name} ({region.lat:.2f}, {region.lon:.2f})")
        else:
            print("ERROR: no triggers at all")
            sys.exit(1)

    # Step 3: sign a C3M tile URL and fetch
    print("\n--- Testing signed tile fetch ---")
    import httpx
    tile_url = (
        f"{ctx.c3m_prefix}?style={C3M_STYLE}&v={region.version}"
        f"&region={region.region}&x=0&y=0&z=13&h=0"
    )
    signed = ctx.auth_url(tile_url)
    print(f"signed URL: {signed[:80]}...")

    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(signed)
        print(f"HTTP {r.status_code} ({len(r.content)} bytes)")
        if r.status_code == 403:
            print("\n*** TOKEN IS DEAD — 403 Forbidden ***")
            print("The extracted token does not authenticate against Apple's servers.")
            print("Need a newer token from a current Xcode/iOS simulator SDK.")
            sys.exit(1)
        elif r.status_code == 200:
            if r.content[:3] == b"C3M":
                print(f"SUCCESS: got C3M tile (v{r.content[3]}), {len(r.content)} bytes")
            elif r.headers.get("content-type", "").startswith("image/jpeg"):
                print("Got JPEG (no tile at this coordinate, but auth works)")
                print("SUCCESS: auth is valid — the server accepted our signed request")
            else:
                print(f"Got response: {r.content[:20]}...")
                print("Auth appears to work (200 OK)")
        else:
            print(f"Unexpected status {r.status_code}")
            print(f"Body: {r.content[:200]}")

    print("\n=== PHASE A COMPLETE ===")


if __name__ == "__main__":
    asyncio.run(main())
