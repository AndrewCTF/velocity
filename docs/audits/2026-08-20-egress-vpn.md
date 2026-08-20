# egress reachability — 2026-08-20 23:31:20

Exit: {'ip': '159.26.115.142', 'city': 'Singapore', 'country': 'SG', 'org': 'AS208172 Proton AG'}
Upstream hosts referenced in apps/api/app: 319

**Reached 287 of 319.**

| class | n |
|---|---|
| `BLOCKED` | 14 |
| `timeout` | 3 |
| `tls-fail` | 2 |
| `conn-fail` | 2 |
| `dns-fail` | 5 |
| `ua-blocked` | 1 |
| `needs-key` | 9 |
| `reached-4xx5xx` | 68 |
| `ok` | 210 |

### BLOCKED (14)

| host | status | browser UA | declared in |
|---|---|---|---|
| `api.airplanes.live` | 403 | 403 | `routes/adsb.py` |
| `api.planespotters.net` | 403 | 403 | `routes/entity.py` |
| `archive.liveatc.net` | 403 | 403 | `routes/source_catalog.py` |
| `jldc.me` | 403 | 403 | `osint/sources/infra.py` |
| `noaa-nexrad-level2.s3.amazonaws.com` | 403 | 403 | `routes/source_catalog.py` |
| `riotimesonline.com` | 403 | 403 | `news/feeds_register.py` |
| `tile.googleapis.com` | 403 | 403 | `routes/source_catalog.py` |
| `tvn24.pl` | 403 | 403 | `news/feeds_register.py` |
| `wsprnet.org` | 403 | 403 | `routes/source_catalog.py` |
| `www.dawn.com` | 403 | timeout | `news/feeds_register.py` |
| `www.liveatc.net` | 403 | 403 | `routes/source_catalog.py` |
| `www.politico.eu` | 403 | 403 | `news/feeds_register.py` |
| `www.reddit.com` | 403 | 403 | `osint/connectors.py` |
| `www.washingtontimes.com` | 403 | 403 | `news/feeds_register.py` |

### timeout (3)

| host | status | browser UA | declared in |
|---|---|---|---|
| `api.gdeltproject.org` | timeout | — | `routes/events.py` |
| `api.ioda.caida.org` | timeout | — | `routes/cyber.py` |
| `cdn.kartaview.com` | timeout | — | `intel/ground.py` |

### tls-fail (2)

| host | status | browser UA | declared in |
|---|---|---|---|
| `insecam.org` | tls-fail | — | `routes/mega_feeds.py` |
| `www.presstv.ir` | tls-fail | — | `news/feeds_register.py` |

### conn-fail (2)

| host | status | browser UA | declared in |
|---|---|---|---|
| `data.3dbag.nl` | conn-fail | — | `routes/source_catalog.py` |
| `globe.adsb.lol` | conn-fail | — | `routes/adsb.py` |

### dns-fail (5)

| host | status | browser UA | declared in |
|---|---|---|---|
| `api.acleddata.com` | dns-fail | — | `routes/events.py` |
| `api.bgpview.io` | dns-fail | — | `osint/sources/netblock.py` |
| `api.openownership.org` | dns-fail | — | `osint/sources/corp.py` |
| `columbus.elmasy.com` | dns-fail | — | `osint/sources/infra.py` |
| `phishstats.info:2096` | dns-fail | — | `osint/sources/threat_feeds.py` |

### ua-blocked (1)

| host | status | browser UA | declared in |
|---|---|---|---|
| `www.un.org` | 403 | 200 | `intel/sanctions.py` |
