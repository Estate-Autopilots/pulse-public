# Pulse desktop companion

**v0.2.0 — Pulse Companion.** The app now lives in the tray (Windows) or menu bar (Mac): Ctrl+Alt+P / ⌃⌥P or a click slides up the companion panel (check in, break, back, check out with the My desk rules, live timer, next shift, requests waiting, Pip), with reminders, opt-in start at sign-in and browser sign-in (`src/panel.js`, `src-tauri/src/companion.rs`). The optional focus/idle collector below is unchanged and stays off unless the person accepts the published notice (Settings & privacy). See [Pulse Companion](../../docs/native-apps/companion.md).

Round 14 reuses the existing `apps/desktop` native track. Tauri 2.12.1 hosts a local Connection / Today’s evidence window and an isolated remote Pulse workspace. The Rust collector supports explicit per-user enrollment, OS-stored rotated device credentials, an encrypted bounded metadata queue, exact allowlisted work-app focus/idle summaries and local export fingerprints. It starts paused after restart. Pause discards unsent metadata; resuming requires a fresh purpose receipt and confirmed shift end.

Project association is explicit and checked against shared delivery scope. Filenames, owners, uploads and focus never establish creator attribution. Browser focus is excluded in favor of the extension. Structural parsing is unavailable pending supported-host verification. The optional Photoshop bridge accepts bounded category counts, with a local token and current capture epoch; it cannot execute commands or read files through the bridge.

`core/` has Linux-safe fixture tests; `src-tauri/` owns tray/OS integration; `src/` is the full-screen local UI. There is no ActivityWatch installation, global keyboard hook, privileged daemon, screen capture or window-title upload. Baseline macOS context uses NSWorkspace without requesting Accessibility or screen permissions.

Run `cargo test --locked --manifest-path apps/desktop/core/Cargo.toml`, `pnpm --filter @pulse/desktop test` and `pnpm --filter @pulse/desktop build`. Shell compilation needs platform prerequisites. Windows bundling uses MSI/NSIS; macOS needs explicit DMG bundling and signing on its supported runner. Older native-track installers are not receipts for this source.

## Windows build metadata

After a Windows bundle build, node apps/desktop/scripts/create-build-metadata.mjs writes
apps/desktop/src-tauri/target/release/bundle/pulse-desktop-manifest.json. It records version, full Git commit,
UTC build time and each NSIS/MSI file's name, byte size and SHA-256. On CI, the manifest is uploaded beside both
installers in the 14-day Windows artifact. The VPS publisher verifies each entry before publishing to Pulse's own
download origin; see `tools/desktop-publish/README.md`. Locally, set `GITHUB_SHA` and optionally
`PULSE_DESKTOP_BUILT_AT` to pin provenance; otherwise the current Git commit and UTC time are used.


The release module verifies a pinned manifest signature, artifact hash, platform trust receipt and rollback hash and defers preparation around active exports. It does not execute updates or rollback. No Round 14 signed installer, production release key, approved native authentication route or physical-device acceptance is asserted. See [status and pilot gates](../../docs/native-apps/round-14.md).
