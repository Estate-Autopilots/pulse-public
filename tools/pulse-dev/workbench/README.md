# pulse-dev workbench tuning

pulse-dev serves the live checkout with `next dev` (Turbopack) so the owner sees edits land within a second or two.
This directory makes that workbench snappy on a shared 4-vCPU box without buying compute. Install (eadev user, no root):

```sh
tools/pulse-dev/workbench/install.sh
```

What it installs:

- **CPU priorities** (`units/*.d/workbench.conf`, applied live by the installer): `pulse-dev-web` and `pulse-dev-api`
  get `CPUWeight=1000`; the agent seats (`paperclipai`, which also contains their Codex/Claude jobs, builds, lint and
  Playwright runs), local CI, the release train, the index refresh and the projections worker get 25–50 and `Nice=10–15`.
  Weights are relative (default 100): when the owner opens a page the dev server gets up to 25–40× the share of
  batch work; when nobody is looking, batch work gets everything.
- **Route pre-warm** (`pulse-dev-warm`, a oneshot unit `PartOf` the web unit): after every start or restart of the dev
  server it compiles the common routes at idle priority, without an identity header (no API calls, no audit rows), so
  the first visit after a restart does not wait 20–60 s for the compile.
- **Heal check** (`pulse-dev-heal`, run by the existing `pulse-dev-heal.timer` every 3 minutes): restarts the dev server
  only when a journal failure is confirmed by a live probe of `/dashboard`, or when `/healthz` does not answer within
  90 s. A restart is expensive (every route compiles again), so a compile error the developer already fixed no longer
  causes one.

  It also restarts the server when `/api/v0/me` answers 404 on two consecutive checks (the app routes went missing
  after a restart twice on 23 Oct); `pulse-dev-recycle` checks the same right after each restart.
- **Memory recycle** (`pulse-dev-recycle`, OPS-2): a long-running `next dev` keeps what it compiled; it held 1.7-2 GB
  after three days (peak 5.4 GB) while the box's swap was full and the kernel was killing Chromium and the dev server
  (11 Oct). `pulse-dev-recycle.timer` restarts it when its processes hold more than 2.5 GB (checked every 10 minutes),
  `pulse-dev-recycle-nightly.timer` once a night at 02:30 IST; never within 30 minutes of a start. Each decision is in
  `~/ea-intel/logs/pulse-dev-recycle.log`; pulse-dev-warm compiles the common routes again afterwards.

Measurement scripts live in `~/ea-research/perf-dev/` (page timings with a headless browser; API endpoint timings;
SQL timings as the API role). The before/after numbers are in `~/ea-research/PERF-DEV-DONE.md`.
