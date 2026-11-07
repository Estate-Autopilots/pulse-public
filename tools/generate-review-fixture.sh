#!/usr/bin/env bash
# Deterministic synthetic video for the dev rehearsal; no client media. Never deploys anything.
set -euo pipefail
fixture_root=${PULSE_REVIEW_MEDIA_ROOT:-/home/eadev/.local/share/pulse-review}
mkdir -p "$fixture_root"
ffmpeg -loglevel error -f lavfi -i 'testsrc2=size=960x540:rate=24:duration=24' -c:v libvpx -b:v 1500k -deadline realtime "$fixture_root/synthetic.webm" -y
