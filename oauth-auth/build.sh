#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
BUILD="$ROOT/local-src/oauth-auth"
mkdir -p "$BUILD"
npx pkg "$BUILD/service-entry.cjs" --targets node18-linux-x64 --output "$ROOT/bin/kin-oauth-auth"
chmod 755 "$ROOT/bin/kin-oauth-auth"
printf '%s\n' "$ROOT/bin/kin-oauth-auth"
