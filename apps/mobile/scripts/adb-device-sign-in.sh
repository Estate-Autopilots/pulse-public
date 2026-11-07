#!/usr/bin/env bash
# MOBILE-READY (27 Oct 2026): sign an adb-connected test phone in to the Pulse app with a one-time device code, for
# repeated QA runs. An admin makes the code on a signed-in device (Settings → Devices → Add a test device); pass its six
# digits, or its QR link, on the command line. Nothing is stored: no password and no code is ever written to a file.
#
#   apps/mobile/scripts/adb-device-sign-in.sh 123456 [adb-serial]
#   apps/mobile/scripts/adb-device-sign-in.sh 'https://pulse.estateautopilots.com/login/device#<token>' [adb-serial]
#
# PULSE_ORIGIN picks another install (default https://pulse.estateautopilots.com). ADB picks the adb binary.
set -euo pipefail
code=${1:?usage: adb-device-sign-in.sh <6-digit code | QR link> [adb-serial]}
ADB=${ADB:-adb}
args=(); [[ -n ${2:-} ]] && args=(-s "$2")
origin=${PULSE_ORIGIN:-https://pulse.estateautopilots.com}
open() { "$ADB" "${args[@]}" shell "am start -W -a android.intent.action.VIEW -d '$1' com.pulse.work.mobile" >/dev/null; }
if [[ $code =~ ^[0-9]{6}$ ]]; then
  open "$origin/login/device"
  sleep 4
  "$ADB" "${args[@]}" shell input text "$code"   # the code field has focus when the page opens
  "$ADB" "${args[@]}" shell input keyevent 66    # Enter: Sign in
elif [[ $code =~ ^https://[a-z0-9.-]+/login/device#[A-Za-z0-9_-]{43}$ ]]; then
  open "$code"
  sleep 4
  "$ADB" "${args[@]}" shell input keyevent 61    # Tab to Sign in (the only field on a scanned code's page)
  "$ADB" "${args[@]}" shell input keyevent 66
else
  echo "Pass the 6-digit code or the QR link from Settings → Devices → Add a test device." >&2; exit 2
fi
echo "Sent. The phone opens Pulse signed in, or shows why the code did not work (used, expired or cancelled)."
