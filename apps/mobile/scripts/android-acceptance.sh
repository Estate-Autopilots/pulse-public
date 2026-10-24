#!/usr/bin/env bash
# Emulator acceptance for Pulse for Android (the Capacitor shell), against production Pulse, without a Pulse account
# and without touching any data:
#   1. upgrade in place: the published Expo 1.0.0 APK, then this APK over it (same package, same key, higher code);
#   2. a cold launch shows the sign-in page;
#   3. Android back goes back through Pulse, and at the start it minimises (the app keeps running);
#   4. with no network the shell's own offline screen appears, Retry works, and Pulse returns by itself;
#   5. the notification permission flow: Android's prompt, Allow, and a confirmation notification.
# Usage: android-acceptance.sh NEW_APK [PUBLISHED_EXPO_APK] [OUT_DIR]
set -euo pipefail
NEW=$1
OLD=${2:-}
OUT=${3:-screens}
PKG=com.pulse.work.mobile
# The sign-in form itself (its Username field), not merely a page that mentions signing in.
SIGNIN=${PULSE_SIGNIN_TEXT:-Username}
ORIGIN=${PULSE_ORIGIN:-https://pulse.estateautopilots.com}
ACT=$PKG/.MainActivity
# A lost emulator must fail with diagnostics instead of hanging an entire hosted job in adb.
ADB_BIN=$(command -v adb)
adb() { local limit=45; [ "${1:-}" != install ] || limit=180; timeout --foreground "$limit" "$ADB_BIN" "$@"; }
mkdir -p "$OUT"
: > "$OUT/acceptance.txt"
diagnostics() {
  local result=${1:-$?}
  if [ "$result" != 0 ]; then
    adb logcat -d -b crash > "$OUT/crash.txt" 2>/dev/null || true
    adb logcat -d -s Capacitor AndroidRuntime chromium > "$OUT/webview.txt" 2>/dev/null || true
    adb logcat -d -s libc DEBUG ActivityManager OpenGLRenderer > "$OUT/native-runtime.txt" 2>/dev/null || true
    adb shell dumpsys activity exit-info "$PKG" > "$OUT/exit-info.txt" 2>/dev/null || true
    adb shell dumpsys activity activities > "$OUT/activities.txt" 2>/dev/null || true
    shot failure || true
  fi
}
# Retain native failures before a lost emulator makes every later ADB request unavailable. This logger belongs
# only to this acceptance process and stops with it; it records runtime/process diagnostics, never bridge payloads.
timeout --foreground 1800 "$ADB_BIN" logcat -v threadtime -s AndroidRuntime libc DEBUG ActivityManager OpenGLRenderer > "$OUT/native-live.txt" 2>&1 &
LOGCAT_PID=$!
cleanup() {
  local result=$?
  if [ "$result" != 0 ]; then diagnostics "$result"; fi
  kill "$LOGCAT_PID" 2>/dev/null || true
  wait "$LOGCAT_PID" 2>/dev/null || true
  return "$result"
}
trap cleanup EXIT

# The emulator can drop off adb for a moment under load: every phase starts by waiting for it to be fully booted.
ready() { adb wait-for-device; local end=$((SECONDS + 180)); until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ]; do (( SECONDS < end )) || { echo "Emulator did not recover" >&2; return 1; }; sleep 2; done; }
shot() { adb exec-out screencap -p > "$OUT/$1.png"; }
dump() { if adb shell uiautomator dump /sdcard/pulse-ui.xml >/dev/null 2>&1; then adb shell cat /sdcard/pulse-ui.xml 2>/dev/null || true; fi; }
# Wait until the screen (including the page inside the WebView) shows text matching a pattern.
wait_text() {
  local end=$((SECONDS + $2))
  while (( SECONDS < end )); do
    if dump | grep -qiE "$1"; then return 0; fi
    sleep 2
  done
  dump > "$OUT/missing-$(echo "$1" | tr -c 'A-Za-z0-9' '_' | cut -c1-40).xml"
  echo "Timed out waiting for: $1" >&2
  return 1
}
tap_text() {
  dump > "$OUT/tap.xml"
  local xy
  xy=$(python3 - "$1" "$OUT/tap.xml" <<'PY'
import re, sys, xml.etree.ElementTree as ET
pattern = re.compile(sys.argv[1], re.I)
for node in ET.parse(sys.argv[2]).getroot().iter('node'):
    label = ((node.get('text') or '') + ' ' + (node.get('content-desc') or '')).strip()
    if label and pattern.search(label) and node.get('bounds'):
        a = list(map(int, re.findall(r'\d+', node.get('bounds'))))
        print((a[0] + a[2]) // 2, (a[1] + a[3]) // 2)
        break
PY
)
  [ -n "$xy" ] || { echo "Nothing to tap for: $1" >&2; return 1; }
  adb shell input tap $xy
}
focused() { adb shell dumpsys window > "$OUT/window.txt"; grep -E 'mCurrentFocus' "$OUT/window.txt" | grep -q "$PKG"; }
alive() { [ -n "$(adb shell pidof $PKG | tr -d '\r')" ]; }
pass() { echo "$1=pass${2:+ ($2)}" | tee -a "$OUT/acceptance.txt"; }
code() { adb shell dumpsys package $PKG > "$OUT/package.txt"; grep -m1 -o 'versionCode=[0-9]*' "$OUT/package.txt" | cut -d= -f2; }
network() {
  if [ "$1" = off ]; then
    adb shell cmd connectivity airplane-mode enable || true; adb shell svc wifi disable || true; adb shell svc data disable || true
  else
    adb shell cmd connectivity airplane-mode disable || true; adb shell svc wifi enable || true; adb shell svc data enable || true
  fi
}
adb shell settings put global window_animation_scale 0 || true
adb shell settings put global transition_animation_scale 0 || true
# Match the owner's phone proportions, instead of the runner's tiny default AVD.
adb shell wm size 1080x2340
adb shell wm density 480

# 1. Upgrade in place over the published Expo app.
if [ -n "$OLD" ]; then
  adb install "$OLD"
  adb shell am start -W -n "$ACT" >/dev/null
  sleep 12
  shot 1-expo-1.0.0-before-upgrade
  before=$(code)
  adb install -r "$NEW"
  after=$(code)
  echo "versionCode $before -> $after"
  [ "$before" = 1000000 ] && [ "$after" -gt "$before" ]
  adb shell am start -W -n "$ACT" >/dev/null
  wait_text "$SIGNIN" 120
  shot 1-upgraded-launch
  pass upgrade_in_place "$before -> $after, same signing key"
else
  adb install "$NEW"
  echo "upgrade_in_place=skipped (validation build is not signed with the Pulse key)" | tee -a "$OUT/acceptance.txt"
fi

ready
# 2. Cold launch: the sign-in page, light and dark.
adb shell pm clear $PKG >/dev/null
adb shell cmd uimode night no || true
sleep 3
adb shell am start -W -n "$ACT" >/dev/null
wait_text "$SIGNIN" 120
shot 2-cold-launch-sign-in-light
adb shell am force-stop $PKG
adb shell cmd uimode night yes || true
sleep 3
adb shell am start -W -n "$ACT" >/dev/null
wait_text "$SIGNIN" 120
shot 2-cold-launch-sign-in-dark
# Also capture 390×844 at the same 3× density: the real WebView, not a browser bridge stand-in.
adb shell wm size 1170x2532
adb shell am force-stop $PKG
adb shell cmd uimode night no || true
sleep 3
adb shell am start -W -n "$ACT" >/dev/null
wait_text "$SIGNIN" 120
shot 2-cold-launch-sign-in-390-light
adb shell am force-stop $PKG
adb shell cmd uimode night yes || true
sleep 3
adb shell am start -W -n "$ACT" >/dev/null
wait_text "$SIGNIN" 120
shot 2-cold-launch-sign-in-390-dark
adb shell wm size 1080x2340
adb shell cmd uimode night no || true
pass cold_launch_sign_in "360x780 and 390x844, light and dark"

ready
# 2b. POLISH-1 edges: Pulse draws edge to edge on every Android version (the page's header colours the status bar and
# pads by env(safe-area-inset-top) once). Gesture and 3-button navigation, 360 and 390 px, light and dark: the screen,
# the bars' frames and the WebView's bounds are recorded for each (edges.txt). The WebView must reach the top of the
# screen (under the status bar) unless Capacitor pads the window itself for an old WebView; then the page gets no inset.
: > "$OUT/edges.txt"
# The emulator's own navigation mode, put back afterwards (changing it restarts the app's activity).
nav_before=$(adb shell cmd overlay list 2>/dev/null | grep -oE '\[x\] com\.android\.internal\.systemui\.navbar\.[a-z]+' | head -1 | awk '{print $2}' | tr -d '\r' || true)
for nav in gestural threebutton; do
  adb shell cmd overlay enable-exclusive --category "com.android.internal.systemui.navbar.$nav" >/dev/null 2>&1 || true
  sleep 3
  for size in 1080x2340:360 1170x2532:390; do
    adb shell wm size "${size%%:*}"
    for theme in no yes; do
      adb shell am force-stop $PKG; adb shell cmd uimode night "$theme" || true; sleep 2
      adb shell am start -W -n "$ACT" >/dev/null
      wait_text "$SIGNIN" 120
      name="2b-edges-$nav-${size##*:}-$([ "$theme" = yes ] && echo dark || echo light)"
      shot "$name"
      # The insets' wording differs between Android versions ("type=statusBars frame=" / "mType=statusBars, mFrame=").
      bars=$(adb shell dumpsys window | python3 -c "import re,sys; t=sys.stdin.read(); f=lambda k: (re.search(k+r'[^\[\n]{0,40}\[(\d+),(\d+)\]\[(\d+),(\d+)\]', t) or [None]*5); s=f('statusBars'); n=f('navigationBars'); print('status=%s nav=%s' % (s[4] if s[0] else 'none', '%s-%s' % (n[2], n[4]) if n[0] else 'none'))")
      web=$(dump | python3 -c "import re,sys; m=re.search(r'class=\"android.webkit.WebView\"[^>]*bounds=\"(\[[0-9,]+\]\[[0-9,]+\])\"', sys.stdin.read()); print(m.group(1) if m else 'none')")
      engine=$(adb shell dumpsys webviewupdate 2>/dev/null | grep -m1 -oE 'Current WebView package \(name, version\): \([^,]+, [0-9]+' | grep -oE '[0-9]+$' || echo 0)
      echo "$name webview=$web engine=$engine $bars" | tee -a "$OUT/edges.txt"
    done
  done
done
[ -n "$nav_before" ] && adb shell cmd overlay enable-exclusive --category "$nav_before" >/dev/null 2>&1 || true
adb shell wm size 1080x2340
adb shell cmd uimode night no || true
# A fresh start on the sign-in page, as after phase 2 (the overlay change above recreated the activity).
sleep 3; adb shell am force-stop $PKG; sleep 2
adb shell am start -W -n "$ACT" >/dev/null
wait_text "$SIGNIN" 120
python3 - "$OUT/edges.txt" <<'PY'
import re, sys
for line in open(sys.argv[1]):
    web = re.search(r'webview=\[(\d+),(\d+)\]', line); bar = re.search(r'status=(\d+)', line)
    engine = int(re.search(r'engine=(\d+)', line).group(1))
    assert web and bar, f"no WebView or status bar in: {line}"
    top, status = int(web.group(2)), int(bar.group(1))
    # WebView 140+ (the owner's phone): the page reaches under the status bar and pads itself once. Older WebViews are
    # padded by Capacitor and get no inset; either way nothing starts lower than the status bar's bottom.
    assert top <= status, f"page starts below the status bar: {line}"
    if engine >= 140: assert top == 0, f"not edge to edge with WebView {engine}: {line}"
print("edges ok")
PY
pass edge_to_edge "gesture and 3-button navigation, 360 and 390, light and dark (edges.txt)"

ready
# 3. Back: through Pulse's history, then minimise at the start (never a blank page, never an exit).
adb shell am start -W -n "$ACT" -a android.intent.action.VIEW -d "$ORIGIN/apps/android" >/dev/null
wait_text 'Pulse for Android' 60
shot 3-back-1-second-page
adb shell input keyevent KEYCODE_BACK
wait_text "$SIGNIN" 30
focused
shot 3-back-2-previous-page
adb shell input keyevent KEYCODE_BACK
sleep 4
if focused; then echo "Back at the first page did not minimise" >&2; exit 1; fi
alive || { echo "Back at the first page closed the app" >&2; exit 1; }
shot 3-back-3-minimised
adb shell am start -W -n "$ACT" >/dev/null
wait_text "$SIGNIN" 30
shot 3-back-4-reopened
pass back_button "history, then minimise; process kept"

ready
# 4. Offline: the shell's own screen with Retry; Pulse comes back when the network does.
network off
sleep 4
adb shell am force-stop $PKG
adb shell am start -W -n "$ACT" >/dev/null
wait_text "You.re offline|can.t be reached" 90
shot 4-offline
tap_text '^Retry$'
sleep 3
shot 4-offline-retry
if dump | grep -qiE 'net::ERR|Webpage not available|ERR_INTERNET'; then echo "A browser error page was shown" >&2; exit 1; fi
network on
wait_text "$SIGNIN" 120
shot 4-offline-recovered
pass offline_screen "own screen, Retry, automatic recovery"

ready
# 5. Notifications: Android's permission prompt, Allow, then Pulse confirms with a notification.
adb shell pm revoke $PKG android.permission.POST_NOTIFICATIONS 2>/dev/null || true
adb shell pm clear-permission-flags $PKG android.permission.POST_NOTIFICATIONS user-set user-fixed 2>/dev/null || true
adb shell am start -W -n "$ACT" --es pulse.ask notifications >/dev/null
wait_text 'send you notifications' 30
shot 5-notification-permission-prompt
tap_text '^Allow$'
sleep 4
adb shell dumpsys package $PKG > "$OUT/package.txt"
grep -q 'android.permission.POST_NOTIFICATIONS: granted=true' "$OUT/package.txt"
adb shell dumpsys notification > "$OUT/notifications.txt"
grep -q "pkg=$PKG" "$OUT/notifications.txt"
adb shell cmd statusbar expand-notifications || true
sleep 2
shot 5-notification-shown
adb shell cmd statusbar collapse || true
pass notification_permission "prompt, Allow, confirmation notification"

# R21 native fixtures run against this identical signed release APK, first granted then denied.
TEST_APK="$(dirname "$NEW")/$(basename "$NEW" .apk | sed 's/-android$/-android-tests/').apk"
[ -f "$TEST_APK" ] || { echo "Missing matching-source Android surface test APK" >&2; exit 1; }
adb install -r "$TEST_APK"
# A disposable instrumented host exercises the actual AppWidgetManager/RemoteViews; no manifest permission is added.
R21_WIDGET_USER=$(adb shell am get-current-user | tr -d '\r')
[[ "$R21_WIDGET_USER" =~ ^[0-9]+$ ]]
adb shell appwidget grantbind --package "$PKG" --user "$R21_WIDGET_USER"
native_failed=0
for permission in granted denied; do
  if [ "$permission" = granted ]; then adb shell pm grant $PKG android.permission.POST_NOTIFICATIONS; else adb shell pm revoke $PKG android.permission.POST_NOTIFICATIONS; fi
  if ! adb shell am instrument -w -e class com.pulse.work.mobile.AttendanceSurfacesTest "$PKG.test/androidx.test.runner.AndroidJUnitRunner" > "$OUT/r21-native-$permission.txt"; then native_failed=1; fi
  cat "$OUT/r21-native-$permission.txt"
  adb shell dumpsys notification > "$OUT/r21-notifications-$permission.txt"
  adb shell dumpsys package "$PKG" > "$OUT/r21-package-$permission.txt"
  adb pull "/sdcard/Android/data/$PKG/files/r21-notification-state.json" "$OUT/r21-notification-state-$permission.json" || native_failed=1
  if ! grep -q 'OK (7 tests)' "$OUT/r21-native-$permission.txt" || grep -qE 'FAILURES|INSTRUMENTATION_FAILED|Process crashed' "$OUT/r21-native-$permission.txt"; then
    native_failed=1
    echo "r21_native_surfaces_$permission=fail" | tee -a "$OUT/acceptance.txt"
  else pass "r21_native_surfaces_$permission" "7 synthetic native tests; no staff sign-in or attendance transport"; fi
  adb pull "/sdcard/Android/data/$PKG/files/r21-widget.png" "$OUT/r21-widget-$permission.png" || native_failed=1
  for state in in forgotten; do adb pull "/sdcard/Android/data/$PKG/files/polish1-widget-small-$state.png" "$OUT/polish1-widget-small-$state-$permission.png" || true; done
done
adb shell appwidget revokebind --package "$PKG" --user "$R21_WIDGET_USER"
adb shell am force-stop $PKG
adb shell am start -W -n "$ACT" --es pulse.href /me >/dev/null
wait_text "$SIGNIN" 120
shot 6-r21-cold-workspace-denied
pass r21_cold_workspace_denied "cold My desk shortcut retains normal sign-in with notifications denied"

[ "$native_failed" = 0 ] || { echo "Native acceptance failed; both permission states and diagnostics retained" >&2; exit 1; }
echo "All Android acceptance checks passed" | tee -a "$OUT/acceptance.txt"
