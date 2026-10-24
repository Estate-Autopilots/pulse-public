# Current live workbench (Round 7A2)

`pulse-dev` currently serves `design/home` directly from `/home/eadev/work/pulse/strike`:
Next dev on loopback port 3200, API on loopback port 3203, behind Cloudflare Access.
The web service's `strike.conf` override selects this checkout. The old web-lane deployment timer is disabled
so it cannot restart this workbench for another lane. The historical release deployment instructions below are
for a future switch back to release mode; do not run `install.sh` during this live workbench.

The Map is in the main app at `/map`. Separate `pulse-map-web` and `pulse-map-api` services are stopped;
the separate preview route is retained. No staging or production deployment is part of this round.

```sh
# Build without overwriting the running Next dev output.
NEXT_DIST_DIR=.next-build pnpm --filter @pulse/web build
pnpm --filter @pulse/api build
systemctl --user restart pulse-dev-api

# Load the local dev credentials without printing them.
set -a
source /etc/estate-autopilots/db/pulse_dev.env
set +a
uv run --all-packages pulse-migrate
uv run --all-packages python -m pulse_workers.company_seed --dir ~/ea-research/data/enrich
uv run --all-packages python -m pulse_workers.geo_seed --dir ~/ea-research/data/geo
# Once the owner has supplied a backup (or use the Ops Hub page button):
uv run --all-packages python -m pulse_workers.opshub_seed --file ~/ea-research/data/opshub/backup.json
```

Imports print counts only. Keep source datasets, financial values, mail, credentials and private screenshots
outside the repository. Manual locks, stable source identities and active merge redirects survive replay.
Finance sources are observations until leadership reconciles them; project/client revenue uses confirmed ledger rows.

Flags default off: `PULSE_GMAIL_SEND_ENABLED=1` and `PULSE_DRIVE_UPLOAD_ENABLED=1` belong on the API only after
Workspace scope/folder access is verified. `PULSE_PUBLIC_LOGIN_ENABLED=1` belongs on a future public web deployment;
pulse-dev stays behind Access. Google calls use `PULSE_GOOGLE_PYTHON` (default the existing ea-intel Python),
the existing service-account key, and the authenticated person's individual Workspace account.

Personal decision notifications use `pulse-dev-notifications.timer` and the included oneshot service, installed
as eadev user units (`install -m 0644 tools/pulse-dev/pulse-dev-notifications.{service,timer} ~/.config/systemd/user/`).
The same minute tick runs office presence, reminders and forgotten check-outs; Telegram is optional (without
`/etc/estate-autopilots/secrets/telegram.env` the channel reports "disabled" and everything else runs). Each person must start the bot and an admin must connect their verified private chat in
Notifications. There is no owner/group-chat fallback. The worker sends generic decision text and a Pulse link,
never HR reasons, salaries or finance. Unconnected recipients stay explicitly marked in-app.

The owner handoff is `~/ea-research/ROUND-5B-DONE.md`, including exact Workspace Admin steps, current source
coverage, outstanding review decisions and the test evidence.

## Team onboarding and Chats (Round 7A)

Chats is at `/chats`; `/communication` redirects there. Inbox redirects to `/chats?source=email`; team chats and personal Gmail share the Chats frame.
Company channels are derived from current Pulse pods, departments and explicitly mapped Google groups.
Employee DMs remain participant-only, including for admins. Admins can moderate company channels.
Files are limited to 5 MB each (five attachments per message); larger files can be shared as Drive links.
SSE checks sessions and membership every 2.5 seconds, reconnects after 45 seconds, and has a 15-second fallback.
Message/file bodies are excluded from audit metadata. A daily retention job deletes messages older than 365 days
and abandoned files older than one day. In-app mention/DM/thread notifications never queue chat text to Telegram.

HR/admin can issue a seven-day one-time password from a People record, or choose **Invite everyone current**
in Settings → Sign-in. Bulk issuance preserves existing active and disabled credentials. Private slips can be
printed/downloaded once; the database stores hashes only. Existing employee IDs stay `EA-P###`; Pulse IDs use
`PLS-######`. New usernames use `firstname.lastname` with a numeric suffix on collision. First password sign-in
requires a different password before workspace access. Forgot-password enters the HR/admin reset queue.
Deactivating a People record revokes sessions, disables its password and removes channel memberships.
HR cannot reset admin/leadership credentials. Google sign-in uses the existing individual Workspace identity
from Cloudflare Access; Pulse password sessions can switch identity inside that gate.

**External access prerequisite:** pulse-dev retains its existing Cloudflare Access policy. Root must admit the
intended staff identities (including an Access authentication route for staff without Workspace accounts) before
whole-team invitations are usable from the public dev URL. The public-login bypass remains disabled.

The indexer service account reads Directory groups, group membership and users/aliases with read-only scopes,
delegated to the existing Workspace admin. `pulse-dev-directory.timer` refreshes every 15 minutes atomically;
a failed read retains the prior snapshot. `/groups` separates observed membership from expected Pulse mappings
and shows editable account/group aliases separately from generated domain aliases. Admin mapping changes
update Pulse only. HR/leadership/admin can download membership GAM commands for root review; Pulse never applies
Google membership changes. Current snapshot: 12 groups, 11 editable account aliases, 5 editable group aliases,
37 generated domain aliases. This differs from the brief's expected 13 aliases.

```sh
systemctl --user status pulse-dev-directory.timer pulse-dev-chat-retention.timer
systemctl --user start pulse-dev-directory.service
# Read-only refresh manually, after loading pulse_dev.env:
uv run --all-packages python -m pulse_workers.workspace_directory
```

HR owns people data/payroll; leadership owns people data, payroll, Money and company performance. Operational
admins retain named salary/finance grants. Manager/PGS scope uses explicit unit roles or confirmed reporting
lines, never a guessed title. Review each person's assigned pod and role in Settings before rollout.
The complete handoff and review-only GAM plan are `~/ea-research/ROUND-7A-DONE.md` and
`~/ea-research/round-7A/workspace-gam-plan.txt`.

## Round 7A2 workspace

Migrations 0027–0034 add the visual Money workspace, statement import, tool details and verified cash,
employee salary components, versioned policies/acknowledgements, changes-first audit, review rules and
scoped performance primitives. All are applied on pulse-dev. `/my-week` redirects to `/tasks?view=week`.
The rail is icon-only with work, people, money and admin separators; the CSS root fix stays last.

Statement import accepts CSV, Excel (.xlsx/.xls) and text PDF, up to 5 MB / 2,000 rows. It previews category,
possible duplicates, amount units and direction before saving unreconciled observations. Raw files are
transient; stored account identity is last four digits only, references hashed, account numbers/credentials
excluded. Scanned/encrypted PDFs need a CSV/Excel export. Financial totals use only reconciled canonical
ledger rows, separate each currency and never add bills/mail a second time. Runway requires verified cash,
complete reconciled history and positive net burn. Budget approval is an explicit leadership action.

Published policies live on My desk → Policies; HR authors draft revisions and can inspect version-specific
acknowledgements. No unapproved policy text, finance reconciliation, budget, or review decision was invented.
Auto-accept rules default off and apply only to high-confidence pod/contact suggestions with evidence and
unlocked fields. PGS, identity, reporting lines and leave entitlements require individual review.

`PULSE_AA_ENABLED`, `PULSE_TELEGRAM_CHAT_ENABLED` and `PULSE_WHATSAPP_CHAT_ENABLED` default off. The AA consent
connector is a design preview awaiting an eligible FIU partner and licensed AA. External chat payload adapters
are prepared; account credentials, participant mapping and webhook/persistence wiring await sandbox setup.
See [connector contracts](../../docs/integrations/round-7A2-connectors.md). No external chat transport is connected.
Desktop/editing/office observations can use the normalized admin intake; current performance views display
observed data and missing quality/outcome coverage explicitly. Office/CCTV intake stores metadata, never footage.

The handoff is `~/ea-research/ROUND-7A2-DONE.md`; screenshots and test receipts are private, outside this repository.

## Historical web-lane deployment

https://pulse-dev.estateautopilots.com (Cloudflare Access, owner + admin@) shows the web lane's newest pushed commit,
at most about 12 minutes after the push. The owner checks it hourly (EST-125); it is not staging and has no data
guarantees.

- **Lane:** `ops` (Pulse CTO). eadev user units, no root; the Access route `pulse-dev → 127.0.0.1:3200` exists
  (`sudo ea-agent route pulse-dev.estateautopilots.com 3200` recreates it).
- **Issue:** EST-128.

## How it works

`pulse-dev-deploy.timer` runs `deploy.sh` every 10 minutes. It:

1. picks the newest `task/web/*` head in `/home/eadev/git/pulse.git` by committer date, else `main`;
2. stops there if that commit is already served, or already failed (a failed commit is retried only after a new push);
3. builds it into `~/pulse-dev/releases/<sha>` (`git archive`, `pnpm install --frozen-lockfile`,
   `pnpm --filter @pulse/web run build`), log in `~/pulse-dev/logs/<sha7>.log`;
4. on success points `~/pulse-dev/current` at it, restarts `pulse-dev-web.service` (`next start` on
   `127.0.0.1:3200`) and waits for `/healthz.json` to report the new commit; if it does not come up, it points
   `current` back at the previous release and restarts again;
5. keeps the newest three releases.

A broken build therefore never replaces what is up. The served commit is at
https://pulse-dev.estateautopilots.com/healthz.json (`branch`, `commit`, `builtAt`); the build also sets
`NEXT_PUBLIC_PULSE_COMMIT` and `NEXT_PUBLIC_PULSE_BRANCH` so the shell footer can show it.

## Run and check

```sh
tools/pulse-dev/install.sh                        # install or update: copies deploy.sh, links units, enables timer
export XDG_RUNTIME_DIR=/run/user/$(id -u)
systemctl --user start pulse-dev-deploy.service   # deploy now instead of waiting for the timer
~/pulse-dev/bin/deploy.sh --force                 # rebuild the chosen head even if served or failed before
journalctl --user -u pulse-dev-deploy -n 20       # what the last runs did
systemctl --user list-timers pulse-dev-deploy.timer
curl -s http://127.0.0.1:3200/healthz.json        # served commit
```

Settings (environment of `deploy.sh`): `PULSE_DEV_REFS` (default `refs/heads/task/web/`), `PULSE_DEV_REPO`,
`PULSE_DEV_HOME` (`~/pulse-dev`), `PULSE_DEV_PORT` (3200), `PULSE_DEV_KEEP` (3). Edit the files here and re-run
`install.sh`; the installed copy lives in `~/pulse-dev/bin` so lane checkouts can change freely.


The desktop build endpoint reads `%h/pulse-downloads/desktop` through `PULSE_DESKTOP_DOWNLOADS_DIR`. The separate
eadev `pulse-desktop-publish.timer` populates this directory from verified successful main Windows build artifacts;
install it with `tools/desktop-publish/install.sh`.
