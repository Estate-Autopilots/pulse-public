# Pulse work-site context

**v0.2.0 — Pulse Companion.** The toolbar popup is the companion panel (check in, break, back, check out, timer, Pip) with a status badge and reminders (`popup.js`, `companion-worker.js`); `shared/` is a synced copy of `packages/companion` (`node scripts/sync-shared.mjs`), `node scripts/package.mjs` builds the ZIP. The work-context features below moved to `context.html` and stay opt-in. See [Pulse Companion](../../docs/native-apps/companion.md).

MV3 source, reusing the native track. Explicit approved hosts only, optional permissions, foreground/idle/work-hour filtering and stable local resource mapping. No content scripts, DOM/forms/message reading, cookies, request bodies, screenshots, raw URL/query/title persistence or private profile capture. Personal domains remain excluded.

The popup has Account, Controls and paged Evidence views. The worker uses supported events and one-minute alarms. Its process restart removes interval state and records no guessed gap duration. Desktop browser focus is excluded; server interval union covers overlapping devices.

Access credential and encryption key use session storage; encrypted local metadata is unreadable after browser closure and requires fresh sign-in/purpose confirmation. Queue is bounded to 2,000 events/seven days; acknowledgements precede deletion. Pause clears the unsent queue before a network request.

Run `pnpm --filter @pulse/chrome-extension test` and `pnpm --filter @pulse/chrome-extension lint`. No Chrome Web Store/enterprise rollout or native messaging host is claimed. A dedicated work-profile physical pilot, approved notice, exact tested Chrome version and reachable native route remain required. Adding client portals requires reviewed exact optional-host manifest entries, never all-sites permission. See [pilot gates](../../docs/native-apps/round-14.md).
