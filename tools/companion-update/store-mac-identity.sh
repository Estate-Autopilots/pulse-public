#!/usr/bin/env bash
# Run once as root: moves the stable self-signed macOS code-signing identity (generated for R15d and already stored
# as the GitHub Actions secrets MACOS_SIGNING_P12_BASE64 / MACOS_SIGNING_P12_PASSWORD of the public build repo) from
# eadev's private folder into root-only storage, then removes eadev's copy. Prints no key material.
#   sudo bash tools/companion-update/store-mac-identity.sh
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Run as root" >&2; exit 1; }
src=/home/eadev/.config/pulse-signing
dest=/etc/estate-autopilots/secrets/pulse-companion
[[ -f $src/pulse-macos-signing.p12 && -f $src/pulse-macos-signing.password ]] || { echo "Nothing to move (already stored?)" >&2; exit 0; }
install -d -m 0700 -o root -g root "$dest"
if [[ -e $dest/pulse-macos-signing.p12 ]]; then echo "A stored identity already exists; keeping it and leaving eadev's copy for review" >&2; exit 1; fi
install -m 0600 -o root -g root "$src/pulse-macos-signing.p12" "$dest/pulse-macos-signing.p12"
install -m 0600 -o root -g root "$src/pulse-macos-signing.password" "$dest/pulse-macos-signing.password"
install -m 0644 -o root -g root "$src/pulse-macos-signing-public.pem" "$dest/pulse-macos-signing-public.pem"
cmp -s "$src/pulse-macos-signing.p12" "$dest/pulse-macos-signing.p12"
shred -u "$src/pulse-macos-signing.p12" "$src/pulse-macos-signing.password"
echo "Stored root-only in $dest (leaf SHA-1 $(openssl x509 -in "$dest/pulse-macos-signing-public.pem" -noout -fingerprint -sha1 | sed 's/.*=//; s/://g'))"
