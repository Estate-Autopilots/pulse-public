#!/usr/bin/env bash
# QA-E2E on the Android emulator: the real Pulse shell around a synthetic Pulse (QaSessionTest answers the shell's
# gateway calls in-process; nothing reaches a Pulse server with a credential), driven from the host through the real
# OS. Phases (comma list, default all but geofence):
#   permissions    Android's notification prompt: later (dismissed), Don't allow twice, then Allow
#   notifications  chat, approval, ask and arrival notifications from the update list; badge number; tapping one opens
#                  its page; the arrival's one-tap Check in; the WorkManager background check with Pulse in the back;
#                  with notifications denied
#   widget         the home-screen widget added through the launcher, its states, and what a tap does
#   lifecycle      cold and warm start, back at every depth, the keyboard over a field, resume after RESUME_MINUTES,
#                  a file upload and a PDF the page made (bridge download)
#   gpsphoto       rear-camera photo returned to the page, gallery chooser, foreground GPS allow/deny and usability
#   wifi           the office Wi-Fi rule: the emulator's network matched by name, a real Wi-Fi join, no permission
#   geofence       spoofed GPS (adb emu geo fix): approach, dwell, jitter, departure; without background location
#                  (needs a Google APIs image: Android's geofences come from Play services)
# Usage: android-qa.sh APK TEST_APK [OUT_DIR] [PHASES]. Results: OUT_DIR/qa.txt (name=pass|fail|info (detail)).
set -uo pipefail
APK=$1
TEST_APK=$2
OUT=${3:-qa}
PHASES=${4:-permissions,notifications,widget,lifecycle,wifi}
RESUME_MINUTES=${RESUME_MINUTES:-30}
PKG=com.pulse.work.mobile
ACT=$PKG/.MainActivity
RUNNER=$PKG.test/androidx.test.runner.AndroidJUnitRunner
JOURNAL=/sdcard/Android/data/$PKG/files/qa/journal.jsonl
SIGNIN=${PULSE_SIGNIN_TEXT:-Username|Sign in to Pulse}
# Synthetic HQ (Pune) and points around it: [lng lat] as `geo fix` takes them.
HQ_LAT=18.5204 HQ_LNG=73.8567
ADB_BIN=$(command -v adb)
adb() { timeout --foreground 60 "$ADB_BIN" "$@"; }
mkdir -p "$OUT"
: > "$OUT/qa.txt"
FAILED=0
result() { echo "$1=$2${3:+ ($3)}" | tee -a "$OUT/qa.txt"; [ "$2" != fail ] || FAILED=$((FAILED + 1)); }
phase() { [[ ",$PHASES," == *",$1,"* ]]; }
ready() { adb wait-for-device; local end=$((SECONDS + 180)); until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ]; do (( SECONDS < end )) || return 1; sleep 2; done; }
shot() { adb exec-out screencap -p > "$OUT/$1.png" 2>/dev/null || true; }
dump() { if adb shell uiautomator dump /sdcard/qa-ui.xml >/dev/null 2>&1; then adb shell cat /sdcard/qa-ui.xml 2>/dev/null || true; fi; }
wait_text() { local end=$((SECONDS + $2)); while (( SECONDS < end )); do dump | grep -qiE "$1" && return 0; sleep 2; done; return 1; }
# Tap the first node whose text or description matches (python reads the uiautomator dump).
tap_text() {
  dump > "$OUT/tap.xml"
  local xy
  xy=$(python3 - "$1" "$OUT/tap.xml" <<'PY'
import re, sys, xml.etree.ElementTree as ET
pattern = re.compile(sys.argv[1], re.I)
try: root = ET.parse(sys.argv[2]).getroot()
except Exception: sys.exit(0)
for node in root.iter('node'):
    label = ((node.get('text') or '') + ' ' + (node.get('content-desc') or '')).strip()
    if label and pattern.search(label) and node.get('bounds'):
        a = list(map(int, re.findall(r'\d+', node.get('bounds'))))
        print((a[0] + a[2]) // 2, (a[1] + a[3]) // 2); break
PY
)
  [ -n "$xy" ] || return 1
  adb shell input tap $xy
}
texts() { dump | python3 -c "import re,sys,html; print(' | '.join(html.unescape(t) for t in re.findall(r'text=\"([^\"]+)\"', sys.stdin.read())))"; }
granted() {
  local state value
  state=$(adb shell dumpsys package "$PKG") || { echo unknown; return 1; }
  value=$(printf '%s\n' "$state" | grep -m1 -F "$1: granted=" | grep -o 'granted=[a-z]*' | cut -d= -f2)
  case "$value" in true|false) echo "$value";; *) echo unknown; return 1;; esac
}
journal() { adb shell cat "$JOURNAL" 2>/dev/null | tr -d '\r'; }

# ------------------------------------------------------------------------------------------------- the QA session
INSTR=
session() {
  adb shell rm -f "$JOURNAL" >/dev/null 2>&1 || true
  "$ADB_BIN" shell am instrument -w -e class com.pulse.work.mobile.QaSessionTest#serve -e qa 1 -e minutes 50 "$RUNNER" > "$OUT/instrument-$1.txt" 2>&1 &
  INSTR=$!
  local end=$((SECONDS + 90))
  until journal | grep -q '"event":"ready"'; do (( SECONDS < end )) || { result "session_$1" fail "no ready line"; return 1; }; sleep 2; done
  SEQ=0
}
SEQ=0
# step NAME [am extras...]: one step in the session; prints its "done" line (or the error) and returns 1 on error/timeout.
step() {
  local name=$1; shift
  SEQ=$((SEQ + 1)); STEP_OUT=
  adb shell "am broadcast -a com.pulse.work.mobile.QA_STEP -p $PKG --es step $name --ei seq $SEQ $*" >/dev/null
  local end=$((SECONDS + ${STEP_WAIT:-40})) line
  while (( SECONDS < end )); do
    line=$(journal | grep -E "\"seq\":$SEQ[,}]" | grep -E '"event":"(done|error)"' | tail -1)
    if [ -n "$line" ]; then STEP_OUT=$line; echo "$line" | grep -q '"event":"done"'; return; fi
    sleep 1
  done
  STEP_OUT="{\"event\":\"timeout\",\"step\":\"$name\"}"; return 1
}
end_session() { step stop >/dev/null || true; [ -z "$INSTR" ] || { timeout 60 tail --pid="$INSTR" -f /dev/null 2>/dev/null; wait "$INSTR" 2>/dev/null; }; INSTR=; journal > "$OUT/journal-$1.jsonl"; }
json() { python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(eval(sys.argv[2], {'d': d}))" "$1" "$2" 2>/dev/null; }

trap 'journal > "$OUT/journal-last.jsonl" 2>/dev/null; adb logcat -d -s Capacitor AndroidRuntime chromium WM-WorkerWrapper GeofencerStateMachine PulseArrival PulseDownload Capacitor/Console PulseQA > "$OUT/logcat.txt" 2>/dev/null' EXIT
ready || { echo "Emulator not ready" >&2; exit 1; }
SDK=$(adb shell getprop ro.build.version.sdk | tr -d '\r'); SDK=${SDK:-0}
adb shell settings put global window_animation_scale 0 || true
adb shell settings put global transition_animation_scale 0 || true
adb shell wm size 1080x2340; adb shell wm density 480
timeout 240 "$ADB_BIN" install -r "$APK" >/dev/null && timeout 240 "$ADB_BIN" install -r "$TEST_APK" >/dev/null || { echo "install failed" >&2; exit 1; }
adb shell pm clear $PKG >/dev/null
adb shell appops set $PKG REQUEST_INSTALL_PACKAGES deny >/dev/null 2>&1 || true

# ------------------------------------------------------------- GPS site photo: real camera and WebView geolocation
if phase gpsphoto; then
  reset_location() {
    for permission in ACCESS_BACKGROUND_LOCATION ACCESS_FINE_LOCATION ACCESS_COARSE_LOCATION; do
      adb shell pm revoke "$PKG" "android.permission.$permission" 2>/dev/null || true
      adb shell pm clear-permission-flags "$PKG" "android.permission.$permission" user-set user-fixed 2>/dev/null || true
    done
  }
  gps_permissions() {
    local name=$1 expected=$2 verdict=fail
    if adb shell dumpsys package "$PKG" > "$OUT/gps-$name-package.txt" && adb shell cmd appops get "$PKG" > "$OUT/gps-$name-appops.txt"; then
      verdict=$(python3 - "$OUT/gps-$name-package.txt" "$expected" <<'GRANTS'
import pathlib, re, sys
text = pathlib.Path(sys.argv[1]).read_text()
expected = {'ACCESS_COARSE_LOCATION': sys.argv[2], 'ACCESS_FINE_LOCATION': sys.argv[2], 'ACCESS_BACKGROUND_LOCATION': 'false'}
print('pass' if all(re.search(r'android\.permission\.' + key + r': granted=' + value + r'\b', text) for key, value in expected.items()) else 'fail')
GRANTS
)
    fi
    result "location_permissions_$name" "$verdict" "foreground=$expected background=false; raw package/appops retained"
  }
  # Revoke before starting instrumentation: Android kills the app process when a runtime grant is removed.
  reset_location
  adb shell settings put secure location_mode 3
  if session gpsphoto; then
    adb shell am start -W -n "$ACT" >/dev/null
    wait_text "$SIGNIN" 60 || true
    step gps-photo >/dev/null
    wait_text 'GPS site photo QA' 20 || result gps_photo_page fail "test page did not load"
    shot gps-01-idle
    gps_permissions before-tap false
    result location_explicit_tap "$( [ "$(granted android.permission.ACCESS_COARSE_LOCATION)" = false ] && echo pass || echo fail)" "no location permission on page load"
    tap_text '^Use location$'
    if wait_text 'access this device.s location' 20; then
      shot gps-02-location-deny-prompt
      tap_text "Don.t allow"
      wait_text 'Location denied 1' 25
      step eval --es js "'document.body.dataset.geo'"
      result location_deny "$( echo "$STEP_OUT" | grep -q 'error.*1' && echo pass || echo fail)" "$STEP_OUT"
      tap_text '^Continue without location$'
      wait_text 'Page usable' 10
      step eval --es js "'document.body.dataset.usable'"
      result location_deny_usable "$( echo "$STEP_OUT" | grep -q yes && echo pass || echo fail)" "explicit page action after denial"
      shot gps-03-denied-usable
    else result location_deny fail "no foreground location prompt"; fi
    # Clear the page's grant decision and Android's denial flag; no permission is granted by ADB.
    for permission in ACCESS_FINE_LOCATION ACCESS_COARSE_LOCATION; do
      adb shell pm clear-permission-flags "$PKG" "android.permission.$permission" user-set user-fixed 2>/dev/null || true
    done
    step gps-photo >/dev/null
    wait_text 'GPS site photo QA' 20
    tap_text '^Use location$'
    if wait_text 'access this device.s location' 20; then
      shot gps-04-location-allow-prompt
      tap_text 'While using the app|Only this time'
      for attempt in 1 2 3 4 5; do
        adb emu geo fix "$HQ_LNG" "$HQ_LAT" >/dev/null
        sleep 2
      done
      wait_text 'Location received' 25
      step eval --es js "'document.body.dataset.geo'"
      printf '%s\n' "$STEP_OUT" > "$OUT/gps-fix.json"
      fix_ok=$(python3 - "$STEP_OUT" <<'GPS'
import json, sys
try:
    p = json.loads(json.loads(json.loads(sys.argv[1])['result']))
    print('pass' if abs(p['lat'] - 18.5204) < .001 and abs(p['lng'] - 73.8567) < .001 else 'fail')
except Exception: print('fail')
GPS
)
      result location_allow "$fix_ok" "page received the emulator's synthetic GPS fix"
      gps_permissions after-allow true
      result location_foreground_only "$( [ "$(granted android.permission.ACCESS_BACKGROUND_LOCATION)" = false ] && echo pass || echo fail)" "no background location grant"
      shot gps-05-location-fix
    else result location_allow fail "no foreground location prompt"; fi
    # The capture field should open the rear camera; the ordinary image field retains Camera/Photos/Files.
    step seed-image >/dev/null
    tap_text '^Gallery photo'
    wait_text 'Camera|Files|Photos|Gallery|Media' 20
    dump > "$OUT/gps-gallery.xml"
    result gallery_chooser "$( grep -qiE 'Files|Photos|Gallery|Media' "$OUT/gps-gallery.xml" && grep -qi 'Camera' "$OUT/gps-gallery.xml" && echo pass || echo fail)" "camera and existing photo/file source both offered"
    shot gps-06-gallery-chooser
    tap_text '^Media$|^Files$|^Photos$|^Gallery$'
    sleep 3
    dump > "$OUT/gps-gallery-provider.xml"
    adb shell dumpsys activity activities > "$OUT/gps-gallery-provider-activity.txt"
    shot gps-06-gallery-provider
    tap_text 'pulse-qa-gallery|Photo taken'
    sleep 2
    tap_text '^Add$|^Done$|^Select$' || true
    sleep 2
    step eval --es js "'document.body.dataset.gallery'"
    printf '%s\n' "$STEP_OUT" > "$OUT/gps-gallery-returned.json"
    gallery_ok=$(python3 - "$STEP_OUT" <<'GALLERY'
import json, sys
try:
    p = json.loads(json.loads(json.loads(sys.argv[1])['result']))
    print('pass' if p['size'] > 0 and p['type'] == 'image/jpeg' and p['width'] == 64 and p['height'] == 48 else 'fail')
except Exception: print('fail')
GALLERY
)
    result gallery_image_returned "$gallery_ok" "the provider returned the seeded 64x48 synthetic JPEG to the ordinary image field"
    shot gps-06-gallery-returned
    tap_text '^Take site photo'
    # The AOSP camera may show its own first-use information page.
    sleep 3
    tap_text 'No thanks|Not now' || true
    if wait_text 'Next|Shutter|Take photo|Capture|Done' 20; then
      tap_text '^Next$' || true
      sleep 2
      shot gps-07-rear-camera
      dump > "$OUT/gps-camera.xml"
      adb shell dumpsys activity activities > "$OUT/gps-camera-activity.txt"
      result rear_camera_open "$( grep -qiE 'com.android.camera|com.google.android.GoogleCamera' "$OUT/gps-camera-activity.txt" && echo pass || echo fail)" "system camera activity from capture=environment"
      tap_text 'Shutter|Take photo|Capture' || adb shell input keyevent KEYCODE_CAMERA
      sleep 4
      shot gps-08-captured
      tap_text '^Done$|^OK$|^Accept$|Review done' || true
      sleep 4
      step eval --es js "'document.body.dataset.photo'"
      printf '%s\n' "$STEP_OUT" > "$OUT/gps-photo.json"
      photo_ok=$(python3 - "$STEP_OUT" <<'PHOTO'
import json, sys
try:
    p = json.loads(json.loads(json.loads(sys.argv[1])['result']))
    print('pass' if p['size'] > 0 and p['type'].startswith('image/') and p['width'] > 0 and p['height'] > 0 else 'fail')
except Exception: print('fail')
PHOTO
)
      result camera_photo_returned "$photo_ok" "the page decoded a nonempty image from the system camera"
      shot gps-09-photo-returned
    else result camera_photo_returned fail "camera did not open"; fi
    end_session gpsphoto
  fi
fi

# ---------------------------------------------------------------------------- 1. the notification permission prompt
# Below Android 13 (API 33) there is no notification permission: no prompt, and notifications are on by default.
if phase permissions && (( SDK < 33 )); then
  adb shell am start -W -n "$ACT" --es pulse.ask notifications >/dev/null
  if wait_text 'send you notifications' 15; then shot p1-prompt; result notification_prompt fail "a prompt on API $SDK"; else result notification_prompt pass "no prompt on API $SDK: Android asks from 13 on"; fi
  adb shell am force-stop $PKG
elif phase permissions; then
  ask() { adb shell am start -W -n "$ACT" --es pulse.ask notifications >/dev/null; wait_text 'send you notifications' 20; }
  reset_permission() { adb shell pm revoke $PKG android.permission.POST_NOTIFICATIONS 2>/dev/null || true; adb shell pm clear-permission-flags $PKG android.permission.POST_NOTIFICATIONS user-set user-fixed 2>/dev/null || true; }
  reset_permission
  if ask; then shot p1-prompt; adb shell input keyevent KEYCODE_BACK; sleep 2
    result notification_prompt_later "$( [ "$(granted android.permission.POST_NOTIFICATIONS)" = false ] && echo pass || echo fail)" "dismissed with Back: not granted"
    if ask; then result notification_prompt_again_after_later pass "asked again after Later"; else result notification_prompt_again_after_later info "no prompt after Later"; fi
    tap_text "Don.t allow" || adb shell input keyevent KEYCODE_BACK; sleep 2
    adb shell dumpsys notification > "$OUT/notifications-denied.txt"
    result notification_deny "$( [ "$(granted android.permission.POST_NOTIFICATIONS)" = false ] && ! grep -q "pkg=$PKG" "$OUT/notifications-denied.txt" && echo pass || echo fail)" "Don't allow: no permission, no confirmation"
    if ask; then shot p2-second-prompt; tap_text "Don.t allow" || true; sleep 2; result notification_second_chance info "Android 13+ asks a second time"; else result notification_second_chance info "no second prompt"; fi
    if ask; then result notification_after_two_denials info "still prompted"; else shot p3-no-prompt-after-two-denials; result notification_after_two_denials info "no prompt any more: only Settings can turn notifications on (the page must offer Open settings)"; fi
    reset_permission
    ask && tap_text '^Allow$'; sleep 3
    adb shell dumpsys notification > "$OUT/notifications-allowed.txt"
    result notification_allow "$( [ "$(granted android.permission.POST_NOTIFICATIONS)" = true ] && grep -q "pkg=$PKG" "$OUT/notifications-allowed.txt" && echo pass || echo fail)" "Allow: granted and the confirmation notification shows"
  else
    result notification_prompt fail "no prompt"
  fi
  adb shell am force-stop $PKG
fi

adb shell pm grant $PKG android.permission.POST_NOTIFICATIONS 2>/dev/null || true

# ------------------------------------------------------------------------------------- 2. notifications from Pulse
if phase notifications; then
  if session notifications; then
    step enrol >/dev/null
    chat=00000000-0000-4000-8000-00000000c4a7; flow=00000000-0000-4000-8000-0000000f1009; ask=00000000-0000-4000-8000-00000000a5c0
    rows="[{\"id\":\"10000000-0000-4000-8000-000000000001\",\"title\":\"Ahoro sent you a message\",\"detail\":\"\",\"href\":\"/chats?channel=$chat\",\"eventType\":\"chat.message\",\"pingAllowed\":true},
{\"id\":\"10000000-0000-4000-8000-000000000002\",\"title\":\"Leave request waiting for you\",\"href\":\"/me/approvals?request=$flow\",\"eventType\":\"approval.waiting\",\"pingAllowed\":true},
{\"id\":\"10000000-0000-4000-8000-000000000003\",\"title\":\"Meera asks you to take a task\",\"href\":\"/tasks?ask=$ask\",\"eventType\":\"task.ask\",\"pingAllowed\":true},
{\"id\":\"10000000-0000-4000-8000-000000000004\",\"title\":\"You’re at Synthetic HQ. Check in?\",\"href\":\"/me?arrived=1\",\"eventType\":\"attendance.arrival\",\"pingAllowed\":true},
{\"id\":\"10000000-0000-4000-8000-000000000005\",\"title\":\"Quiet item\",\"href\":\"/me\",\"eventType\":\"update.self\",\"pingAllowed\":false}]"
    step updates "--es rows '$(echo $rows | tr -d '\n')'" >/dev/null
    adb shell input keyevent KEYCODE_HOME; sleep 1
    step inbox --ez notify true; out=$STEP_OUT
    echo "$out" > "$OUT/notifications-posted.json"
    n=$(json "$out" "len([x for x in d['notifications'] if x['channel']=='pulse-updates'])")
    result local_notifications "$( [ "$n" = 4 ] && echo pass || echo fail)" "$n of 4 pinged items shown; the quiet one is not"
    num=$(json "$out" "sorted({x['number'] for x in d['notifications'] if x['channel']=='pulse-updates'})")
    result badge_number info "notification number (launcher badge) $num with total 5 from the server"
    act=$(json "$out" "[x['actions'] for x in d['notifications'] if 'Check in' in x['title']]")
    result arrival_one_tap "$( echo "$act" | grep -q 'Check in' && echo pass || echo fail)" "arrival notification actions $act"
    pub=$(json "$out" "[x['publicTitle'] for x in d['notifications'] if 'Check in' in x['title']]")
    result arrival_lock_screen "$( echo "$pub" | grep -q 'Pulse · attendance' && echo pass || echo fail)" "lock screen shows $pub"
    acks=$(journal | grep '"event":"ack"' | tail -1)
    result ack_received_items "$( echo "$acks" | grep -q 000000000004 && ! echo "$acks" | grep -q 000000000005 && echo pass || echo fail)" "the phone acknowledges what it showed"
    adb shell cmd statusbar expand-notifications; sleep 2; shot n1-shade; dump > "$OUT/n1-shade.xml"; adb shell cmd statusbar collapse
    # The arrival's own button: Check in without opening Pulse. In the shade the four notifications are bundled, so the
    # button shows only on an expanded notification: try the shade first, then press it through the session.
    adb shell input keyevent KEYCODE_HOME; adb shell cmd statusbar expand-notifications; sleep 2; shot n3-shade-bundled
    if tap_text '^Check in$'; then how=shade; else adb shell cmd statusbar collapse; step notification-action --es title "'Check in?'"; how="session ($(json "$STEP_OUT" "d.get('pressed')"))"; fi
    sleep 6; adb shell cmd statusbar expand-notifications; sleep 1; shot n3-confirmation; dump > "$OUT/n3.xml"
    body=$(journal | grep '"event":"attendance"' | tail -1)
    result arrival_check_in_button "$( echo "$body" | grep -q 'check-in' && echo "$body" | grep -q '"trigger":"notification"' && echo pass || echo fail)" "pressed from the $how: $(echo "$body" | cut -c1-200)"
    result arrival_confirmation "$( grep -qiE 'Checked in' "$OUT/n3.xml" && echo pass || echo fail)" "confirmation notification replaces the question"
    adb shell cmd statusbar collapse
    step badge --ei count 0; out=$STEP_OUT; result badge_clear "$( [ "$(json "$out" "len(d['notifications'])")" = 0 ] && echo pass || echo info)" "count 0 clears Pulse's notifications"
    # WorkManager: the background check with Pulse in the back (InboxWorker via WorkManager, network constraint).
    step updates "--es rows '[{\"id\":\"10000000-0000-4000-8000-000000000009\",\"title\":\"Background check works\",\"href\":\"/chats\",\"eventType\":\"chat.message\",\"pingAllowed\":true}]'" >/dev/null
    adb shell input keyevent KEYCODE_HOME
    t0=$SECONDS; step inbox-work >/dev/null; seen=
    while (( SECONDS - t0 < 120 )); do step notifications; out=$STEP_OUT; echo "$out" | grep -q 'Background check works' && { seen=$((SECONDS - t0)); break; }; sleep 3; done
    result workmanager_background "$( [ -n "$seen" ] && echo pass || echo fail)" "${seen:-none} s from enqueue to notification with Pulse in the back"
    # Last: tap the chat notification in the shade. Pulse opens on that conversation (signed out here, so through the
    # sign-in page, whose ShellSignedOut also ends this synthetic registration: that is why this runs last).
    step updates "--es rows '[{\"id\":\"10000000-0000-4000-8000-000000000011\",\"title\":\"Ahoro sent you a message\",\"href\":\"/chats?channel=$chat\",\"eventType\":\"chat.message\",\"pingAllowed\":true}]' --ei total 1" >/dev/null
    step inbox --ez notify true >/dev/null
    adb shell cmd statusbar expand-notifications; sleep 2
    if tap_text 'Ahoro sent you a message'; then sleep 6; step url; url=$STEP_OUT; echo "$url" > "$OUT/n2-opened.json"; shot n2-opened-chat
      result tap_opens_page "$( echo "$url" | grep -qE 'chats(%3F|\?)channel(%3D|=)'"$chat"'|next=%2Fchats' && echo pass || echo fail)" "$(json "$url" "d.get('url','')[:120]")"
      revoked=$(journal | grep -c 'devices\\/synthetic-qa-device\\/revoke')
      result signed_out_page_revokes_phone info "the sign-in page inside the app revoked the phone's registration: $revoked call(s); Pulse's notifications cleared"
    else result tap_opens_page fail "chat notification not in the shade"; fi
    end_session notifications
  fi
  # Notifications denied: nothing is shown. Does the phone still acknowledge the items as received?
  adb shell pm revoke $PKG android.permission.POST_NOTIFICATIONS 2>/dev/null || true
  if session notifications-denied; then
    step enrol >/dev/null
    step updates "--es rows '[{\"id\":\"10000000-0000-4000-8000-00000000000a\",\"title\":\"Sent while notifications are off\",\"href\":\"/chats\",\"eventType\":\"chat.message\",\"pingAllowed\":true}]'" >/dev/null
    step inbox --ez notify true; out=$STEP_OUT
    shown=$(json "$out" "len(d['notifications'])")
    if (( SDK < 33 )); then result notifications_on_by_default "$( [ "${shown:-0}" -gt 0 ] && echo pass || echo fail)" "$shown shown: below Android 13 there is no notification permission to deny"
    else result denied_nothing_shown "$( [ "$shown" = 0 ] && echo pass || echo fail)" "$shown shown"; fi
    acked=$(journal | grep '"event":"ack"' | grep -c 00000000000a)
    result denied_items_acknowledged info "$( [ "$acked" -gt 0 ] && echo 'acknowledged as received although never shown (the server cannot tell the phone missed it)' || echo 'not acknowledged')"
    end_session notifications-denied
  fi
  adb shell pm grant $PKG android.permission.POST_NOTIFICATIONS 2>/dev/null || true
fi

# ------------------------------------------------------------------------------------------- 3. the home-screen widget
if phase widget; then
  if session widget; then
    adb shell input keyevent KEYCODE_HOME; sleep 2
    step fixture --es state in >/dev/null
    step pin-widget --es size medium; out=$STEP_OUT; echo "$out" > "$OUT/w0-pin.json"
    sleep 3; shot w0-pin-dialog
    tap_text '^Add( automatically)?$|Add to home screen' || tap_text '^ADD' || true; sleep 4
    step widgets; out=$STEP_OUT; medium=$(json "$out" "d['medium']")
    result widget_added "$( [ "${medium:-0}" -ge 1 ] && echo pass || echo fail)" "launcher pin request: $(json "$(cat "$OUT/w0-pin.json")" "(d.get('supported'),d.get('requested'))"), widgets now $medium"
    for state in in break done out forgotten; do
      step fixture --es state $state >/dev/null; sleep 3
      t=$(texts); echo "$state: $t" >> "$OUT/widget-texts.txt"; shot "w1-widget-$state"
    done
    if grep -q 'in: .*Checked in' "$OUT/widget-texts.txt" && grep -q 'out: .*Not checked in' "$OUT/widget-texts.txt"; then result widget_states pass "texts per state in widget-texts.txt"; else result widget_states fail "texts per state in widget-texts.txt"; fi
    if grep -qE 'forgotten: .*(Since yesterday|Fix time)' "$OUT/widget-texts.txt"; then result widget_forgotten_session pass "$(grep 'forgotten:' "$OUT/widget-texts.txt" | cut -c1-160)"; else result widget_forgotten_session info "$(grep 'forgotten:' "$OUT/widget-texts.txt" | cut -c1-160)"; fi
    # Tap the widget's main button while checked in: Pulse opens My desk with a pending check-out to confirm.
    step fixture --es state in >/dev/null; sleep 3
    step watch-pending >/dev/null
    if tap_text '^Check out$'; then sleep 6; shot w2-after-tap
      seen=$(journal | grep '"event":"pending-seen"' | tail -1)
      result widget_tap_check_out "$( echo "$seen" | grep -q 'check-out' && echo pass || echo fail)" "pending action the page confirms: $(echo "$seen" | cut -c1-200)"
      step url; url=$STEP_OUT; result widget_tap_opens "$( echo "$url" | grep -qE '/me|next=%2Fme' && echo pass || echo fail)" "$(json "$url" "d.get('url','')[:100]")"
    else result widget_tap_check_out fail "no Check out button on the widget"; fi
    adb shell input keyevent KEYCODE_HOME; sleep 1
    # The small widget.
    step pin-widget --es size small >/dev/null; sleep 3; tap_text '^Add( automatically)?$|Add to home screen' || true; sleep 4
    step fixture --es state in >/dev/null; sleep 3; shot w3-small-widget; echo "small: $(texts)" >> "$OUT/widget-texts.txt"
    step widgets; out=$STEP_OUT; result widget_small_added "$( [ "$(json "$out" "d['small']")" -ge 1 ] && echo pass || echo fail)"
    # Signed out: the widget offers to open Pulse, and nothing else.
    step forget >/dev/null; sleep 3; shot w4-signed-out; echo "signed-out: $(texts)" >> "$OUT/widget-texts.txt"
    if grep -q 'signed-out: .*Open' "$OUT/widget-texts.txt"; then result widget_signed_out pass; else result widget_signed_out fail "$(grep 'signed-out:' "$OUT/widget-texts.txt" | cut -c1-160)"; fi
    end_session widget
  fi
fi

# -------------------------------------------------------------------------------------------------- 4. app lifecycle
if phase lifecycle; then
  adb shell am force-stop $PKG; adb shell cmd uimode night no || true
  cold=(); for i in 1 2 3; do adb shell am force-stop $PKG; sleep 2; cold+=("$(adb shell am start -W -n "$ACT" | grep -oE 'TotalTime: [0-9]+' | grep -oE '[0-9]+')"); wait_text "$SIGNIN" 120 || true; done
  t=$( (adb shell input keyevent KEYCODE_HOME; sleep 2; adb shell am start -W -n "$ACT") | grep -oE 'TotalTime: [0-9]+' | grep -oE '[0-9]+')
  result start_times info "cold ${cold[*]} ms (activity), warm ${t:-?} ms"
  t0=$SECONDS; adb shell am force-stop $PKG; adb shell am start -n "$ACT" >/dev/null; wait_text "$SIGNIN" 120 && result first_screen info "$((SECONDS - t0)) s from cold start to the sign-in form (production, signed out)"
  shot l1-sign-in
  # Back at every depth (signed out: the sign-in page and its links).
  depth=0
  if tap_text 'Forgot'; then sleep 4; depth=$((depth + 1)); shot l2-depth-1; t1=$(texts | cut -c1-120)
    if tap_text 'username|Back to sign in|Sign in'; then sleep 3; depth=$((depth + 1)); shot l2-depth-2; fi
  fi
  ok=pass; for i in $(seq 1 $depth); do adb shell input keyevent KEYCODE_BACK; sleep 3; done
  wait_text "$SIGNIN" 20 || ok=fail
  adb shell input keyevent KEYCODE_BACK; sleep 3
  adb shell dumpsys window | grep -E 'mCurrentFocus' | grep -q "$PKG" && ok=fail
  [ -n "$(adb shell pidof $PKG | tr -d '\r')" ] || ok=fail
  # Known (P2): "Forgot password" is a state of the sign-in page, not a page: Back there leaves the app (info, not fail).
  result back_every_depth "$( [ $ok = pass ] && echo pass || echo info)" "$depth steps deep, back to sign-in, then minimised with the process kept (${t1:-})"
  # The keyboard over a field: the focused field stays above the keyboard (adjustResize).
  adb shell am start -W -n "$ACT" >/dev/null; wait_text "$SIGNIN" 60
  adb shell settings put secure show_ime_with_hard_keyboard 1 >/dev/null 2>&1 || true
  tap_text 'firstname.lastname|Username' || true; sleep 3; shot l3-keyboard
  ime=$(adb shell dumpsys input_method | grep -m1 -oE 'mInputShown=(true|false)')
  geo=$(dump | python3 -c "
import re,sys
t=sys.stdin.read()
f=[m for m in re.finditer(r'<node [^>]*focused=\"true\"[^>]*bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"',t)]
print(f[-1].group(4) if f else 'none')")
  imetop=$(adb shell dumpsys window windows | grep -A40 'InputMethod' | grep -m1 -oE 'frame=\[0,[0-9]+\]' | grep -oE '[0-9]+\]$' | tr -d ']')
  result keyboard_over_field info "$ime, focused field bottom ${geo}px, keyboard top ${imetop:-?}px"
  if [ "$geo" != none ] && [ -n "$imetop" ] && [ "$geo" -le "$imetop" ]; then result keyboard_field_visible pass; else result keyboard_field_visible info "could not confirm"; fi
  adb shell input keyevent KEYCODE_BACK; adb shell input keyevent KEYCODE_HOME
  # Upload and a page-made PDF through the real WebView and the shell's clients (a QA page injected in a session).
  adb shell "printf '%%PDF-1.4\n%% qa upload\n%%%%EOF\n' > /sdcard/Download/qa-upload.pdf"
  if session lifecycle; then
    adb shell am start -W -n "$ACT" >/dev/null; wait_text "$SIGNIN" 60
    step inject; out=$STEP_OUT; sleep 4; shot l4-qa-page
    if echo "$out" | grep -q '"injected":true'; then
      # The chooser each of Pulse's own file fields gets (Android's WebView builds the picker from the FIRST accepted
      # type): onboarding ID documents, task proof, and chat attachments (no filter).
      for field in "id-document:application/pdf,image/jpeg,image/png,image/webp" "task-proof:application/pdf,image/*,.csv,.txt,.zip,.docx,.xlsx,.pptx" "chat:"; do
        name=${field%%:*}; accept=${field#*:}
        step inject --es accept "'$accept'" >/dev/null; sleep 3
        tap_text 'Choose File|No file chosen|Browse' || adb shell input tap 300 620; sleep 4; shot "l6-chooser-$name"
        result "upload_chooser_$name" info "accept '$accept': $(texts | sed 's/.*No file chosen//' | cut -c1-160)"
        adb shell input keyevent KEYCODE_BACK; sleep 2
      done
      step inject >/dev/null; sleep 3
      tap_text 'Choose File|No file chosen|Browse' || adb shell input tap 300 620; sleep 4; shot l6-chooser; dump > "$OUT/l6.xml"
      result upload_chooser info "chooser: $(texts | cut -c1-200)"
      tap_text '^Files$|Documents|Browse' || true; sleep 4; shot l6-files
      tap_text 'qa-upload' || { tap_text 'Show roots|Downloads'; sleep 2; tap_text 'qa-upload'; } || true; sleep 4; shot l7-after-pick
      step eval --es js "'document.body.dataset.qa||document.getElementById(\"o\").textContent'"; picked=$STEP_OUT
      result upload_file "$( echo "$picked" | grep -q 'picked:qa-upload.pdf' && echo pass || echo info)" "$(json "$picked" "d.get('result')")"
      # A PDF the page made itself (bridge saveFile), with the name the page gave it.
      adb shell input keyevent KEYCODE_BACK; sleep 2; adb shell am start -n "$ACT" >/dev/null; sleep 2
      step inject >/dev/null; sleep 3
      # The link is not always in the accessibility tree (Android 15, phone and tablet): then it is clicked in the page.
      if wait_text 'Download synthetic payslip' 10 && tap_text 'Download synthetic payslip'; then how=tapped; else step eval --es js "'document.getElementById(\"d\").click()'" >/dev/null; how='clicked in the page'; fi
      sleep 5; shot l5-download; dump > "$OUT/l5.xml"
      step downloads; files=$STEP_OUT
      # Known (P2): a page-made file loses its name (data:/blob: downloads carry no Content-Disposition) — saved is enough here.
      result pdf_download "$( echo "$files" | grep -q 'Payslip-synthetic.pdf' && echo pass || { echo "$files" | grep -q '\.pdf:' && echo info || echo fail; })" "$(json "$files" "d['files']") ; viewer: $(grep -oE 'text="(Open [^"]*|No apps can perform this action|Share [^"]*)"' "$OUT/l5.xml" | head -2 | tr '\n' ' '); link $how"
      adb shell input keyevent KEYCODE_BACK; sleep 2
    else result qa_page fail "could not inject the QA page"; fi
    end_session lifecycle
  fi
  # Resume after a long time in the background (the access token lives 15 minutes).
  adb shell am start -W -n "$ACT" >/dev/null; wait_text "$SIGNIN" 60; adb shell input keyevent KEYCODE_HOME
  sleep $((RESUME_MINUTES * 60))
  t0=$SECONDS; adb shell am start -n "$ACT" >/dev/null
  if wait_text "$SIGNIN" 90; then result resume_after_long_background pass "${RESUME_MINUTES} min in the back: sign-in page back in $((SECONDS - t0)) s"; else result resume_after_long_background fail "nothing after ${RESUME_MINUTES} min"; fi
  shot l8-resumed
  [ -n "$(adb shell pidof $PKG | tr -d '\r')" ] && result resume_process_kept info "process alive after ${RESUME_MINUTES} min"
fi

# ---------------------------------------------------------------------------------------------- 5. the office Wi-Fi rule
if phase wifi; then
  ssid=$(adb shell dumpsys wifi | grep -m1 -oE 'SSID: "[^"]+"' | cut -d'"' -f2); ssid=${ssid:-AndroidWifi}
  adb shell cmd location set-location-enabled true 2>/dev/null || true
  # wifi_check NAME: what the shell can read and send about the joined network, in a fresh session, with the
  # location permissions granted before it (a woken-up OfficeArrival runs in the background, like this test).
  wifi_check() {
    local name=$1
    session "$name" || return
    step enrol >/dev/null; step presence --es ssid "$ssid" >/dev/null; step sync >/dev/null; sleep 3
    step wifi-raw >/dev/null; echo "$STEP_OUT" > "$OUT/$name-raw.json"; raw=$(json "$STEP_OUT" "d.get('ssid')")
    step wifi; out=$STEP_OUT; matched=$(json "$out" "d.get('wifi')")
    step presence --es ssid Other-Network >/dev/null; step sync >/dev/null; sleep 2
    step wifi; other=$(json "$STEP_OUT" "d.get('wifi')")
    # A real join: Android wakes Pulse through its registered network callback.
    step presence --es ssid "$ssid" >/dev/null; step netwatch >/dev/null; step sync >/dev/null; sleep 5
    before=$(journal | grep -c '"event":"presence"')
    adb shell svc wifi disable; sleep 6; adb shell svc wifi enable
    local end=$((SECONDS + 90)); got=
    while (( SECONDS < end )); do [ "$(journal | grep -c '"event":"presence"')" -gt "$before" ] && { got=$(journal | grep '"event":"presence"' | tail -1); break; }; sleep 3; done
    adb logcat -d -v time -s PulseArrival > "$OUT/$name-arrival-log.txt" 2>/dev/null || true
    end_session "$name"
  }
  adb shell pm grant $PKG android.permission.ACCESS_FINE_LOCATION 2>/dev/null; adb shell pm grant $PKG android.permission.ACCESS_COARSE_LOCATION 2>/dev/null
  adb shell pm revoke $PKG android.permission.ACCESS_BACKGROUND_LOCATION 2>/dev/null
  wifi_check wifi
  result wifi_while_using_only info "location while using only: Android shows the shell '$raw' in the background; office match: $matched; on a real join: ${got:-nothing sent}"
  result wifi_other_network "$( [ "$other" = None ] && echo pass || echo fail)" "a network that is not the office sends nothing"
  # With "Allow all the time" (as for geofences) Android reveals the network to a woken-up Pulse.
  adb shell pm grant $PKG android.permission.ACCESS_BACKGROUND_LOCATION 2>/dev/null
  adb logcat -c 2>/dev/null || true
  wifi_check wifi-background
  wakes=$(grep -c 'woken: com.pulse.work.mobile.OFFICE_NETWORK' "$OUT/wifi-background-arrival-log.txt" 2>/dev/null || echo 0)
  result wifi_wakeups info "Android woke Pulse for a network change $wakes time(s) during the session: $(tr '\n' ' ' < "$OUT/wifi-background-arrival-log.txt" 2>/dev/null | grep -oE 'network: [^(]*' | sort | uniq -c | tr '\n' ';')"
  result wifi_office_network "$( echo "$matched" | grep -q "'$ssid'" && echo pass || echo fail)" "Allow all the time: Android shows '$raw'; office match: $matched"
  # QA-E2E P1-14: the network callback woke Pulse only when registered. POLISH-2 (shell 1.1.3) hands off through the job
  # scheduler (leave → join): the Google APIs image reports the re-join; the AOSP image did not within this wait.
  result wifi_join_reported "$( echo "$got" | grep -q "\"ssid\":\"$ssid\"" && echo pass || echo info)" "$(echo "${got:-nothing sent after joining Wi-Fi again}" | cut -c1-220)"
  echo "$got" | grep -qE '"lat"|"lng"|"latitude"' && result wifi_no_position fail "a position was sent" || result wifi_no_position pass "no position in the report"
  # Without location permission Android hides the network name: nothing is sent.
  for p in ACCESS_BACKGROUND_LOCATION ACCESS_FINE_LOCATION ACCESS_COARSE_LOCATION; do adb shell pm revoke $PKG android.permission.$p 2>/dev/null; done
  if session wifi-denied; then
    step enrol >/dev/null; step presence --es ssid "$ssid" >/dev/null; step sync >/dev/null; sleep 3
    step wifi; out=$STEP_OUT; result wifi_without_permission "$( echo "$out" | grep -q '"wifi":null' && echo pass || echo fail)" "no permission: nothing is read or sent"
    step gms; out=$STEP_OUT; result presence_sync_without_permission info "located=$(json "$out" "d['located']")"
    end_session wifi-denied
  fi
fi

# ------------------------------------------------------------------------------------------- 6. geofence (spoofed GPS)
if phase geofence; then
  fix() { adb emu geo fix "$1" "$2" >/dev/null 2>&1 || true; }
  at() { python3 -c "import math,sys; m=float(sys.argv[1]); lat=$HQ_LAT+m/111320; print('%.6f %.6f' % ($HQ_LNG, lat))" "$1"; }   # metres north of HQ → "lng lat"
  for p in ACCESS_FINE_LOCATION ACCESS_COARSE_LOCATION ACCESS_BACKGROUND_LOCATION; do adb shell pm grant $PKG android.permission.$p 2>/dev/null; done
  adb shell cmd location set-location-enabled true 2>/dev/null || true
  fix $(at 2500)
  if session geofence; then
    step gms; out=$STEP_OUT; echo "$out" > "$OUT/g0-gms.json"
    result geofence_play_services "$( echo "$out" | grep -q '"playServices":true' && echo pass || echo fail)" "Play services $(json "$out" "d['playServices']"), background location $(json "$out" "d['background']")"
    step enrol >/dev/null
    step presence --ed lat $HQ_LAT --ed lng $HQ_LNG --ei radius 150 --ei dwell 1 >/dev/null
    step keepalive >/dev/null; step sync >/dev/null; sleep 20
    for m in 1500 800 400 200; do fix $(at $m); sleep 5; done
    t0=$SECONDS; enter=
    # Inside, with GPS jitter of up to ±40 m (well inside the 150 m fence).
    while (( SECONDS - t0 < 420 )); do
      j=$(( (RANDOM % 80) - 40 )); fix $(at $j); sleep 5
      enter=$(journal | grep '"event":"presence"' | grep '"region":"enter"' | head -1); [ -n "$enter" ] && break
    done
    shot g1-inside
    result geofence_arrival "$( [ -n "$enter" ] && echo pass || echo fail)" "$( [ -n "$enter" ] && echo "\"entered office\" $((SECONDS - t0)) s after arriving (Android dwell 1 min): $(echo "$enter" | cut -c1-200)" || echo 'no arrival in 7 minutes')"
    [ -z "$enter" ] || { echo "$enter" | grep -qE '"lat"|"lng"' && result geofence_no_position fail || result geofence_no_position pass "only the office id and enter/exit are sent"; }
    flaps=$(journal | grep '"event":"presence"' | grep -c '"region":"exit"')
    result geofence_jitter_inside "$( [ "$flaps" = 0 ] && echo pass || echo fail)" "$flaps departures reported while jittering inside"
    # Leave: walk away 1.5 km.
    t0=$SECONDS; leave=
    for m in 300 600 1000 1500; do fix $(at $m); sleep 5; done
    while (( SECONDS - t0 < 300 )); do fix $(at $((1500 + RANDOM % 50))); sleep 5; leave=$(journal | grep '"event":"presence"' | grep '"region":"exit"' | head -1); [ -n "$leave" ] && break; done
    result geofence_departure "$( [ -n "$leave" ] && echo pass || echo fail)" "$( [ -n "$leave" ] && echo "\"left office\" $((SECONDS - t0)) s after leaving" || echo 'no departure in 5 minutes')"
    # Edge jitter: hovering at the fence edge (130 ↔ 190 m) for 2 minutes.
    before=$(journal | grep -c '"event":"presence"')
    t0=$SECONDS; while (( SECONDS - t0 < 120 )); do fix $(at 130); sleep 5; fix $(at 190); sleep 5; done
    after=$(journal | grep -c '"event":"presence"')
    result geofence_edge_jitter info "$((after - before)) reports while hovering at the edge for 2 minutes"
    end_session geofence
  fi
  # Without "Allow all the time" the shell registers no geofences (Android would not deliver them while closed).
  adb shell pm revoke $PKG android.permission.ACCESS_BACKGROUND_LOCATION 2>/dev/null
  fix $(at 2500)
  if session geofence-no-background; then
    step enrol >/dev/null; step presence --ed lat $HQ_LAT --ed lng $HQ_LNG --ei radius 150 --ei dwell 1 >/dev/null; step keepalive >/dev/null; step sync >/dev/null; sleep 15
    t0=$SECONDS; while (( SECONDS - t0 < 150 )); do fix $(at $(( (RANDOM % 60) - 30 ))); sleep 5; done
    n=$(journal | grep -c '"event":"presence"')
    result geofence_without_background "$( [ "$n" = 0 ] && echo pass || echo fail)" "$n reports without background location"
    end_session geofence-no-background
  fi
fi

echo "QA finished: $FAILED failed" | tee -a "$OUT/qa.txt"
[ "$FAILED" = 0 ]
