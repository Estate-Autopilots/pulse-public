# Production AI runtime (EA-AI, 23 Oct 2026)

`pulse-prod-coworker` runs `services/coworker/runner.mjs` for production's AI employees, as the user service of
`eadev`, beside `pulse-dev-coworker` (dev). Same runner, same rules: Pulse decides what each AI may do (ask first,
operations access, the database refusals in `0965_ea_ai_guard.sql`); the runner only claims what Pulse gives it and
calls this server's Claude Code / Codex subscription (no API keys).

| Piece | Where |
|---|---|
| Runtime unit | `~/.config/systemd/user/pulse-prod-coworker.service` (copy of `pulse-prod-coworker.service`) |
| Follows the live release | `~/.local/bin/pulse-prod-coworker-follow` (`follow-release.sh`) + `pulse-prod-coworker-follow.{service,timer}` (every 5 min) |
| Code | worktree `~/work/pulse/coworker-prod`, detached at production's `/healthz` release |
| Config and keys | `~/.config/pulse-coworker-prod/prod.json` (API `http://127.0.0.1:4002`), `keys/<username>.key` (600) |
| Quota memory | `~/.local/state/pulse-coworker/quota.json` (shared with dev: same subscriptions) |

Install (as eadev): copy the three units to `~/.config/systemd/user/`, `follow-release.sh` to
`~/.local/bin/pulse-prod-coworker-follow`, `systemctl --user daemon-reload`, `systemctl --user enable --now
pulse-prod-coworker.service pulse-prod-coworker-follow.timer`, then `connect-prod.sh EA <usernames>` (and `PUL
pulse-ceo`). Health: each AI employee's profile → AI tab (checked in / waiting for quota / problem), and
`journalctl --user -u pulse-prod-coworker`.

## Every AI employee, every organisation (AGENTS-LIVE, 7 Nov 2026)
`connect-all.sh`, installed as root's `/usr/local/sbin/pulse-prod-coworker-connect` with
`/etc/systemd/system/pulse-prod-coworker-connect.{service,timer}` (every 30 minutes), connects every active, switched-on,
answering AI employee of every active organisation that no runtime config lists (into `<org code>.json` when that file
exists, else `prod.json`) and renews any key that ends within 14 days (the old key revoked). Before it, an AI employee
was served only after someone ran `connect-prod.sh` for it: Willow Lane's bhrātā never was. Willow Lane's employees run in
their own unit `pulse-prod-coworker-wl` (`wl.json`, `"askOnly": ["savuzo"]`) until per-employee askOnly is released.
