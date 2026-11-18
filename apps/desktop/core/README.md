# Desktop collection core

`tracker.rs` implements the native-device API client, OS credential storage on Windows/macOS, encrypted metadata queue, source pause/shift gates, local allowlist and export fingerprint watcher. Approved work windows use IANA timezones and minute precision, including overnight shifts. Missing samples, sleep and restart produce gaps. Unsupported parsers produce no structural estimates.

Source IDs, sequence, occurrence time, interval start and permission receipts go through `/native/batches`. Only acknowledged IDs are removed. The queue is capped at seven days, 20,000 entries and 8 MiB. Permitted payloads exclude paths, names, window titles and text. Credentials are excluded from serialized settings. Linux is a fixture target, not a supported staff collector.

`release.rs` provides signature/hash/rollback preparation gates without an installer executor. `lib.rs` retains the earlier typed ingest library for compatibility tests; it does not create the new tracker’s events and after-hours capture is disabled. Legacy environment transport is not the staff enrollment route.

The compatibility library uses the registry purpose `activity_context` for hourly usage events, including hours marked `after_hours`. It removes events for every ID present in the ingest receipt list (including permanent rejections) and retries only events omitted from that list. Pause choices are encrypted alongside the outbox and survive restarts; timed pauses use a UTC wall-clock deadline, while “until you resume” persists as a flag.

Run `cargo test --locked --manifest-path apps/desktop/core/Cargo.toml`. Fixtures do not certify physical permissions, resource cost, OS focus APIs, install, update or pause behavior. See [pilot gates](../../../docs/native-apps/round-14.md).
