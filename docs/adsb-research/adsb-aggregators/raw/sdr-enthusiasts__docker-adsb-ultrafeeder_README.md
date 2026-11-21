# sdr-enthusiasts/docker-adsb-ultrafeeder

- [sdr-enthusiasts/docker-adsb-ultrafeeder](#sdr-enthusiastsdocker-adsb-ultrafeeder)
  - [Introduction](#introduction)
  - [Up-and-Running Quickly with `docker-compose`](#up-and-running-quickly-with-docker-compose)
  - [Ports](#ports)
  - [Runtime Environment Variables](#runtime-environment-variables)
    - [General Configuration](#general-configuration)
      - [Basic Ultrafeeder Parameters](#basic-ultrafeeder-parameters)
        - [Mandatory Parameters](#mandatory-parameters)
        - [Optional Parameters](#optional-parameters)
    - [Getting ADSB data to the Ultrafeeder](#getting-adsb-data-to-the-ultrafeeder)
      - [Connecting to an SDR or other hardware device](#connecting-to-an-sdr-or-other-hardware-device)
        - [Mandatory parameters](#mandatory-parameters-1)
        - [Optional/Additional Parameters](#optionaladditional-parameters)
        - [Ultrafeeder AutoGain for RTLSDR Devices](#ultrafeeder-autogain-for-rtlsdr-devices)
          - [Using `readsb`'s built-in AutoGain (recommended)](#using-readsbs-built-in-autogain-recommended)
          - [Using the original AutoGain algorithm](#using-the-original-autogain-algorithm)
      - [Connecting to external ADSB data sources](#connecting-to-external-adsb-data-sources)
        - [All-in-One Configuration using `ULTRAFEEDER_CONFIG`](#all-in-one-configuration-using-ultrafeeder_config)
          - [`adsb` construct: connecting to an ADSB data source or sending ADSB data to another host or port](#adsb-construct-connecting-to-an-adsb-data-source-or-sending-adsb-data-to-another-host-or-port)
          - [`mlat` construct: sending MLAT data to a MLAT Server](#mlat-construct-sending-mlat-data-to-a-mlat-server)
          - [Integrate external MLAT return data with Ultrafeeder](#integrate-external-mlat-return-data-with-ultrafeeder)
          - [`ULTRAFEEDER_CONFIG` parameters](#ultrafeeder_config-parameters)
        - [Networking parameters](#networking-parameters)
        - [Feeding directly from Ultrafeeder](#feeding-directly-from-ultrafeeder)
        - [Alternate Configuration Method with `READSB_NET_CONNECTOR`](#alternate-configuration-method-with-readsb_net_connector)
      - [Optional Networking Parameters](#optional-networking-parameters)
      - [MLAT configuration](#mlat-configuration)
      - [MLAT troubleshooting](#mlat-troubleshooting)
      - [Configuring the built-in MLAT Hub](#configuring-the-built-in-mlat-hub)
    - [Web Gui (`tar1090`) Configuration](#web-gui-tar1090-configuration)
      - [`tar1090` Core Configuration](#tar1090-core-configuration)
      - [Using a locally modified tar1090 version](#using-a-locally-modified-tar1090-version)
      - [`tar1090` `config.js` Configuration - Title](#tar1090-configjs-configuration---title)
      - [`tar1090` `config.js` Configuration - Output](#tar1090-configjs-configuration---output)
      - [`tar1090` `config.js` Configuration - Map Settings](#tar1090-configjs-configuration---map-settings)
      - [`tar1090` `config.js` Configuration - Range Rings](#tar1090-configjs-configuration---range-rings)
      - [`tar1090` `config.js` Configuration - Expert](#tar1090-configjs-configuration---expert)
      - [`tar1090` `config.js` Configuration - Route Display](#tar1090-configjs-configuration---route-display)
      - [`tar1090` Configuration - Hints](#tar1090-configuration---hints)
    - [`graphs1090` Configuration](#graphs1090-configuration)
      - [`graphs1090` Environment Parameters](#graphs1090-environment-parameters)
      - [Enabling UAT data](#enabling-uat-data)
      - [Enabling AirSpy graphs](#enabling-airspy-graphs)
      - [Enabling Disk IO and IOPS data](#enabling-disk-io-and-iops-data)
      - [Configuring the Core Temperature graphs](#configuring-the-core-temperature-graphs)
      - [Reducing Disk IO for Graphs1090](#reducing-disk-io-for-graphs1090)
    - [`timelapse1090` Configuration](#timelapse1090-configuration)
  - [Updating your location with GPSD](#updating-your-location-with-gpsd)
    - [Basic Installation and Configuration of your GPS hardware and `gpsd` drivers](#basic-installation-and-configuration-of-your-gps-hardware-and-gpsd-drivers)
    - [Optional parameters regulating the restart of `mlat-client` when the location changes](#optional-parameters-regulating-the-restart-of-mlat-client-when-the-location-changes)
  - [Web Pages](#web-pages)
  - [Paths](#paths)
  - [Display of Metrics with Grafana and Prometheus/InfluxDB](#display-of-metrics-with-grafana-and-prometheusinfluxdb)
    - [Configuring Grafana](#configuring-grafana)
    - [Output from Ultrafeeder to Prometheus](#output-from-ultrafeeder-to-prometheus)
    - [Output from Ultrafeeder to InfluxDBv2](#output-from-ultrafeeder-to-influxdbv2)
  - [Message decoding introspection](#message-decoding-introspection)
  - [Minimalist setup](#minimalist-setup)
  - [Offline maps](#offline-maps)
  - [Logging](#logging)
  - [Getting help](#getting-help)
  - [License and Trademarks](#license-and-trademarks)
    - [GPLv3 License](#gplv3-license)
    - [Trademarks](#trademarks)
  - [Acknowledgements](#acknowledgements)

## Introduction

`adsb-ultrafeeder™` is an ADS-B data collector container that can be used to:

- retrieve ADS-B data from your SDR or other device
- display it on a local map, including options to show tracks, heatmaps, and system performance graphs
- forward the data to one or more aggregators using BEAST/BEAST-REDUCE/BEAST-REDUCE-PLUS format
- send MLAT data to these aggregators
- receive and consolidate MLAT results data (built-in `mlathub`)
- Interface with external visualization tools such as Grafana using statistics data available in InfluxDB and Prometheus format

In order to accomplish this, the container makes use of the following underlying technologies:

- SDR-Enthusiasts™ [Docker Base-Image](https://github.com/sdr-enthusiasts/docker-baseimage)
- [Wiedehopf's branch of `readsb`](https://github.com/wiedehopf/readsb)
- Wiedehopf's [tar1090](https://github.com/wiedehopf/tar1090) graphical interface
- Wiedehopf's [graphs1090](https://github.com/wiedehopf/graphs1090)
- [MLAT Client](https://github.com/adsbxchange/mlat-client.git)

It builds and runs on `linux/amd64`, `linux/arm/v7 (linux/armhf)` and `linux/arm64` architectures.
![ultrafeeder container architecture](https://github.com/sdr-enthusiasts/docker-adsb-ultrafeeder/assets/15090643/12b7f054-a77a-4c21-8f72-d0069cc9af84)

## Up-and-Running Quickly with `docker-compose`

- An example [`docker-compose.yml`](docker-compose.yml) file can be found in this repository.
- The accompanying environment variable values are defined in the [`.env`](.env) file in this repository

Once you have [installed Docker](https://github.com/sdr-enthusiasts/docker-install), you can follow these lines of code to get up and running in very little time:

```bash
sudo mkdir -p -m 777 /opt/adsb
cd /opt/adsb
wget https://raw.githubusercontent.com/sdr-enthusiasts/docker-adsb-ultrafeeder/main/docker-compose.yml
wget https://raw.githubusercontent.com/sdr-enthusiasts/docker-adsb-ultrafeeder/main/.env
```

Then edit the `docker-compose.yml` and `.env` files and make any changes as needed. Please configure ALL variables in `.env`:

```bash
nano docker-compose.yml
nano .env
```

Finally, bring up the stack. This may take a minute as it will automatically download the container and start it up:

```bash
docker compose up -d
```

## Ports

Some common ports are as follows (which may or may not be in use depending on your configuration). You can override the port mappings with the parameters shown in the [Optional Networking Parameters section](#optional-networking-parameters).

The general principle behind the port numbering, is:

- `30xxx` and `32xxx` ports are connected to the main instance `readsb` that decodes and processes the SDR data
- `31xxx` ports are connected to the MLAT Hub
- `92xx` ports are for Prometheus statistics output
- `80` contains the Tar1090 web interface

| Port                        | Details                                            |
| --------------------------- | -------------------------------------------------- |
| `30001/tcp`                 | Raw protocol input                                 |
| `30002/tcp`                 | Raw protocol output                                |
| `30003/tcp`                 | SBS/Basestation protocol output                    |
| `32006/tcp`                 | SBS/Basestation protocol input                     |
| `32009/tcp`                 | JAERO SBS/Basestation protocol input               |
| `30004/tcp`<br/>`30104/tcp` | Beast protocol input                               |
| `30005/tcp`                 | Beast protocol output                              |
| `30006/tcp`                 | Beast reduce protocol output                       |
| `30047/tcp`                 | Json position output                               |
| `31003/tcp`                 | MLATHUB SBS/Basestation protocol output            |
| `31004/tcp`                 | MLATHUB Beast protocol input                       |
| `31005/tcp`                 | MLATHUB Beast protocol output                      |
| `31006/tcp`                 | MLATHUB Beast-reduce protocol output               |
| `9273/tcp`                  | Prometheus http endpoint with data from `telegraf` |
| `9274/tcp`                  | Prometheus http endpoint with data from `readsb`   |
| `80/tcp`                    | Tar1090 (map) web interface                        |

Any of these ports can be made available to the host system by using the `ports:` directive in your `docker-compose.yml`. The container's web interface is rendered to port `80` in the container. This can be mapped to a port on the host using the docker-compose `ports` directive. In the example [`docker-compose.yml`](docker-compose.yml) file, the container's Tar1090 interface is mapped to `8080` on the host system, and ports `9273-9274` are exposed as-is:

```yaml
ports:
  - 8080:80 # to expose the web interface
  - 9273-9274:9273-9274 # to expose the statistics interface to Prometheus
```

Json position output:

- outputs an aircraft object for every new position received for an aircraft. The following parameters (which can be added with `READSB_EXTRA_ARGS`) control this output:
- `--net-json-port-interval` Set minimum interval between outputs per aircraft for TCP json output, default: 0.0 (every position)
- `--net-json-port-include-noposition` TCP json position output: include aircraft without position (state is sent for aircraft for every DF11 with CRC if the aircraft hasn't sent a position in the last 10 seconds and interval allowing)
- each json object will be on a new line
- <https://github.com/wiedehopf/readsb/blob/dev/README-json.md>

Aircraft.json:

- <https://github.com/wiedehopf/readsb/blob/dev/README-json.md>
- available on the same port as the web interface, example: `http://192.168.x.yy:8087/data/aircraft.json`

## Runtime Environment Variables

The sections below describe how to configure each part of the container functionality. Each section describes what's needed to come up with a minimally viable configuration, followed by additional / optional parameters that can also be set.

Note:

- to enable a parameter, you can set it to any of `1`, `true`, `on`, `enabled`, `enable`, `yes`, or `y`. In the table below, we'll simply use `true` for convenience.
- to disable a parameter, you can set it to anything else or simply leave it undefined.

### General Configuration

You need to make sure that the USB device can be accessed by the container. The best way to do so, is by adding the following to your `docker-compose.yml` file:

```yaml
device_cgroup_rules:
  - "c 189:* rwm"
...
volumes:
  - /dev/bus/usb:/dev/bus/usb:rw
```

The advantage of doing this (over simply adding a `device:` directive pointing at the USB port) is that the construction above will automatically recover if you "hot plug" your dongle. ⚠️This feature requires a recent version of docker-compose (version >=2.3). Make sure your system is up to date if dongles are not found. ⚠️

#### Basic Ultrafeeder Parameters

##### Mandatory Parameters

The following parameters must be set (mandatory) for the container to function:

| Environment Variable   | Purpose                                                                                                        | Default |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- | ------- |
| `LAT` or `READSB_LAT`  | The latitude of your antenna. Use either parameter, but not both                                               |         |
| `LONG` or `READSB_LON` | The longitude of your antenna. Use either parameter, but not both                                              |         |
| `ALT` or `READSB_ALT`  | The altitude of your antenna above sea level. For example, `15m` or `45ft`                                     |         |
| `TZ`                   | Your local timezone in [TZ-database-name](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones) format |         |

##### Optional Parameters

| Environment Variable          | Description                                                                                                                                                                                         | Controls which `readsb` option | Default   |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | --------- |
| `ENABLE_TIMELAPSE1090`        | Optional / Legacy. Set to `true` to enable timelapse1090. Once enabled, can be accessed via <http://dockerhost:port/timelapse/>.                                                                    | Unset                          |           |
| `READSB_EXTRA_ARGS`           | Optional, allows to specify extra parameters for readsb                                                                                                                                             | Unset                          |           |
| `READSB_DEBUG`                | Optional, used to set debug mode. `n`: network, `P`: CPR, `S`: speed check                                                                                                                          | Unset                          |           |
| `READSB_ENABLE_BIASTEE`       | Set to `true` to enable bias tee on supporting interfaces                                                                                                                                           |                                | Unset     |
| `READSB_RX_LOCATION_ACCURACY` | Accuracy of receiver location: 0: no location / internal use only, 1: 2 decimals, 2: exact (default), 3: 1 decimals, 4: 0 decimals (remove location from heywhatsthat panorama unless set to exact) | `--json-location-accuracy=<n>` | `2`       |
| `READSB_HEATMAP_INTERVAL`     | Per plane interval for heatmap and replay (if you want to lower this, also lower json-trace-interval to this or a lower value)                                                                      | `--heatmap=<sec>`              | `15`      |
| `READSB_MAX_RANGE`            | Absolute maximum range for position decoding (in nm)                                                                                                                                                | `--max-range=<dist>`           | `450`     |
| `READSB_STATS_EVERY`          | Number of seconds between showing and resetting stats.                                                                                                                                              | `--stats-every=<sec>`          | Unset     |
| `READSB_STATS_RANGE`          | Set this to `true` to collect range statistics for polar plot.                                                                                                                                      | `--stats-range`                | Unset     |
| `READSB_RANGE_OUTLINE_HOURS`  | Change which past timeframe the range outline is based on                                                                                                                                           | `--range-outline-hours`        | `24`      |
| `READSB_EXTRA_ARGS`           | Optional, allows to specify extra parameters for readsb                                                                                                                                             |                                | Unset     |
| `S6_SERVICES_GRACETIME`       | Optional, set shorter for faster container stop (orderly shutdown should not depend on this)                                                                                                        |                                | `3000`    |
| `LOGLEVEL`                    | `verbose` (all messages), `error` (errors only), `none` (minimal)                                                                                                                                   |                                | `verbose` |
| `MLAT_STARTUP_STAGGER`        | mlat-client startup staggering for tidy logs (reduce for quicker startup)                                                                                                                           |                                | `15`      |
| `MAX_GLOBE_HISTORY`           | Maximum number of days that `globe_history` data (heatmap / replay / traces) is retained. Note - this parameter doesn't affect the data used to produce `graphs1090` statistics                     |                                | Unset     |

`READSB_EXTRA_ARGS` just passes arguments to the commandline, you can check this file for more options for wiedehopf's readsb fork: <https://github.com/wiedehopf/readsb/blob/dev/help.h>

### Getting ADSB data to the Ultrafeeder

There are two ways to provide ADSB data to the Ultrafeeder:

- provide the container with access to an SDR or other hardware device that collects ADSB data
- allow the container to connect to a ADSB data source in Beast, Raw, or SBS format

These methods are not mutually exclusive - you can use both at the same time if you want.

#### Connecting to an SDR or other hardware device

If you want to connect your SDR to the container, here's how to do that:

##### Mandatory parameters

| Variable               | Description                                                                                                                           | Controls which `readsb` option | Default        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | -------------- |
| `READSB_DEVICE_TYPE`   | If using an SDR, set this to `rtlsdr`, `modesbeast`, `gnshulc` depending on the model of your SDR. If not using an SDR, leave un-set. | `--device-type=<type>`         | Unset          |
| `READSB_RTLSDR_DEVICE` | Select device by serial number.                                                                                                       | `--device=<serial>`            | Unset          |
| `READSB_BEAST_SERIAL`  | only when type `modesbeast` or `gnshulc` is used: Path to Beast serial device.                                                        | `--beast-serial=<path>`        | `/dev/ttyUSB0` |

##### Optional/Additional Parameters

| Variable | Description | Controls wh

... [OUTPUT TRUNCATED - 77,796 chars omitted out of 127,722 total] ...

00,150,200,250`|
|`TAR1090_RANGERINGSCOLORS`   | Colours for each of the range rings specified in`TAR1090_RANGERINGSDISTANCES`. Accepts a comma separated list of hex colour values, each enclosed in single quotes (e.g., `TAR1090_RANGERINGSCOLORS='#FFFFF','#00000'`). No spaces. | Unset             |
| `TAR1090_ENABLE_ACTUALRANGE` | Set to`true`or leave unset to enable the outline of the actual range of your station on the map; set to`false`to disable the this outline                                                                                        |`true` (enabled) |

#### `tar1090` `config.js` Configuration - Expert

| Environment Variable      | Purpose                                       | Default |
| ------------------------- | --------------------------------------------- | ------- |
| `TAR1090_CONFIGJS_APPEND` | Append arbitrary javascript code to config.js | Unset   |

- In case a setting is available in tar1090 but not exposed via environment variable for this container
- For a list of possible settings, see <https://github.com/wiedehopf/tar1090/blob/master/html/config.js>
- Incorrect syntax or any capitalization errors will cause the map to not load, you have been warned!
- Example: `TAR1090_CONFIGJS_APPEND= MapDim=false; nexradOpacity=0.2;`
- In the environment section of a compose file you can generally use multiple lines like this:

```yaml
    environment:
    ...
      - TAR1090_CONFIGJS_APPEND=
        MapDim=false;
        nexradOpacity=0.2;
    ...
```

#### `tar1090` `config.js` Configuration - Route Display

| Environment Variable  | Purpose                                            | Default                               |
| --------------------- | -------------------------------------------------- | ------------------------------------- |
| `TAR1090_USEROUTEAPI` | Set to `true` to enable route lookup for callsigns | Unset                                 |
| `TAR1090_ROUTEAPIURL` | API URL used                                       | `https://api.adsb.lol/api/0/routeset` |

#### `tar1090` Configuration - Hints

- If you want to reset the `tar1090` range outline, you can do so with this command:

```bash
docker exec -it ultrafeeder bash -c "echo resetRangeOutline > /run/readsb/setGain"
```

### `graphs1090` Configuration

#### `graphs1090` Environment Parameters

| Variable                                     | Description                                                                                                                               | Default        |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `GRAPHS1090_DARKMODE`                        | If set to `true`, `graphs1090` will be rendered in "dark mode".                                                                           | Unset          |
| `GRAPHS1090_RRD_STEP`                        | Interval in seconds to feed data into RRD files.                                                                                          | `60`           |
| `GRAPHS1090_SIZE`                            | Set graph size, possible values: `small`, `default`, `large`, `huge`, `custom`.                                                           | `custom`       |
| `GRAPHS1090_ALL_LARGE`                       | Make the small graphs as large as the big ones by setting to `yes`.                                                                       | `no`           |
| `GRAPHS1090_FONT_SIZE`                       | Font size (relative to graph size).                                                                                                       | `10.0`         |
| `GRAPHS1090_MAX_MESSAGES_LINE`               | Set to `true` to draw a reference line at the maximum message rate.                                                                       | Unset          |
| `GRAPHS1090_LARGE_WIDTH`                     | Defines the width of the larger graphs. (if size is set to custom)                                                                        | `1096`         |
| `GRAPHS1090_LARGE_HEIGHT`                    | Defines the height of the larger graphs. (if size is set to custom)                                                                       | `235`          |
| `GRAPHS1090_SMALL_WIDTH`                     | Defines the width of the smaller graphs. (if size is set to custom)                                                                       | `619`          |
| `GRAPHS1090_SMALL_HEIGHT`                    | Defines the height of the smaller graphs. (if size is set to custom)                                                                      | `324`          |
| `GRAPHS1090_RANGE_UNITS`                     | Units for range graph: nautical, statute or metric                                                                                        | `nautical`     |
| `GRAPHS1090_TEMP_UNITS`                      | Units for temperature graph: celsius or fahrenheit                                                                                        | `celsius`      |
| `GRAPHS1090_DISK_DEVICE`                     | Defines which disk device (`mmc0`, `sda`, `sdc`, etc) is shown. Leave empty for default device                                            | Unset          |
| `GRAPHS1090_ETHERNET_DEVICE`                 | Defines which (wired) ethernet device (`eth0`, `enp0s`, etc) is shown. Leave empty for default device                                     | Unset          |
| `GRAPHS1090_WIFI_DEVICE`                     | Defines which (wireless) WiFi device (`wlan0`, `wlp3s0`, etc) is shown. Leave empty for default device                                    | Unset          |
| `GRAPHS1090_DISABLE`                         | Set to `true` to disable the entire GRAPHS1090 web page and associated data collection                                                    | Unset          |
| `GRAPHS1090_DISABLE_CHART_CPU`               | Set to `true` to disable the GRAPHS1090 CPU chart                                                                                         | Unset          |
| `GRAPHS1090_DISABLE_CHART_TEMP`              | Set to `true` to disable the GRAPHS1090 Temperature chart                                                                                 | Unset          |
| `GRAPHS1090_DISABLE_CHART_MEMORY`            | Set to `true` to disable the GRAPHS1090 Memory Utilization chart                                                                          | Unset          |
| `GRAPHS1090_DISABLE_CHART_NETWORK_BANDWIDTH` | Set to `true` to disable the GRAPHS1090 Network Bandwidth chart                                                                           | Unset          |
| `GRAPHS1090_DISABLE_CHART_DISK_USAGE`        | Set to `true` to disable the GRAPHS1090 Disk Usage chart                                                                                  | Unset          |
| `GRAPHS1090_DISABLE_CHART_DISK_IOPS`         | Set to `true` to disable the GRAPHS1090 Disk IOPS chart                                                                                   | Unset          |
| `GRAPHS1090_DISABLE_CHART_DISK_BANDWIDTH`    | Set to `true` to disable the GRAPHS1090 Disk Bandwidth chart                                                                              | Unset          |
| `GRAPHS1090_WWW_TITLE`                       | Set title for the web page (displayed in the browser title or tab bar)                                                                    | `graphs1090`   |
| `GRAPHS1090_WWW_HEADER`                      | Set header text for the web page                                                                                                          | `Perf. Graphs` |
| `GRAPHS1090_HIDE_SYSTEM`                     | Hide the system graphs and don't render them, don't collect system data                                                                   | `no`           |
| `GRAPHS1090_DEFAULT_APPEND`                  | Append to /etc/default/graphs1090, see <https://github.com/wiedehopf/graphs1090/blob/master/default>                                      | Unset          |
| `GRAPHS1090_CPU_TEMP`                        | container internal path to thermal zone with CPU temp. defaults to /sys/class/thermal/thermal_zone0/temp                                  | Unset          |
| `GRAPHS1090_OTHER_TEMP1`                     | container internal path to file that the user must update with temperature in C divided by 1000                                           | Unset          |
| `GRAPHS1090_RANGE_INCLUDE_NONADSB`           | include non-ADSB positions in the range graph (HFDL, ADS-C, MLAT, TIS-B, Other)                                                           | False          |
| `ENABLE_AIRSPY`                              | Optional, set to any non-empty value if you want to enable the special AirSpy graphs. See below for additional configuration requirements | Unset          |
| `URL_AIRSPY`                                 | Optional, set to the URL where the airspy stats are available, for example `http://airspy_adsb`                                           | Unset          |
| `URL_1090_SIGNAL`                            | Optional. Retrieve gain and signal data from an URL where the readsb stats are available, i.e. `http://192.168.2.34/tar1090`              | Unset          |

#### Enabling UAT data

ADS-B over UAT data is transmitted in the 978 MHz band, and this is used in the USA only. To display the corresponding graphs, you should:

1. Set the following environment parameters:

```yaml
- ENABLE_978=yes
- URL_978=http://dump978/skyaware978
```

2. Install the [`docker-dump978` container](https://github.com/sdr-enthusiasts/docker-dump978). Note - only containers downloaded/deployed on/after Feb 8, 2023 will work.

Note that you _must_ configure `URL_978` to point at a working skyaware978 website with `aircraft.json` data feed. This means that the URL `http://dump978/skyaware978/data/aircraft.json` must return valid JSON data to this `tar1090` container.

#### Enabling AirSpy graphs

Users of AirSpy devices can enable extra `graphs1090` graphs by configuring the following:

1. Set the following environment parameters:

```yaml
- ENABLE_AIRSPY=yes
- URL_AIRSPY=http://airspy_adsb
```

2. Install the [`airspy_adsb` container](https://github.com/sdr-enthusiasts/airspy_adsb). Note - only containers downloaded/deployed on/after May 9th, 2024 will work with this method.

#### Enabling Disk IO and IOPS data

To allow the container access to the Disk IO data, you should map the following volume:

```yaml
    volumes:
      - /proc/diskstats:/proc/diskstats:ro
      ...
```

#### Configuring the Core Temperature graphs

By default, the system will use the temperature available at Thermal Zone 0. This generally works well on Raspberry Pi devices, and no additional changes are needed.

On different devices, the Core Temperature is mapped to a different Thermal Zone. To ensure the Core Temperature graph works, follow these steps

First check out which Thermal Zone contains the temperature you want to monitor. On your host system, do this:

```bash
for i in /sys/class/thermal/thermal_zone* ; do echo "$i - $(cat ${i}/type) - $(cat ${i}/temp 2>/dev/null)"; done
```

Something similar to this will be show:

```bash
/sys/class/thermal/thermal_zone0 - acpitz - 25000
/sys/class/thermal/thermal_zone1 - INT3400 Thermal - 20000
/sys/class/thermal/thermal_zone2 - TSKN - 43050
/sys/class/thermal/thermal_zone3 - NGFF - 32050
/sys/class/thermal/thermal_zone4 - TMEM - 39050
/sys/class/thermal/thermal_zone5 - pch_skylake - 40500
/sys/class/thermal/thermal_zone6 - B0D4 - 54050
/sys/class/thermal/thermal_zone7 - iwlwifi_1 -
/sys/class/thermal/thermal_zone8 - x86_pkg_temp - 57000
```

Repeat this a few times to ensure that the temperature varies and isn't hardcoded to a value. In our case, either Thermal Zone 5 (`pch_skylake` is the Intel Core name) or Thermal Zone 8 (the temp of the entire SOC package) can be used. Once you have determined which Thermal Zone number you want to use, map it to a volume like this. Make sure that the part to the left of the first `:` reflects your Thermal Zone directory; the part to the right of the first `:` should always be `/sys/class/thermal/thermal_zone0:ro`.

Note that you will have to add `- privileged: true` capabilities to the container. This is less than ideal as it will give the container access to all of your system devices and processes. Make sure you feel comfortable with this before you do this.

```yaml
    privileged: true
    volumes:
      - /sys/class/thermal/thermal_zone8:/sys/class/thermal/thermal_zone0:ro
      ...
```

Note - on some systems (DietPi comes to mind), `/sys/class/thermal/` may not be available.

#### Reducing Disk IO for Graphs1090

Note - _this feature is still somewhat experimental. If you are really attached to your statistics/graphs1090 data, please make sure to back up your mapped drives regularly_

If you are using a Raspberry Pi or another type of computer with an SD card, you may already be aware that these SD cards have a limited number of write-cycles that will determine their lifespan. In other words - a common reason for SD card failure is excessive writes to it.

By the nature of having to log lots of data the `graphs1090` functionality writes a lot to the SD card. To reduce the number of write cycles, there are a few parameters you can set.

Enabling this functionality will cause `graphs1090` to temporarily write all data to volatile memory (`/run`) instead of persistent disk space (`/var/lib/collectd`). This data is backed up to persistent disk space in regular intervals and upon (graceful) shutdown of the container.

Note -- there is a chance that the data isn't written back in time (due to power failures, non-graceful container shutdowns, etc), in which case you may lose statistics data that has been generated since the last write-back.

The feature assumes that you have mapped `/var/lib/collectd` to a volume (to ensure data is persistent across container recreations), and `/run` as a `tmpfs` RAM disk, as shown below and also as per the [`docker-compose.yml` example](docker-compose.yml):

```yaml
volumes:
  - /opt/adsb/ultrafeeder/globe_history:/var/globe_history
...
tmpfs:
  - /run:exec,size=256M
...
```

| Environment Variable              | Purpose                                                                                    | Default |
| --------------------------------- | ------------------------------------------------------------------------------------------ | ------- |
| `GRAPHS1090_REDUCE_IO=`           | Optional Set to `true` to reduce the write cycles for `graphs1090`                         | Unset   |
| `GRAPHS1090_REDUCE_IO_FLUSH_IVAL` | Interval (i.e. 1h, 6h, 24h, 1d, 2d) writing `graphs1090` data back to non-volatile storage | `1d`    |

### `timelapse1090` Configuration

Legacy: **We recommend AGAINST enabling this feature** as it has been replaced with <http://dockerhost:port/?replay>. `timelapse1090` writes a lot of data to disk, which could shorten the lifespan of your Raspiberry Pi SD card. The replacement functionality is better and doesn't cause any additional disk writes.

| Environment Variable     | Purpose                                                                                                                         | Default |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `ENABLE_TIMELAPSE1090`   | Optional / Legacy. Set to `true` to enable timelapse1090. Once enabled, can be accessed via <http://dockerhost:port/timelapse/> | Unset   |
| `TIMELAPSE1090_INTERVAL` | Snapshot interval in seconds                                                                                                    | `10`    |
| `TIMELAPSE1090_HISTORY`  | Time saved in hours                                                                                                             | `24`    |

## Updating your location with GPSD

This feature enables you to deploy Ultrafeeder while you are moving around. It will read your current longitude/latitude/altitude from a GPS unit that is connected to `gpsd` on your host system, and ensure that the map will show your current location. It will also restart any `mlat-client` instances once it detects that you moved from your previous location.

### Basic Installation and Configuration of your GPS hardware and `gpsd` drivers

The simplest way of getting this to work is to acquire a ["VK163" USB GPS "Mouse"](https://a.co/d/0D7Tj0n), similar to the one in the link. You can connect this mouse to any USB port on your machine.

For this to work, you should install and configure GPSD to work on your host machine. The `DEVICES` parameter is probably correct as shown below, but you may want to double-check that data is received on that device (`cat /dev/ttyACM0`) and adjust it if needed:

```bash
sudo apt update && sudo apt install -y gpsd
cat << EOM | sudo tee /etc/default/gpsd
# Devices gpsd should collect to at boot time.
# They need to be read/writeable, either by user gpsd or the group dialout.
DEVICES="/dev/ttyACM0"
# Other options you want to pass to gpsd
GPSD_OPTIONS="-G -p"
# Automatically hot add/remove USB GPS devices via gpsdctl
USBAUTO="true"
EOM
cat << EOM | sudo tee /lib/systemd/system/gpsd.socket
[Unit]
Description=GPS (Global Positioning System) Daemon Sockets

[Socket]
ListenStream=/run/gpsd.sock
ListenStream=[::]:2947
ListenStream=0.0.0.0:2947
SocketMode=0600
BindIPv6Only=yes

[Install]
WantedBy=sockets.target
EOM
sudo systemctl daemon-reload
sudo systemctl restart gpsd gpsd.socket
```

Then, you can add the following values to `ultrafeeder` service settings in `docker-compose.yml`:

```yaml
services:
...
  ultrafeeder:
    ...
    extra_hosts:
      - "host.docker.internal:host-gateway"
    ...
    environment:
      ULTRAFEEDER-CONFIG=
        gpsd,host.docker.internal,2947;
    ...
```

Finally, restart the container with `docker compose up -d`

This will:

- install and configure `gpsd` (`/etc/default/gpsd`) so it makes GPS data available on the default TCP port 2947 of your host system
- configure the ultrafeeder docker container to read GPSD data
- configure the ultrafeeder container so the hostname `host.docker.internal` always resolves to the IP address of the underlying machine (where `gpsd` is running)

If you have any issues, readsb will use verbose output if you add the `GPSD_DEBUG=true` as an environment variable.

### Optional parameters regulating the restart of `mlat-client` when the location changes

The following parameters are all optional and are subject to change. These variables should be added to the environment section of your docker-compose.yml. They will not work if entered into the .env file. You don't need to set them unless you want to change the default behavior.

| Environment Variable  | Purpose                                                                                                  | Default        |
| --------------------- | -------------------------------------------------------------------------------------------------------- | -------------- |
| `GPSD_MIN_DISTANCE`   | Distance (in meters) that your station must move before it's considered moving (maximum 40 meters)       | `20` (meters)  |
| `GPSD_MLAT_WAIT`      | The wait period (in seconds) your station must be stationary before mlat is started (minimum 90 seconds) | `90` (seconds) |
| `GPSD_CHECK_INTERVAL` | How often the container checks for updated location information. (minimum 5 seconds)                     | `30` (seconds) |

See example below:

```yaml
    environment:
    ...
      - GPSD_MIN_DISTANCE=20
      - GPSD_MLAT_WAIT=90
      - GPSD_CHECK_INTERVAL=30
    ...
```

## Web Pages

If you have configured the container as described above, you should be able to browse to the following web pages:
You should now be able to browse to:

- <http://dockerhost/> to access the tar1090 web interface.
- <http://dockerhost/?replay> to see a replay of past data
- <http://dockerhost/?heatmap> to see the heatmap for the past 24 hours
- <http://dockerhost/?heatmap&realHeat> to see a different heatmap for the past 24 hours
- <http://dockerhost/?pTracks> to see the tracks of all planes for the past 24 hours
- <http://dockerhost/graphs1090/> to see performance graphs

## Paths

No paths need to be mapped through to persistent storage. However, if you don't want to lose your range outline and aircraft tracks/history and heatmap / replay data on container restart, you can optionally map these paths:

| Path                                                                   | Purpose                                                                                                                                                                              |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/opt/adsb/ultrafeeder/globe_history:/var/globe_history`               | Holds range outline data, heatmap / replay data and traces if enabled. _Note: this data won't be automatically deleted, you will need to delete it eventually if you map this path._ |
| `/opt/adsb/ultrafeeder/timelapse1090:/var/timelapse1090`               | Holds timelapse1090 data if enabled. (We recommend against enabling this feature, see above)                                                                                         |
| `/opt/adsb/ultrafeeder/collectd:/var/lib/collectd`                     | Holds graphs1090 & performance data                                                                                                                                                  |
| `/proc/diskstats:/proc/diskstats:ro`                                   | Makes disk statistics available to `graphs1090`                                                                                                                                      |
| `/sys/class/thermal/thermal_zone8:/sys/class/thermal/thermal_zone0:ro` | Only needed on some systems to display the CPU temperature in `graphs1090`, see [temp configuration](#configuring-the-core-temperature-graphs)                                       |

## Display of Metrics with Grafana and Prometheus/InfluxDB

When using the `:telegraf` tag, the image contains [Telegraf](https://docs.influxdata.com/telegraf/), which can be used to capture metrics from `ultrafeeder` if an output is enabled.

See [README-grafana.md](README-grafana.md) for detailed instruction on how to configure this.

**NOTE - READ CAREFULLY**: As of 27 April 2023, the `latest` image no longer contains Telegraf. If you want to send metrics to InfluxDB or Prometheus, please use this image:

```yaml
services:
  ultrafeeder:
    image: ghcr.io/sdr-enthusiasts/docker-adsb-ultrafeeder:telegraf
  ...
```

### Configuring Grafana

Please see the [separate instruction document](README-grafana.md) for step by step instructions on how to set up and configure a Grafana Dashboard with Prometheus. The sections below are provided as a reference.

### Output from Ultrafeeder to Prometheus

In order for Telegraf to serve a [Prometheus](https://prometheus.io) endpoint, the following environment variables can be used:

| Variable            | Description                                                              |
| ------------------- | ------------------------------------------------------------------------ |
| `PROMETHEUS_ENABLE` | Set to `true` for a Prometheus endpoint on `http://0.0.0.0:9273/metrics` |

### Output from Ultrafeeder to InfluxDBv2

In order for Telegraf to output metrics to an [InfluxDBv2](https://docs.influxdata.com/influxdb/) time-series database, the following environment variables can be used:

| Variable            | Description                         |
| ------------------- | ----------------------------------- |
| `INFLUXDBV2_URL`    | The URL of the InfluxDB instance    |
| `INFLUXDBV2_TOKEN`  | The token for authentication        |
| `INFLUXDBV2_BUCKET` | Destination bucket to write into    |
| `INFLUXDBV2_ORG`    | InfluxDB Organization to write into |

## Message decoding introspection

You can look at individual messages and what information they contain, either for all or for an individual aircraft by hex:

```bash
# only for hex 3D3ED0
docker exec -it ultrafeeder /usr/local/bin/viewadsb --show-only 3D3ED0

# for all aircraft
docker exec -it ultrafeeder /usr/local/bin/viewadsb --no-interactive

# show position / CPR debugging for hex 3D3ED0
docker exec -it ultrafeeder /usr/local/bin/viewadsb --cpr-focus 3D3ED0
```

## Minimalist setup

If you want to use `ultrafeeder` _only_ as a SDR decoder but without any mapping or stats/graph websites, without MLAT connections or MLAT-hub, etc., for example to minimize CPU and RAM needs on a low CPU/memory single board computer, then do the following:

- in the `ULTRAFEEDER_CONFIG` parameter, remove any entry that starts with `mlat` or `mlathub`. This will prevent any `mlat-client`s or `mlathub` instances to be launched. If you still want to connect the `mlat-client`(s) to external MLAT servers but you don't want to run the overhead of a MLATHUB, you can leave any entries starting with `mlat` in the `ULTRAFEEDER_CONFIG` parameter, and set `MLATHUB_DISABLE=true`
- Set the parameter `TAR1090_DISABLE=true`. This will prevent the `nginx` webserver and any websites to be launched and no graphs1090 or heatmap data to be collected.
- Make sure to use `ghcr.io/sdr-enthusiasts/docker-adsb-ultrafeeder:latest` and specifically NOT the `ghcr.io/sdr-enthusiasts/docker-adsb-ultrafeeder:telegraf` label as Telegraf adds a LOT of resource use to the container

## Offline maps

There is the option to use some basic offline maps limited in zoom:

- Download the tiles (don't install tar1090): <https://github.com/wiedehopf/adsb-wiki/wiki/offline-map-tiles-tar1090>
- Add a volume mapping so the container can access the tiles. (If you're using an [ADSB.im](https://my.adsb.im/home) image this is already complete at first boot):

```yaml
volumes:
  - /usr/local/share/osm_tiles_offline:/usr/local/share/osm_tiles_offline
```

- Find the container ID of ultrafeeder:

```bash
docker ps
```

- Initiate a bash session inside the container:

```bash
docker exec -it <containerID> sh
```

- Run the tar1090 install/update script to recognize the offline files and modify the web interface:

```bash
./tar1090-install.sh
```

- You should now see a layer under 'Worldwide' at the top called 'OpenStreetMap Offline'

## Logging

All logs are to the container's stdout and can be viewed with `docker logs -t [-f] container`.

## Getting help

Please feel free to [open an issue on the project's GitHub](https://github.com/sdr-enthusiasts/docker-tar1090/issues).

We also have a [Discord channel](https://discord.gg/sTf9uYF), feel free to [join](https://discord.gg/sTf9uYF) and converse.

## License and Trademarks

### GPLv3 License

Copyright (C) 2023-2026, Ramon F. Kolb kx1t, and other contributors

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

### Trademarks

- `ultrafeeder`, `Ultrafeeder`, `docker-adsb-ultrafeeder` are Trademarks owned by Ramon F. Kolb and the SDR-Enthusiasts organization
- `SDR-Enthusiasts` and `SDR-E` are a Trademark owned by the SDR-Enthusiasts organization
- Other terms are trademarks of their respective owners

## Acknowledgements

- The [SDR-Enthusiasts team](https://github.com/sdr-enthusiasts) ([Mike Nye](https://github.com/mikenye), [Fred Clausen](https://github.com/fredclausen)) for all the foot and leg work done to create the base images on which the container is built
- [Wiedehopf](https://github.com/wiedehopf) for modifying, creating, maintaining, and adding features to many of the components of this container including [readsb](https://github.com/wiedehopf/readsb), [tar1090](https://github.com/wiedehopf/tar1090), [graphs1090](https://github.com/wiedehopf/graphs1090), [autogain](https://github.com/wiedehopf/adsb-scripts/wiki/Automatic-gain-optimization-for-readsb-and-dump1090-fa), and many more components, and for helping debug the container whenever the need arose
- [John Norrbin](https://github.com/Johnex) for his ideas, testing, feature requests, more testing, nagging, pushing, prodding, and overall efforts to make this a high quality container and for the USB "hotplug" configuration
- The community at the [SDR-Enthusiasts Discord Server](https://discord.gg/sTf9uYF) for helping out, testing, asking questions, and generally driving to make this a better product
- Of course the Open Source community at large, including [Salvatore Sanfilippo](https://github.com/antirez) and [Oliver Jowett](https://github.com/mutability) who wrote the excellent base code for `dump1090` from which much of this package is derived
