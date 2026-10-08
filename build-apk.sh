#!/usr/bin/env bash
# Build the installable APK. Run scripts/prepare-apk.mjs first.
set -euo pipefail
cd "$(dirname "$0")"

export JAVA_HOME="$PWD/tools/jdk/jdk-17.0.11+9/Contents/Home"
export ANDROID_HOME="$PWD/tools/android-sdk"
export PATH="$JAVA_HOME/bin:$PWD/tools/platform-tools:$PATH"

# Bubblewrap stores absolute tool paths globally; if the project moved, fix them.
if ! grep -q "\"jdkPath\": \"$PWD/tools/jdk" "$HOME/.bubblewrap/config.json" 2>/dev/null; then
  echo "  · toolchain paths look stale — running ./setup.sh"
  ./setup.sh >/dev/null
fi

if [ ! -f twa-manifest.json ]; then
  echo ""
  echo "  No twa-manifest.json yet. Run this first, with your hosted URL:"
  echo "    node scripts/prepare-apk.mjs https://<your-site>/"
  echo ""
  exit 1
fi

HOST=$(node -p "require('./twa-manifest.json').host")
echo ""
echo "  Building Digital Clay for  https://$HOST"
echo "  First build downloads Gradle and takes several minutes. It is not stuck."
echo ""

# Verify the site's half of the handshake is actually live before building,
# because a missing assetlinks.json fails silently at launch instead of here.
AL="https://$HOST/.well-known/assetlinks.json"
if curl -sfL --max-time 15 "$AL" | grep -q "$(node -p "require('./twa-manifest.json').packageId")"; then
  echo "  ✓ assetlinks.json is live and names this package"
else
  echo "  ⚠  Could not verify $AL"
  echo "     The APK will build, but the immersive app will refuse to launch"
  echo "     until that file is served from the origin root."
fi
echo ""

# update scaffolds/refreshes the Android project from twa-manifest.json;
# build then runs Gradle to compile and sign the APK.
npx bubblewrap update
npx bubblewrap build --skipPwaValidation

echo ""
echo "  Done. To install on a connected headset:"
echo "    ./tools/platform-tools/adb install -r app-release-signed.apk"
echo ""
