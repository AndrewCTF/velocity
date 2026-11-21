# combine1090

Combine data from multiple dump1090 / readsb receivers (or other receivers providing beast protocol data)

Does not interfere with an already configured dump1090-fa / readsb but instead creates another instance with its own webinterface at /combine1090

Should work on the adsbexchange / piaware sd-card images.

## Alternative

For quite a few users, this could be an easier to use alternative: https://adsb.im/stage2
If you're looking for an all in one image with configuration via webinterface, give it a try.

## Installation:

```
sudo bash -c "$(wget -q -O - https://raw.githubusercontent.com/wiedehopf/combine1090/master/install.sh)"
```

or

```
wget -O /tmp/combine1090.sh https://raw.githubusercontent.com/wiedehopf/combine1090/master/install.sh
sudo bash /tmp/combine1090.sh
```

## Configuration:

Edit /etc/default/combine1090 to configure which IP addresses this script should get the ADS-B data from

```
sudo nano /etc/default/combine1090
```

Ctrl-x to exit, y (yes) to save when asked.
Then restart combine1090:

```
sudo systemctl restart combine1090 combine1090-dump
```

## Install data redirection only

```
sudo bash -c "$(wget -O - https://raw.githubusercontent.com/wiedehopf/combine1090/master/redirect-only.sh)"
```

Configure SOURCES (source ips), PORTs (source ports) and TARGET (target ip and port) in /etc/default/combine1090.
There will be no dedicated readsb started as a target for data redirection, you need to provide that target yourself.
Also as there is no extra readsb there will be no extra web page or lighttpd configuration.

## View the map:

Click the following URL and replace the IP address with the IP address of the Raspberry Pi you installed combine1090 on.

http://192.168.2.33/combine1090

### Deinstallation:

```
sudo bash -c "$(wget -q -O - https://raw.githubusercontent.com/wiedehopf/combine1090/master/uninstall.sh)"
```

---

### Questions? FAQ!

https://github.com/wiedehopf/adsb-wiki/wiki
https://github.com/wiedehopf/adsb-wiki/wiki/Raspbian-Lite%3A-ADS-B-receiver
