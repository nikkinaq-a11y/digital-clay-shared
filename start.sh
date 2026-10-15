#!/usr/bin/env bash
# Digital Clay — bring up the dev server and bridge it to the headset.
#
#   ./start.sh
#
# The headset reaches the server as http://localhost:8080 through `adb reverse`.
# That matters: WebXR only runs in a secure context, and localhost counts as one.
# Serving over the LAN IP would be plain HTTP, and the browser would refuse.

set -u
cd "$(dirname "$0")"
export PATH="$PWD/tools/platform-tools:$PATH"
PORT="${PORT:-8080}"

echo ""
echo "  Digital Clay"
echo "  ═════════════════════════════════════════════"

# ── headset bridge ───────────────────────────────────────────────────────────
DEVICES=$(adb devices | awk 'NR>1 && $2=="device" {print $1}')
UNAUTH=$(adb devices | awk 'NR>1 && $2=="unauthorized" {print $1}')

if [ -n "$UNAUTH" ]; then
  echo "  ⚠  Headset is connected but not authorised."
  echo "     Put the headset on — there is an 'Allow USB debugging' prompt"
  echo "     waiting in there. Tick 'Always allow', accept, then re-run this."
  echo ""
elif [ -z "$DEVICES" ]; then
  echo "  ⚠  No headset detected over USB."
  echo ""
  echo "     Checklist:"
  echo "       1. Meta Horizon phone app → your Quest 3 → Headset settings"
  echo "          → Developer Mode → ON   (no developer organisation needed)"
  echo "       2. Reboot the headset after switching it on"
  echo "       3. Use a USB-C cable that carries data, not just power"
  echo "       4. Accept the 'Allow USB debugging' prompt inside the headset"
  echo ""
  echo "     Starting the server anyway — you can still open the page on this Mac."
  echo ""
else
  for D in $DEVICES; do
    adb -s "$D" reverse "tcp:$PORT" "tcp:$PORT" >/dev/null 2>&1 \
      && echo "  ✓ bridged $D  →  http://localhost:$PORT in the headset" \
      || echo "  ✗ could not bridge $D"
  done
  echo ""
  # Push the URL straight to the headset browser — typing an address on a
  # virtual keyboard is the worst part of this loop, so skip it.
  for D in $DEVICES; do
    adb -s "$D" shell am start -a android.intent.action.VIEW \
        -d "http://localhost:$PORT" >/dev/null 2>&1 \
      && echo "  ✓ opened the page in the headset browser" \
      || echo "  · could not auto-open — in the headset, open Browser and type localhost:$PORT"
  done
  echo ""
  echo "     Put the headset on. The page is floating in front of you."
  echo "     Press 'Enter passthrough', then pinch to sculpt."
  echo ""
  echo "     Debugging: open Chrome on this Mac at  chrome://inspect"
  echo "     Your headset tab appears there with full DevTools —"
  echo "     console, breakpoints, the lot, running live in the headset."
  echo ""
fi

# ── server ───────────────────────────────────────────────────────────────────
exec node serve.js
