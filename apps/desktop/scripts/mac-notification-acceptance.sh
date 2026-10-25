#!/usr/bin/env bash
# Real hosted macOS UI acceptance. Synthetic notification only, no staff credentials or attendance.
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true && $(uname -s) == Darwin ]]
[[ -x $PULSE_MAC_APP/Contents/MacOS/pulse-desktop ]]
mkdir -p screens
# usernoted can schedule the consent alert while a hosted VM has no Notification Center UI process.
# Start the normal OS UI component; authorization still requires the actual Allow control.
launchctl print "gui/$(id -u)/com.apple.notificationcenterui" > screens/macos-notification-ui-service.txt 2>&1 || true
if [[ -d /System/Library/CoreServices/NotificationCenter.app ]]; then
  open -g /System/Library/CoreServices/NotificationCenter.app > screens/macos-notification-ui-start.txt 2>&1 || true
fi
app_bin="$PULSE_MAC_APP/Contents/MacOS/pulse-desktop"
# Match a person's Finder launch: register the installed bundle and use LaunchServices.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$PULSE_MAC_APP"
open -n "$PULSE_MAC_APP" --args --settings=notifications
pulse_pid=""
finish() {
  result=$?
  if [[ $result != 0 ]]; then
    screencapture -x screens/macos-notification-failure.png || true
    cat screens/macos-notification-authorization.txt 2>/dev/null || true
    osascript -e 'tell application "System Events" to get name of every application process' > screens/macos-processes.txt 2>&1 || true
    osascript -e 'tell application "System Events" to tell process "ControlCenter" to get entire contents of every window' > screens/macos-controlcenter-ui.txt 2>&1 || true
    osascript -e 'tell application "System Events" to tell process "ControlCenter" to get entire contents of every menu bar' > screens/macos-controlcenter-menu.txt 2>&1 || true
    log show --last 10m --style compact --predicate 'process == "pulse-desktop" OR subsystem == "com.apple.UserNotifications" OR process == "usernoted" OR process == "ControlCenter"' > screens/macos-notification-system.log 2>&1 || true
    osascript -e 'tell application "System Events" to tell (first process whose bundle identifier is "com.pulse.work") to get entire contents of every window' > screens/macos-notification-ui.txt 2>&1 || true
  fi
  [[ -z "$pulse_pid" ]] || kill "$pulse_pid" 2>/dev/null || true
}
trap finish EXIT
sleep 12
pulse_pid=$(osascript -e 'tell application "System Events" to get unix id of (first process whose bundle identifier is "com.pulse.work")')
kill -0 "$pulse_pid"
screencapture -x screens/macos-notification-before.png
# Exercise the same Turn on control that the person uses. No permission database edits.
cat > "$RUNNER_TEMP/allow-pulse.applescript" <<'SCRIPT'
using terms from application "System Events"
on pressNamed(elements, wanted)
  repeat with elem in elements
    try
      if role of elem is "AXButton" then
        if (name of elem as text) is wanted then
          click elem
          return true
        end if
      end if
      if my pressNamed(UI elements of elem, wanted) then return true
    end try
  end repeat
  return false
end pressNamed
end using terms from

tell application "System Events"
  set pulseProcess to first process whose bundle identifier is "com.pulse.work"
  set frontmost of pulseProcess to true
  if not my pressNamed(UI elements of pulseProcess, "Turn on") then error "Pulse's Turn on button was not accessible"
  set permissionDeadline to (current date) + 60
  repeat while (current date) < permissionDeadline
    delay 1
    -- Enumerating live application-process references races when a short-lived process exits.
    -- Inspect only the actual permission-dialog owners, tolerating a missing process this pass.
    repeat with targetName in {"ControlCenter", "NotificationCenter", "UserNotificationCenter", "CoreServicesUIAgent", "System Settings", "pulse-desktop"}
      try
        with timeout of 3 seconds
          set targetProcess to application process (targetName as text)
          if exists targetProcess then
            repeat with targetWindow in windows of targetProcess
              if (current date) >= permissionDeadline then exit repeat
              set controls to entire contents of targetWindow
              repeat with uiControl in controls
                if (current date) >= permissionDeadline then exit repeat
                try
                  if role of uiControl is "AXButton" and (name of uiControl as text) is "Allow" then
                    click uiControl
                    return "Allowed through the real notification permission UI"
                  end if
                end try
              end repeat
            end repeat
          end if
        end timeout
      end try
    end repeat
  end repeat
  error "The runner did not expose the Allow notification control"
end tell
SCRIPT
osascript "$RUNNER_TEMP/allow-pulse.applescript" > screens/macos-notification-authorization.txt 2>&1
screencapture -x screens/macos-notification-settings.png
kill "$pulse_pid"; wait "$pulse_pid" 2>/dev/null || true
# The compiled acceptance path is restricted to the public build repository's hosted context.
GITHUB_REPOSITORY=Estate-Autopilots/pulse-companion PULSE_ACCEPTANCE_DIR="$PWD/screens" "$app_bin" --ping-acceptance > screens/macos-ping.log 2>&1 &
pulse_pid=$!
sleep 3
screencapture -x screens/macos-toast.png
wait "$pulse_pid"
python3 - <<'PY'
import json
p=json.load(open('screens/ping.json'))
assert p['shown'] and p['permission'] is None, p
PY
# Verify the actual delivered banner with Apple's native Vision recognizer, as on the iPhone runner.
swiftc apps/mobile/scripts/ios-screen-check.swift -o "$RUNNER_TEMP/mac-ping-check"
"$RUNNER_TEMP/mac-ping-check" screens/macos-toast.png 'New message in a conversation'
