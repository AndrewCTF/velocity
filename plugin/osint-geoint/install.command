#!/bin/bash
# macOS double-click wrapper - runs the POSIX installer in Terminal.
set -euo pipefail
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$dir/install.sh" "$@"
