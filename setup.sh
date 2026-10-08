#!/usr/bin/env bash
# Run this after moving or copying the project to a new location.
#
# Everything in this folder uses relative paths except one thing: Bubblewrap
# keeps a global config at ~/.bubblewrap/config.json pointing at the JDK and
# Android SDK, and those are absolute. This rewrites it for wherever you are now.

set -euo pipefail
cd "$(dirname "$0")"
ROOT="$PWD"

JDK="$ROOT/tools/jdk/jdk-17.0.11+9"
SDK="$ROOT/tools/android-sdk"

echo ""
echo "  Digital Clay — setup"
echo "  ────────────────────────────────────────"
echo "  project root   $ROOT"

MISSING=0
for D in "$JDK" "$SDK" "$ROOT/tools/platform-tools"; do
  if [ ! -d "$D" ]; then echo "  ✗ missing  ${D#$ROOT/}"; MISSING=1; fi
done

if [ "$MISSING" = "1" ]; then
  echo ""
  echo "  The toolchain in tools/ is missing. It is excluded from git because"
  echo "  it is ~750 MB. To rebuild it, see docs/PROGRESS.md → Toolchain."
  echo ""
else
  mkdir -p "$HOME/.bubblewrap"
  cat > "$HOME/.bubblewrap/config.json" <<JSON
{
  "jdkPath": "$JDK",
  "androidSdkPath": "$SDK"
}
JSON
  echo "  ✓ pointed ~/.bubblewrap/config.json at this copy"
fi

chmod +x start.sh build-apk.sh setup.sh 2>/dev/null || true

if [ ! -d node_modules ]; then
  echo "  · installing npm dependencies…"
  npm install --no-audit --no-fund --silent
fi

echo "  ✓ ready — run ./start.sh"
echo ""
