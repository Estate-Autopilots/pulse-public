# Phone QA on real phones (PHONE-QA, 5 Nov 2026)

Tools for testing Pulse on real Android phones over USB, with test accounts only. They never touch production and
never change a server.

| Tool | What it does |
| --- | --- |
| `origin-proxy.mjs` | Runs on the laptop and listens on loopback only. It lets a phone reach **staging** through an ssh tunnel. It sends the staging public address as Host and Origin, so the API proxy's same-origin guard accepts POSTs (no more "Invalid origin"), and it maps redirects back to `http://localhost:<port>`. It drops identity headers (Cloudflare Access, sessions). Sign-in still goes through Pulse itself. |
| `phone-qa-serve.mjs` | Runs on the server, through `ea-heavy`. It starts the real API in-process on a disposable synthetic database that a QA-E2E run kept, plus a private `next dev` in public sign-in mode on `http://localhost:<port>`. Mail and pushes go to sinks, and `/mail?to=` on the control port shows the codes they caught, so sign-up and e-mail-code sign-in work with invented addresses. |
| `make-qa-shell.mjs` | Copies `apps/mobile` and patches the copy into **Pulse QA** (`com.pulse.work.mobile.qa`, debug key, plain-HTTP loopback origin, WebView debugging on). It installs next to a tester's real Pulse app without replacing it. Every patch must find its token. |
| `phone-cdp.mjs` | Drives a phone's Chrome tab or the Pulse QA WebView over DevTools (`adb forward tcp:N localabstract:chrome_devtools_remote` or `webview_devtools_remote_<pid>`). It can fill a field by its label, click by text, read text and navigate. |

## Recipe

```sh
# server: a synthetic agency, kept (pulse_ci_* scratch database only)
PULSE_CI_DATABASE_URL=<scratch pulse_ci_phoneqa URL> PULSE_QA_E2E_SEED_FILE=<seed.json> KEEP=1 QA_ONLY=auth \
  ea-heavy uv run --all-packages pytest tests/core/test_qa_e2e.py -k backend
ea-heavy node tools/qa/phone-qa/phone-qa-serve.mjs <seed.json> 4610 4611
# laptop
ssh -N -L 4610:127.0.0.1:4610 -L 4611:127.0.0.1:4611 ea
adb -s <serial> reverse tcp:4610 tcp:4610
# QA app (laptop needs JDK 21, Android SDK 36, Gradle 8.14.3; the repo has no gradlew)
node tools/qa/phone-qa/make-qa-shell.mjs <out> http://localhost:4610 && (cd <out> && npx cap sync android)
gradle -p <out>/android assembleDebug && adb -s <serial> install -r <out>/android/app/build/outputs/apk/debug/app-debug.apk
```

Staging instead: run `origin-proxy.mjs --listen 4612` and point the phone at `http://localhost:4612`
(`adb reverse tcp:4610 tcp:4612` for the QA app). Staging sends mail only to its allow-list, so codes for test
addresses never arrive there. Use the synthetic stack for sign-up and code journeys.

## Traps

- HyperOS phones refuse `adb install` (`INSTALL_FAILED_USER_RESTRICTED`) until **Install via USB** is turned on in
  Developer options. That needs the phone's owner. Do not change install permissions from a script.
- The QA app has no Firebase file (`google-services.json`), so its calls ring only while Pulse is open or when the
  WorkManager check runs. A ring with Pulse in the background needs the release build's FCM.
- `ssh ea` runs through `cloudflared access`, and on 5 Nov its `-L` forwards stalled every few minutes. A stalled
  forward leaves its laptop port bound, and the phone's open sockets hang (the page goes blank and DevTools
  `Runtime.evaluate` times out). Restart the forward on fresh ports, keep `adb reverse` pointed at one small loopback
  relay that follows the current port, and force-stop the app or Chrome so they drop their dead sockets.
- A laptop that runs low on memory (Gradle daemons) takes the adb server down, and every reverse and forward goes
  with it. Run `gradle --stop` after the build, then set the reverses and forwards up again.
- `next dev` writes `apps/web/.next-phoneqa`. Delete it after the run.
- Heads-up notifications from other apps show up in `screencap` output. Check screenshots before you share them.
