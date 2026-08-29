# airplanes.live — access request (draft, not sent)

`api.airplanes.live` answers this deployment's egress with HTTP 403 on every
verb tried (`/v2/all-with-pos`, `/v2/point/{lat}/{lon}/{r}`, `/v2/mil`) and a
body that asks for exactly this:

```json
{"error": "Please contact us at contact@airplanes.live. Your email MUST include
 any links, a description of the project, and any information you deem
 appropriate."}
```

Nothing in the codebase can or should route around that. The tier is switched
off for this deployment via `ADSB_DISABLED_HOSTS=api.airplanes.live`, and the
host stays in `_HEAD_HOSTS` so a deployment they have not banned keeps it.

**To send:** review, adjust the usage numbers if they are wrong, and send from
the address that owns the project. Then delete `ADSB_DISABLED_HOSTS` from
`apps/api/.env` if access is restored.

---

**To:** contact@airplanes.live
**Subject:** API access for Velocity — open-source OSINT situational-awareness console

Hello,

I maintain Velocity (https://github.com/AndrewCTF/velocity), an open-source,
self-hosted situational-awareness console that fuses keyless public feeds —
ADS-B, AIS, satellites, seismic, weather, hazards and news — onto one map. It is
AGPL, non-commercial, and run mostly by individual analysts and researchers on
their own machines.

I am writing because requests from my address now receive a 403 pointing here,
and I would rather understand your terms than work around them.

How the project uses your data:

- One global snapshot cycle backing a live map, plus a coarse grid for
  dense-airspace freshness. Concurrency is capped at 8 in-flight requests and
  each grid cell is cached for 30 seconds, which works out to roughly 4-5
  requests per second in steady state.
- Nothing is redistributed as a bulk feed or resold. Data is rendered to the
  operator running the instance and is not persisted beyond a short local
  history window.
- Attribution is shown per layer in the UI, and commercial mode drops
  non-commercial sources entirely.

If that volume is the problem I can reduce it, move to a longer cache TTL, or
identify traffic with a dedicated User-Agent — whatever you prefer. If you would
rather the project did not use airplanes.live at all, tell me and I will remove
the tier; it is already disabled on my deployment pending your reply.

Happy to answer anything else that would help.

Thanks for running the service,

Andrew
https://github.com/AndrewCTF/velocity
