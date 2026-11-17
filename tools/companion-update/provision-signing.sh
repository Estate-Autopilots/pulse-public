#!/usr/bin/env bash
# Run once as root. No key material is printed; never enable shell tracing.
set -euo pipefail
[[ ${EUID} == 0 ]] || { echo 'Root is required to keep the updater private key root-only.' >&2; exit 1; }
umask 077
secret_dir=/etc/estate-autopilots/secrets
key_file=$secret_dir/pulse-companion-updater.key
public_file=/home/eadev/ea-research/pulse-companion-updater.pub
cli=/home/eadev/work/pulse/strike/apps/desktop/node_modules/@tauri-apps/cli/tauri.js
install -d -o root -g root -m 700 "$secret_dir"
if [[ ! -e $key_file ]]; then
  /usr/local/bin/ea-heavy node "$cli" signer generate --ci --password '' --write-keys "$key_file" >/dev/null 2>&1
fi
[[ -f $key_file && ! -L $key_file && -s $key_file.pub ]] || { echo 'Signing key pair is incomplete.' >&2; exit 1; }
chown root:root "$key_file" "$key_file.pub"
chmod 600 "$key_file" "$key_file.pub"
GH_CONFIG_DIR=/home/eadev/.config/gh gh secret set TAURI_SIGNING_PRIVATE_KEY --repo Estate-Autopilots/pulse-companion < "$key_file"
android_store=$secret_dir/pulse-companion-android.p12
android_password=$secret_dir/pulse-companion-android-password
if [[ ! -e $android_store ]]; then
  openssl rand -base64 36 | tr -d '\n' > "$android_password"
  /usr/local/bin/ea-heavy openssl req -x509 -newkey rsa:3072 -nodes -keyout "$secret_dir/pulse-companion-android-private.pem" -out "$secret_dir/pulse-companion-android-cert.pem" -days 10000 -subj '/CN=Pulse Companion/O=Estate Autopilots' >/dev/null 2>&1
  openssl pkcs12 -export -name pulse -inkey "$secret_dir/pulse-companion-android-private.pem" -in "$secret_dir/pulse-companion-android-cert.pem" -out "$android_store" -passout "file:$android_password" >/dev/null 2>&1
fi
[[ -f $android_store && ! -L $android_store && -s $android_password ]] || { echo 'Android signing store is incomplete.' >&2; exit 1; }
chown root:root "$android_store" "$android_password"
chmod 600 "$android_store" "$android_password"
base64 -w0 < "$android_store" | GH_CONFIG_DIR=/home/eadev/.config/gh gh secret set ANDROID_SIGNING_STORE_BASE64 --repo Estate-Autopilots/pulse-companion
GH_CONFIG_DIR=/home/eadev/.config/gh gh secret set ANDROID_SIGNING_PASSWORD --repo Estate-Autopilots/pulse-companion < "$android_password"
install -o eadev -g eadev -m 644 "$key_file.pub" "$public_file"
echo 'Desktop updater and Android signing keys stored root-only; Actions secrets configured; public key ready.'
