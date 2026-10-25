# Pulse server CPU rules (owner, 8 October 2026)

Run every heavy command through `/usr/local/bin/ea-heavy <command>` on this VPS: CI, Playwright, unit/integration tests, builds, Rust/Tauri, Expo and Gradle. The wrapper provides one shared slot, nice 19, idle IO, and waits during ea-cooldown holds. Nested commands inherit the slot. Never bypass a hold or start a second heavy job. Keep health, status, guards and Paperclip responsive.

Use at most two workers: `playwright test --workers=2`, Node `--test-concurrency=2`, test runners at most two workers, `cargo -j2`, Gradle `--max-workers=2`, and Next `experimental.cpus: 2`. Run workspace packages sequentially. Prefer GitHub-hosted macOS/Windows/Android/iOS runners for native builds; do not run native builds on the VPS when a hosted runner is available.

`tools/ci.sh` enters ea-heavy automatically locally; GitHub-hosted runners run the same checks with the same worker caps. Preserve assertions and migration order. Do not touch the owner's separate companion worktree or change team seats, models, or owner-paused seats.
