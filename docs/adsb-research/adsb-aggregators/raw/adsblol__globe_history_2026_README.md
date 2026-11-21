# adsblol/globe_history_2026 (1762 GiB)

This database is made available under the Open Database License: http://opendatacommons.org/licenses/odbl/1.0/.

## What is it?

This database is a collection of all the data known to ADSB.lol, uploaded daily.

This includes data from ADSB.lol feeders [and friends](https://www.adsb.lol/docs/acknowledgements/partners/), [FlyItalyADSB](https://flyitalyadsb.com/) and [TheAirTraffic.com](https://theairtraffic.com)

## Releases

All files are downloadable from the [releases tab](https://github.com/adsblol/globe_history_2024/releases) of this repository.

See [RELEASES.md](RELEASES.md) for a formatted list of links.

Each release is 1 day of flight data.
Download both files from the prod or staging release for a day you're interested in.
(if prod or staging for that day is significantly smaller, ignore it)

The data is added to a tar archive and then the file is split.
To extract the data, adapt the following commands for the files you downloaded:

```
mkdir 2025.05.18
cat v2025.05.18-planes-readsb-prod-0.tar.aa v2025.05.18-planes-readsb-prod-0.tar.ab | tar -xf - -C 2025.05.18
```

## Technically

A dump of the /var/globe_history directory from adsb.lol planes containers.

_**[Documentation for the format of the files can be found at wiedehopf's readsb](https://github.com/wiedehopf/readsb/blob/dev/README-json.md#trace-jsons)**_

The planes containers serve [adsb.lol](https://adsb.lol). Prod is used, unless it is down then staging is used. There are two replicas of prod and one of staging.

The files in the heatmap directory are used for the [the replay functionality](https://adsb.lol?r).
The files in the traces folder are used when displaying the historic data for a specific aircraft.

The files are written by [readsb](https://github.com/wiedehopf/readsb) and are stored in gzip compressed json format.

# Acknowledgements

- **without people like you sharing their data**, there would be nothing to share. Together, we make an open dataset of flight records for the public.
- **The existing open source software**, adsb.lol is not much more than a [prod-ready configuration](https://github.com/adsblol/infra) of [readsb](https://github.com/wiedehopf/readsb), [tar1090](https://github.com/wiedehopf/tar1090), [mlat-server](https://github.com/wiedehopf/mlat-server).
- **GitHub**, for storing and serving open source / open data releases of aircraft flights history.
- Most other flight aggregators, with the exception of [ADSBHub](https://www.adsbhub.org/), [OpenSky Network](https://opensky-network.org/), for holding tight onto their data and giving me the motivation to show it is possible! :)
