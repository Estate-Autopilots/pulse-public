# Pulse apps — client apps for Pulse by Estate Autopilots

The full Pulse in its own desktop window with a tray/menu-bar quick panel, the Pulse phone app, and a Chrome extension for https://pulse.estateautopilots.com.
The phone app is the Pulse web app inside a thin native shell (Capacitor): sign in once with your Pulse username, and the phone registers itself in Settings → Devices. Desktop apps pair by approving a code in your Pulse browser. Device access is revocable in Settings → Devices.

Client source only, with fresh history. No Pulse server, employee records, research, credentials or signing keys.
GitHub Actions produces Windows MSI/EXE, universal macOS DMG and a Chrome ZIP (companion-builds.yml), and the phone app's Android APK and iPhone Simulator app (mobile.yml).
Desktop update bundles have Tauri signatures, and Android APKs use a persistent Pulse signing identity. Windows and macOS distribution signing is still pending, so the OS may show a warning on the first installation. iPhone installation needs Apple/TestFlight access.

Install an updater-enabled version once from the public releases: choose Windows Setup (.exe) for your Windows account, or drag the Mac app from its DMG into a writable Applications folder. Sign in with your Pulse account. Pip then offers “A new Pulse is ready” with Install and restart / Later. Updates wait for attendance actions and queued work; Later postpones the offer for four hours. Recovery retains the previous app after two failed starts. Managed, machine-wide MSI rollback has not been verified.

From 1.0 every Mac build is signed with one stable Estate Autopilots identity, so updates keep you signed in without Keychain prompts; coming from an earlier test version, Pulse asks you to sign in once more. Saved sign-ins are never read with a Keychain prompt.

Every accepted Companion change is exported through a reviewed client-only allowlist to this repository. A main commit starts hosted builds and required acceptance. Desktop releases publish installers, signed updater bundles, latest-desktop.json and SHA256SUMS.txt. Phone builds publish a signed APK and an iPhone Simulator zip as a separate release. Get the apps reads the published phone pointer; installed Android phones keep the existing updater channel until the owner approves an explicit promote run.

Build: Node from `.nvmrc`, `corepack enable`, `pnpm install --frozen-lockfile`.
Desktop: `pnpm --dir apps/desktop run build`, then `pnpm --dir apps/desktop exec tauri build` on Windows or macOS.
Phone: `pnpm --dir apps/mobile exec cap sync`, then `gradle assembleRelease` in apps/mobile/android (Gradle 8.14, JDK 21) or Xcode with apps/mobile/ios/App/App.xcodeproj, as in mobile.yml. Phone builds are published as normal releases; host-specific builds cannot become GitHub's Latest. The test channel offers a release to installed phones only after an explicit promote run.
Chrome: `node apps/chrome-extension/scripts/package.mjs pulse-chrome.zip`.
Worker cap: two. Workspace checks run sequentially.

All rights reserved. See LICENSE.
