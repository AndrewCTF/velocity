# egress reachability — 2026-08-21 22:24:56

Exit: {'ip': '159.26.115.35', 'city': 'Singapore', 'country': 'SG', 'org': 'AS208172 Proton AG'}
Upstream hosts referenced in apps/api/app: 319

**Reached 221 of 240.** (79 not probed: catalog metadata or an unsubstituted placeholder)

| class | n |
|---|---|
| `BLOCKED` | 9 |
| `timeout` | 2 |
| `tls-fail` | 1 |
| `dns-fail` | 4 |
| `ua-blocked` | 1 |
| `throttled` | 1 |
| `needs-key` | 5 |
| `reached-4xx5xx` | 39 |
| `ok` | 176 |
| `template-only` | 28 |
| `catalog-only` | 51 |

### BLOCKED (9)

| host | status | browser UA | declared in |
|---|---|---|---|
| `api.airplanes.live` | 403 | 403 | `routes/adsb.py` |
| `api.planespotters.net` | 403 | 403 | `routes/entity.py` |
| `jldc.me` | 403 | 403 | `osint/sources/infra.py` |
| `riotimesonline.com` | 403 | 403 | `news/feeds_register.py` |
| `tvn24.pl` | 403 | 403 | `news/feeds_register.py` |
| `www.dawn.com` | 403 | 403 | `news/feeds_register.py` |
| `www.politico.eu` | 403 | 403 | `news/feeds_register.py` |
| `www.reddit.com` | 403 | 403 | `osint/connectors.py` |
| `www.washingtontimes.com` | 403 | 403 | `news/feeds_register.py` |

### timeout (2)

| host | status | browser UA | declared in |
|---|---|---|---|
| `api.ioda.caida.org` | timeout | — | `routes/cyber.py` |
| `eonet.gsfc.nasa.gov` | timeout | — | `routes/events.py` |

### tls-fail (1)

| host | status | browser UA | declared in |
|---|---|---|---|
| `www.presstv.ir` | tls-fail | — | `news/feeds_register.py` |

### dns-fail (4)

| host | status | browser UA | declared in |
|---|---|---|---|
| `api.acleddata.com` | dns-fail | — | `routes/events.py` |
| `columbus.elmasy.com` | dns-fail | — | `osint/sources/infra.py` |
| `phishstats.info:2096` | dns-fail | — | `osint/sources/threat_feeds.py` |
| `www.rt.com` | dns-fail | — | `news/feeds_register.py` |

### ua-blocked (1)

| host | status | browser UA | declared in |
|---|---|---|---|
| `www.un.org` | 403 | 200 | `intel/sanctions.py` |
