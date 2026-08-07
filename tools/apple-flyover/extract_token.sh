#!/bin/bash
# Extract tokenP1 and resourceManifestURL from Apple's iPhone Simulator SDK.
# Downloads ~2 GB, needs ~6 GB temp space. Outputs config.json.
set -Eeuo pipefail

e() { printf "\033[0;31m%s\033[0m\n" "$1" >&2; }

command -v curl >/dev/null || command -v wget >/dev/null || { e "need curl or wget"; exit 1; }
command -v 7z >/dev/null || { e "need 7z (apt install p7zip-full)"; exit 1; }
command -v strings >/dev/null || { e "need strings (apt install binutils)"; exit 1; }

printf '\e[33mThis downloads ~2 GB from Apple and uses ~6 GB temporary disk space.\033[0m\n' >&2
read -rp $'\e[33mContinue? (y/n): \033[0m' x && [ "$x" = "y" ] || exit 1

dmg="com.apple.pkg.iPhoneSimulatorSDK10_3-10.3.1.1495751597.dmg"
gs='./Contents/Resources/RuntimeRoot/System/Library/PrivateFrameworks/GeoServices.framework/GeoServices'
dq="?application=geod&application_version=1&country_code=US&hardware=MacBookPro11,2&os=osx&os_build=20B29&os_version=11.0.1"

tmp="$(mktemp -d)"
echo "Temp dir: $tmp" >&2
cd "$tmp"

dl() {
    if command -v wget >/dev/null; then wget -q --show-progress "$1" -O "$2"
    else curl -# --fail -L "$1" > "$2"; fi
}

echo "Downloading SDK..." >&2
dl "https://devimages-cdn.apple.com/downloads/xcode/simulators/$dmg" "$dmg"

echo "Extracting..." >&2
7z x "$dmg" '*/*.pkg' -bsp2 >/dev/null
rm "$dmg"
pkg="$(find . -name "*.pkg" -type f)"
7z x "$pkg" Payload~ -bsp2 >/dev/null
rm "$pkg"
7z x Payload~ "$gs" -bsp2 >/dev/null
rm Payload~

base_url="$(strings "$gs" | grep 'config%{DEVICE_QUERY}' | tr '%' '\n' | head -n1)"
token="$(strings "$gs" | grep 'xyzABC' -A1 | tail -n1)"

if [ -z "$token" ]; then
    e "Could not extract token from GeoServices binary"
    cd .. && rm -rf "$tmp"
    exit 1
fi

out="${OLDPWD}/config.json"
cat > "$out" <<EOF
{
  "resourceManifestURL": "${base_url}${dq}",
  "tokenP1": "${token}"
}
EOF

cd .. && rm -rf "$tmp"
printf "\033[0;32mWrote %s\033[0m\n" "$out" >&2
