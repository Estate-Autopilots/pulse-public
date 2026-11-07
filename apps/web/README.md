# apps/web · Pulse web shell

The Next.js app renders the shared Sales Xray shell port from `packages/ui-shell`, with Pulse's person-first views inside it.

## Run locally

From the repository root:

```sh
corepack pnpm install
corepack pnpm --dir apps/web dev
```

The notification page optionally reads `PULSE_TELEGRAM_BOT` from the server runtime environment to show the bot
handle in its setup hint. Leave it unset to hide that line. Configure it at runtime for each deployment; do not use
a `NEXT_PUBLIC_` variable, which would bake one tenant's bot handle into the shared build.

The shell reads `Cf-Access-Authenticated-User-Email` in the server layout. In local development only, a missing header selects a clearly labelled synthetic fixture (`Alex Morgan`). In production, no fixture is substituted when the header is absent. Signed-in staff see their role from `/api/v0/me`. When `/me` is unavailable, the label still comes from the fixed EA admin and HR addresses in `app/lib/admin-access.mjs` and `app/lib/account-identity.ts`; making those configurable per deployment is a follow-up.

Routes: `/my-week`, `/pod` (pod picker), `/pods/[id]`, and `/leadership`. Pod and leadership views currently use synthetic, API-v0-shaped delivery fixtures in `app/lib/weekly-data.mjs`; swap that module for SDK-backed reads when the v0 client is on `main`. The views show week-grain project counts and delivery evidence, with no uploader identity or rankings. Bottleneck and CID coverage show no-data messaging until those source feeds exist. Use `⌘K` (or `Ctrl+K`) to open page search; choose the theme from the account menu or the theme button.

## Checks

```sh
corepack pnpm --dir apps/web lint
corepack pnpm --dir apps/web typecheck
corepack pnpm --dir apps/web test
bash tools/ci.sh
```

Focus home and floating Pip regressions use an isolated synthetic API with populated HR and Chats data:
`ea-heavy corepack pnpm --dir tests/e2e exec playwright test --config focus-home.config.ts --workers=1`.
This checks mouse/touch actions, modal focus/keyboard handling, neutral attendance rows, and unobstructed controls, last rows and chat sends at
390 and 1440 in both themes. Playwright owns and stops the temporary servers; screenshots go to its test results.

`/updates` lists the signed-in person's hand-offs; opening `/updates/[id]` records their receipt. Home and the
navigation use a request-cached summary read and disappear without updates. Detail links disable prefetch.
Focused checks: `ea-heavy node --test --test-concurrency=2 apps/web/app/lib/updates.test.mjs` from the repository
root. Capture synthetic previews in both themes at 390/1280 px with
`PULSE_UPDATES_SCREENSHOT_DIR=<output-dir> ea-heavy node tools/qa/capture-updates.mjs` (one browser page at a time).

## Settings → Desktop build

The organisation owner/admin opens Settings and selects the Desktop build tab at `/settings?tab=desktop-app` to
inspect the latest verified unsigned Windows installer. The server reads `latest.json` from
`PULSE_DESKTOP_DOWNLOADS_DIR`, then verifies the release manifest, file size and SHA-256 before showing metadata
or streaming the installer. Unset or empty storage shows the unavailable state. The VPS publisher pulls the
newest successful main Windows Actions artifact every 10 minutes; see `tools/desktop-publish/README.md` for local
setup and the manifest contract. Tests use temporary synthetic installer bytes and never store real staff data.
