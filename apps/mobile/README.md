# Pulse phone shell

Android and iPhone wrap the Pulse web app. Native builds and emulator acceptance run on GitHub-hosted runners.
Run static checks with `pnpm --dir apps/mobile test` (on the VPS, through `/usr/local/bin/ea-heavy`).

`PULSE_ORIGIN=https://pulse.example.com pnpm --dir apps/mobile sync android` applies the single Android build
setting before Capacitor sync: config, redirect, offline recovery, Java host and verified App Links.
Omit `PULSE_ORIGIN` to restore the unchanged EA default. Only `https://` plus a lowercase DNS host is accepted;
ports, paths (including a trailing slash), queries, fragments and credentials are rejected.
Run tests before configuring an origin; tests use disposable copies to exercise both builds.

In the public phone workflow, dispatch `origin=https://<host>` and `signin_text` matching that install's sign-in
form (default `Username`). This builds and accepts Android only, retains the package/signing identity, and
publishes a host-specific normal release (excluded from GitHub's Latest) and `android-<host>-entry.json` on `companion-phone`. Its tag appends
the first eight hex characters of SHA-256(origin) to the commit suffix. It does not move update channels or EA
download entries. A supplied origin takes precedence over `promote`; iPhone builds stay on the default origin.
Android's updater offers and downloads only release tags for its own origin: exactly seven commit hex characters
for EA's default build, or seven commit characters plus that origin's exact eight-character hash suffix.

The required `android-gps-photo` hosted job uses a synthetic page in the release WebView and the emulator's rear
camera/GPS. It verifies a decoded camera image reaches the file field, the gallery chooser remains available,
foreground location allow returns the injected fix, and denial returns permission error 1 while the page remains
usable. It never grants Pulse location through ADB or enrolls a real person. Evidence is in
`phone-android-gps-photo-<sha>` (results, screenshots and journals). Dispatch `validation_only=true` with
`qa_phases=gpsphoto` for a focused Android baseline; no release is published. The publishing job requires this
check for every address, including custom-origin builds.

Shell 1.1.4 retains the existing system camera intent and Capacitor foreground geolocation handler: no camera
permission or new plugin is needed. GPS acceptance seeds and selects a synthetic existing image through Android's
Media provider and archives raw package/appops grants before the tap and after Allow. Native notification acceptance
waits at most three seconds for posting, distinguishes a missing notification from a missing public copy, and saves
state for both notification permission choices even on failure.
