# pulse: the Pulse command line

`pulse` signs in with your own Pulse account and runs every Pulse API v1 operation from a terminal or a script:
find people, read the onboarding roster, correct a staff record, create a chat group, triage bug reports, list and
undo your changes. It acts as you, with your roles; Pulse checks every call. Node 20 or later; no dependencies.

## Install

From your Pulse address (no npm account, nothing published):

```sh
npm install -g https://pulse.example.com/downloads/pulse-cli.tgz     # then: pulse --help
npx -y https://pulse.example.com/downloads/pulse-cli.tgz whoami       # one-off, nothing installed
pnpm dlx https://pulse.example.com/downloads/pulse-cli.tgz whoami
```

From this repository: `pnpm --filter @pulse/cli build`, then `node packages/pulse-cli/dist/cli.js …` or
`npm install -g ./packages/pulse-cli/dist/pulse-cli.tgz`.

## Sign in

```sh
pulse login                       # opens Pulse's consent screen in your browser; choose Allow
pulse login --no-browser          # on a server or over SSH: open the printed link anywhere, paste back the final address
pulse login --token               # store a token you already have (asked without echo; or: echo "$T" | pulse login --token)
pulse whoami
pulse logout                      # ends the connection at Pulse and forgets it here
```

`pulse login` is "Sign in with Pulse" (OAuth 2.1): the CLI registers itself, opens the consent screen and listens once on
`127.0.0.1` for the answer (PKCE S256, state and issuer checked). The access token lasts an hour and the CLI renews it
itself; the refresh token rotates. Pulse has no OAuth device-code grant, so `--no-browser` is the headless fallback.
Sign-ins are stored per Pulse address in `credentials.json` in the OS config directory (`%APPDATA%\pulse`,
`~/Library/Application Support/pulse`, or `$XDG_CONFIG_HOME/pulse` / `~/.config/pulse`; `PULSE_CONFIG_DIR` overrides),
mode 0600. Scripts and CI set `PULSE_TOKEN` instead; it overrides every stored sign-in.

The Pulse address is `--host`, else `PULSE_HOST`, else the address of your last `pulse login`, else the hosted service
(`https://pulse.estateautopilots.com`). Addresses are https (plain http only on localhost).

## Commands

| Command | API operation |
|---|---|
| `pulse whoami` | `whoAmI` |
| `pulse search <query>`, `pulse fetch <id>` | `search`, `fetch` |
| `pulse people search [query] [--status active\|inactive\|offboarded\|all]` | `searchPeople` |
| `pulse people get <personId>` | `getPerson` |
| `pulse hr onboarding [--stuck true]` | `listOnboarding` |
| `pulse hr correct <personId> --field <f> --value <v> --reason "…"` (`--no-value` clears) | `correctPersonField` |
| `pulse hr otp <personId>` | `issueOneTimePassword` |
| `pulse hr sign-in-email <personId> invite\|reset` | `sendSignInEmail` |
| `pulse groups create <name> [--member-ids a,b] [--all-active-staff]` | `createChatGroup` |
| `pulse groups members <groupId> [--add a,b] [--remove c]` | `changeChatGroupMembers` |
| `pulse changes list`, `pulse changes undo <changeId>` | `listMyChanges`, `undoChange` |
| `pulse bugs list [--status new\|seen\|done\|all]`, `pulse bugs set-status <reportId> new\|seen\|done` | `listBugReports`, `setBugReportStatus` |
| `pulse op <operationId> …` | any operation, by id |
| `pulse ops` | every operation, its command and scope |
| `pulse api <METHOD> <path> [--query k=v] [--data json\|@file\|-]` | any API path, raw JSON |

Every command has `--help`. Lists print tables and records print aligned fields; `--json` prints Pulse's answer
unchanged. Writes send an `Idempotency-Key` (a new UUID, or `--idempotency-key` to retry safely) and accept
`--data` for the whole body. Exit codes: 0 ok, 1 Pulse or the network failed, 2 not signed in, 3 refused (role or
scope), 4 wrong command or input, 5 rate limited. Tokens never appear in output or errors.

## Development

The operations come from `services/api/openapi/v1.yaml`: after the v1 reference changes, run
`pnpm --filter @pulse/cli generate` (lint fails while `src/operations.generated.ts` is stale). A new operation works at
once as `pulse op <operationId>`; give it a friendly name in `src/commands.ts`. `pnpm --filter @pulse/cli build`
compiles to `dist/` and packs `dist/pulse-cli.tgz`, which the web app serves at `/downloads/pulse-cli.tgz`.
`pnpm --filter @pulse/cli test` runs the unit tests, a browser sign-in against a local fake Pulse, and (when
`services/api/dist` is built) the CLI against the real API v1 front door with a synthetic database seam.
