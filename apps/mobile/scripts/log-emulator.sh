#!/usr/bin/env bash
# The runner action parses its input one line at a time. Keep this setup in one invoked script, not a YAML heredoc.
set -euo pipefail
: "${ANDROID_HOME:?Android SDK required}" "${GITHUB_WORKSPACE:?Runner workspace required}"
mkdir -p "$GITHUB_WORKSPACE/screens"
: > "$GITHUB_WORKSPACE/screens/emulator-host.log"
test ! -e "$ANDROID_HOME/emulator/emulator.bin"
cp "$ANDROID_HOME/emulator/emulator" "$ANDROID_HOME/emulator/emulator.bin"
cat > "$ANDROID_HOME/emulator/emulator" <<'SH'
#!/bin/sh
exec >> "$GITHUB_WORKSPACE/screens/emulator-host.log" 2>&1
"$ANDROID_HOME/emulator/emulator.bin" "$@" < /dev/null &
emulator_pid=$!
stop() { printf 'Pulse emulator wrapper received signal: %s\n' "$1"; kill "$emulator_pid" 2>/dev/null || true; wait "$emulator_pid"; exit "$2"; }
trap 'stop HUP 129' HUP
trap 'stop INT 130' INT
trap 'stop TERM 143' TERM
wait "$emulator_pid"
result=$?
printf 'Pulse emulator exit status: %s\n' "$result"
exit "$result"
SH
chmod +x "$ANDROID_HOME/emulator/emulator"
