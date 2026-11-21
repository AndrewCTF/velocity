# Density maps from one day of open ADS-B data

Two small scripts behind the "24 hours of air traffic over …" maps. They read
[adsb.lol's daily open-data release](https://github.com/adsblol/globe_history_2026)
(ODbL-1.0), not Velocity's own archive, so you can run them without the app.

![24 hours of air traffic over Germany, 17 November 2026](../../docs/media/density-germany-2026-11-17.jpg)

## Get a day of data

Each day is a release of ~3 GB, split into `.tar.aa`, `.tar.ab`, … parts. Join
them and keep only the per-aircraft traces:

```bash
gh release download v2026.11.18-planes-readsb-prod-0 -R adsblol/globe_history_2026
mkdir 2026-11-18 && cat v2026.11.18-planes-readsb-prod-0.tar.* | tar -x -C 2026-11-18 --wildcards './traces/*'
```

## Draw a map

```bash
pip install numpy matplotlib pillow
# day dir, output, then the box: west south east north (degrees), optional width in px
python density.py 2026-11-18 germany.png 5.5 47.2 15.5 55.1 2600
# optional: GeoJSON borders/coastlines drawn faintly on top (e.g. Natural Earth admin-0)
python density.py 2026-11-18 germany.png 5.5 47.2 15.5 55.1 2600 ne_50m_admin_0.geojson
```

Every position report adds one to its pixel; brightness is the log of the
count. Low traffic only shows near a receiver, so dark areas can mean "nobody
feeding there" rather than "nobody flying".

## Ask what made a bright spot

```bash
# day dir, lat, lon, radius km, optional max altitude ft
python near.py 2026-11-18 54.35 9.8 60 5000
```

Prints the aircraft types and registrations with the most positions inside
that circle, which is how you tell a flight school from a military training area.

## Want it live instead?

Velocity records the same kind of data continuously from public feeds and lets
you rewind the map to any moment: see the [Quick start](../../README.md#quick-start).
