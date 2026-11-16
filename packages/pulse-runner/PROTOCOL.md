# Pulse Runner Protocol v1

The contract between `pulse-runner` and the Pulse API. `test/mock-pulse.js` implements the Pulse side of this document and is the executable reference.

## Conventions

- **Base URL:** `https://api.vitalsos.ai`. All paths below start with `/runner/v1`.
- **Direction:** the runner makes every request. Pulse never connects to the runner. There are no inbound ports.
- **Transport:** HTTPS only. The runner refuses plain HTTP except to loopback (used for tests), and does not follow redirects, so Pulse must not redirect these endpoints.
- **Bodies:** JSON (`Content-Type: application/json`), except output uploads.
- **Timestamps:** ISO 8601 UTC strings.
- **Auth:** every endpoint except `/pair` needs `Authorization: Bearer <credential>`.
- **Unknown fields:** both sides must ignore them, so that the protocol can grow without a version bump.

### Errors

Any non-2xx response should have this body:

```json
{ "error": { "code": "runner_revoked", "message": "This runner was revoked in Pulse." } }
```

| Status | `code` | Runner behaviour |
|---|---|---|
| 400 | `invalid_request` | Logged. Not retried for the same payload, except that results are retried a few times. |
| 401 | `runner_revoked` | **Terminal.** Kills all jobs, deletes the local credential, exits with code 78. systemd does not restart it. |
| 401 | anything else | Treated as temporary: logged and retried with backoff. The credential is kept. |
| 404 / 409 | `job_not_active` | On a job endpoint: Pulse no longer wants this job. The runner cancels it locally. |
| 429 | `rate_limited` | Retried with backoff. |
| 5xx / network | any | Retried with exponential backoff and jitter (1 s up to 60 s). |

Only `401` with exactly `runner_revoked` deletes the credential, so a Pulse bug or proxy error cannot unpair a server. Pulse must send that exact code when an admin revokes a runner.

## 1. Pairing

The admin clicks "Connect a server". Pulse creates a code in the form `ABCD-1234` (`^[A-Z0-9]{4}-[A-Z0-9]{4}$`). It is valid for 10 minutes and single use. Pulse should rate-limit attempts per IP, and should store only a hash of each credential.

### `POST /runner/v1/pair` (no auth)

Request:

```json
{
  "code": "ABCD-1234",
  "runner": { "hostname": "wl-server", "os": "linux", "arch": "x64", "version": "0.1.0" }
}
```

`200` response:

```json
{
  "runnerId": "run_01J9Z",
  "orgId": "org_willowlane",
  "orgName": "Willow Lane",
  "credential": "<shown once: prc_ and at least 32 characters>"
}
```

- `credential` is scoped to this one runner and organisation, and revocable from Pulse. It is shown once.
- It should start with `prc_`. The runner also redacts that prefix from anything it sends or logs.

Errors: `400 invalid_request`, `404 invalid_code`, `410 expired_code`, `409 code_used`, `429 rate_limited`.

### `POST /runner/v1/deregister`

Sent on a best-effort basis by `pulse-runner uninstall`. Pulse should revoke the credential and mark the server as removed. Empty body `{}`. Response `{ "ok": true }`.

## 2. Heartbeat

### `POST /runner/v1/heartbeat`

Sent every 30 seconds.

```json
{
  "version": "0.1.0",
  "status": "ready",
  "runningJobs": ["job_123"],
  "maxConcurrent": 2,
  "uptimeSec": 3600
}
```

`status` is `ready` or `draining`. Response: `{ "ok": true, "serverTime": "2026-11-05T10:00:00Z" }`.

Pulse should show a server as offline after about 90 seconds without a heartbeat or poll.

## 3. Capabilities

### `POST /runner/v1/capabilities`

Sent on start, every hour, and after each `pulse-runner login`. Response: `{ "ok": true }`.

```json
{
  "runnerVersion": "0.1.0",
  "reportedAt": "2026-11-05T10:00:00Z",
  "system": {
    "os": "linux",
    "arch": "x64",
    "cpu": { "model": "AMD EPYC", "cores": 8, "loadAvg1": 0.42 },
    "ram": { "totalBytes": 34359738368, "freeBytes": 12884901888 },
    "disk": { "totalBytes": 500000000000, "freeBytes": 250000000000 }
  },
  "ai": {
    "claude": { "installed": true, "version": "2.1.0", "loggedIn": true, "authMethod": "claude.ai", "subscriptionType": "max" },
    "codex": { "installed": false, "version": null, "loggedIn": false }
  },
  "tools": { "node": "24.1.0", "python": "3.14.4", "git": "2.53.0", "docker": null },
  "isolation": { "mode": "bwrap", "available": true, "verified": true, "reason": null },
  "limits": { "maxConcurrent": 2, "maxProfile": "shell", "allowNoSandbox": false }
}
```

- A missing tool is `null`.
- `ai.codex.authMethod` is `chatgpt` or `api-key` when Codex says which (never the account).
- `limits.allowNoSandbox` is the server admin's local switch that lets Pulse run a job outside the sandbox (§4, `access`).
- This is the complete field list. The runner never sends secrets, emails, account IDs, paths or file listings.
- Pulse shows "Claude connected" when `ai.claude.loggedIn` is `true`.
- **`isolation.verified: false` means the server will reject every job with `isolation_unavailable`.** Pulse should show that to the admin along with `reason`.

## 4. Getting work

### `POST /runner/v1/poll`

A long poll, and the only way work reaches the runner. Runners call it again as soon as it returns, including when they are full (`slots: 0`), because this is also how cancellations are delivered.

Request:

```json
{ "waitSec": 25, "slots": 1, "runningJobs": ["job_123"] }
```

Pulse should hold the request for up to `waitSec` seconds, and answer as soon as there is something to deliver. The runner gives up after `waitSec + 15` seconds.

```json
{
  "jobs": [ /* Job objects, at most `slots` of them */ ],
  "cancel": ["job_123"],
  "logins": [ /* optional: login messages, §10 */ ]
}
```

`jobs` and `cancel` are required (they may be empty). `logins` is optional; a runner that does not know it ignores it. `jobs` must not hold more than `slots` entries. Extras are rejected with `capacity`, and Pulse should requeue them.

`runningJobs` lets Pulse reconcile: a job that Pulse considers running on this runner, but which has been missing from `runningJobs` for over 60 seconds with no result, has been lost. Pulse should mark it failed with `runner_lost`.

### `POST /runner/v1/jobs/{id}/ack`

Sent immediately when a job is received, with body `{}`. Response `{ "ok": true }`.

Pulse should redeliver a job that is not acked within 60 seconds. Once acked, **Pulse must not redeliver it automatically**, because jobs are not idempotent. The runner also ignores ids it has already seen in this process.

### Job object

```json
{
  "id": "job_123",
  "orgId": "org_willowlane",
  "kind": "claude",
  "prompt": "Draft the quotation follow-ups for today.",
  "profile": "read-only",
  "approval": null,
  "model": "claude-sonnet-5-5",
  "limits": { "timeLimitSec": 600, "costCapUsd": 2.5 },
  "outputs": [ { "path": "out/report.md", "required": true } ],
  "mcp": {
    "url": "https://mcp.vitalsos.ai/mcp",
    "token": "pmt_short-lived-org-scoped-token",
    "expiresAt": "2026-11-05T10:30:00Z"
  },
  "requestedBy": { "type": "ai-employee", "id": "emp_bhrata", "name": "Bhrata" },
  "access": { "level": "read-only", "sandbox": true },
  "dryRun": false
}
```

| Field | Rules |
|---|---|
| `id` | Required. `^[A-Za-z0-9_-]{1,64}$`. |
| `orgId` | Required. Must match the org this runner was paired with. |
| `kind` | Required. `claude`, `codex` or `shell-safe`. |
| `prompt` | Required for `claude` and `codex`. Up to 1 MiB. Passed on stdin, so it never appears in process listings. |
| `command` | Required for `shell-safe`, and not allowed otherwise. An argv array such as `["df", "-h"]`. No shell is involved. |
| `profile` | `read-only` (the default if omitted), `write` or `shell`. |
| `approval` | Required for `write` and `shell`: `{ "approvedBy": { "id": "usr_1", "name": "Akabod Soniba" }, "approvedAt": "..." }`. |
| `model` | Optional. `^[A-Za-z0-9._:\-\[\]]{1,100}$`. |
| `limits.timeLimitSec` | Required. Positive, and no higher than the runner's `maxTimeLimitSec` (default 4 hours). |
| `limits.costCapUsd` | Required for `claude` and `codex`. Positive. |
| `outputs` | Optional, up to 20. `path` is relative to the job's workdir with no `..`. Default `required` is `false`. |
| `mcp` | Required for `claude` and `codex`. `url` must equal the runner's configured MCP URL. `expiresAt` must be in the future. Mint a new token for each job, scoped to the org and lasting no longer than the time limit plus a small margin. |
| `requestedBy` | Required. `type` and `id` are required. Echoed in the result for audit. |
| `dryRun` | Optional. If `true`, the runner validates and plans but executes nothing. |
| `access` | Optional. The server's access level set by an admin in Pulse (`read-only`, `read-write` or `full`) and whether Pulse wants the sandbox (`sandbox`, default `true`). Pulse never sends a profile above the level (`read-only` → `read-only`, `read-write` → `write`, `full` → `shell`). `sandbox: false` runs the job outside the sandbox **only if** the runner's local `allowNoSandbox` is also `true`; otherwise it changes nothing. Any other shape is ignored. |

### Profiles

Pulse sends only the profile **name**. The runner owns what each name means, and Pulse cannot send a custom tool list.

| Profile | Claude Code tools | Codex sandbox | Needs `approval` |
|---|---|---|---|
| `read-only` | `Read, Glob, Grep`, Pulse MCP | `read-only` (read-only shell is possible) | No |
| `write` | + `Edit, Write, NotebookEdit` | `workspace-write` | Yes |
| `shell` | + `Bash` | `workspace-write` | Yes |

A server admin can lower the ceiling with `maxProfile` in the runner's local config. Jobs above it are rejected with `profile_not_allowed`.

**The approval decision belongs to Pulse.** The runner only checks that an approval record is present, and cannot verify it cryptographically in v1.

### `shell-safe` commands

Only `echo`, `uname`, `uptime`, `df`, `free`, `nproc` and `sleep` are allowed, resolved from `/usr/bin` or `/bin`. Anything else is rejected with `command_not_allowed`.

## 5. Events

### `POST /runner/v1/jobs/{id}/events`

Batched, about 4 per second at most while events are flowing, with up to 100 events per batch.

```json
{
  "events": [
    { "seq": 1, "ts": "2026-11-05T10:00:00.100Z", "type": "status", "data": { "state": "running" } },
    { "seq": 2, "ts": "2026-11-05T10:00:01.000Z", "type": "agent", "data": { "type": "assistant", "message": {} } }
  ]
}
```

Response: `{ "ok": true, "cancel": false }`. `"cancel": true` also cancels the job.

`seq` starts at 1 for each job and increases by 1. Batches can be retried, so Pulse **must deduplicate on `(jobId, seq)`**.

| `type` | `data` |
|---|---|
| `status` | `{ "state": "accepted" \| "running" \| "stopping" \| "uploading", "reason"?: string }` |
| `agent` | One raw line of CLI JSON output (Claude `stream-json`, Codex `--json`), with secrets redacted |
| `log` | `{ "stream": "stdout" \| "stderr", "line": string, "truncated"?: true }` |
| `usage` | `{ "costUsd": number \| null, "inputTokens": number \| null, "outputTokens": number \| null, "cacheReadTokens": number \| null, "cacheWriteTokens": number \| null, "numTurns": number \| null, "source": "claude" \| "codex" }` |
| `limits` | Raw rate-limit information, where the CLI reports it |
| `warning` | `{ "code": string, "message": string }`, for example `cost_cap_not_enforced`, `log_limit_reached`, `events_dropped` |
| `dry_run` | `{ "kind", "profile", "command": string[], "promptBytes": number, "binaryFound": boolean, "isolation": string, "outputs": string[], "workdir": "<job workdir>" }` |

Prompts and tokens are never included in a `dry_run` plan.

The runner keeps at most 5,000 unsent events in memory, and 50 MiB of log per job. Past either limit it drops log lines and sends a `warning`.

## 6. Output files

### `PUT /runner/v1/jobs/{id}/outputs?path={urlencoded relative path}`

Raw bytes with `Content-Type: application/octet-stream` and `X-Content-SHA256: <hex>`. Pulse should verify the hash. Default limit: 100 MiB per file.

Response `201`: `{ "outputId": "out_1" }`.

Outputs are uploaded after the job ends, unless it was stopped (cancelled, timed out, over its cost cap, or interrupted). The runner uploads only declared paths, and only regular files with a single link inside the workdir. Symlinks, hard links, FIFOs and path traversal are refused.

## 7. Result

### `POST /runner/v1/jobs/{id}/result`

Sent exactly once per job as the last call, retried on failure. Must be idempotent on the Pulse side. Response: `{ "ok": true }`.

```json
{
  "status": "succeeded",
  "dryRun": false,
  "exitCode": 0,
  "signal": null,
  "error": null,
  "startedAt": "2026-11-05T10:00:00Z",
  "finishedAt": "2026-11-05T10:03:00Z",
  "durationMs": 180000,
  "usage": { "costUsd": 0.42, "inputTokens": 1200, "outputTokens": 800, "cacheReadTokens": 0, "cacheWriteTokens": 0, "numTurns": 3, "source": "claude" },
  "outputs": [ { "path": "out/report.md", "bytes": 1024, "sha256": "ab12", "outputId": "out_1" } ],
  "audit": {
    "requestedBy": { "type": "ai-employee", "id": "emp_bhrata", "name": "Bhrata" },
    "kind": "claude",
    "profile": "read-only",
    "approval": null,
    "isolation": "bwrap",
    "promptSha256": "cd34"
  }
}
```

`status` is one of `succeeded`, `failed`, `timed_out`, `cancelled` or `rejected`. `error` is `null` or `{ "code": string, "message": string }`.

| `error.code` | Meaning |
|---|---|
| `invalid_job` | The job failed validation (see `message`) |
| `org_mismatch` | `orgId` is not this runner's org |
| `profile_not_allowed` | The profile is above the local `maxProfile` |
| `approval_required` | `write` or `shell` with no `approval` |
| `command_not_allowed` | `shell-safe` command not on the allow-list |
| `mcp_invalid` | MCP block missing or expired, or the URL is not the configured one |
| `isolation_unavailable` | The sandbox is missing or failed its self-test |
| `binary_not_found` | The CLI is not installed |
| `capacity` | No free slot (Pulse should requeue) |
| `time_limit_exceeded` | The time limit was reached |
| `cost_cap_exceeded` | The cost cap was reached |
| `cancelled` | Cancelled by Pulse |
| `runner_shutdown` | The runner was stopped mid-job |
| `agent_error` | The CLI reported an error |
| `nonzero_exit` | The process exited non-zero |
| `output_missing` | A required output is missing or was refused |
| `output_upload_failed` | A declared output could not be uploaded |
| `internal_error` | A runner bug or local failure |

### Audit

Pulse records "who, what, when, result" for every job from the dispatch record and this `result` (`audit.requestedBy`, `audit.approval`, `kind`, `profile`, `startedAt`, `finishedAt`, `status`). Rejected jobs get a result too, so they are audited as well.

## 8. MCP

For `claude` and `codex` jobs, the runner configures one MCP server, named `pulse`, from `job.mcp`, sending `Authorization: Bearer <token>`. All other MCP servers are excluded for Claude (`--strict-mcp-config`).

The Pulse MCP server must treat this token as the only source of org identity, and reject it after `expiresAt`.

## 9. Sequence

```
admin → Pulse: Connect a server            → code ABCD-1234
runner → POST /pair                        ← credential
runner → POST /capabilities, /heartbeat
runner → POST /poll (held)                 ← { jobs: [job], cancel: [] }
runner → POST /jobs/job/ack
runner → POST /jobs/job/events ...         ← { cancel: false }
runner → PUT  /jobs/job/outputs?path=...
runner → POST /jobs/job/result
admin → Pulse: Revoke
runner → any call                          ← 401 runner_revoked  → kills jobs, deletes credential, exit 78
```

## 10. Subscription logins ("Connect Claude", "Connect Codex")

An admin connects the server's own Claude Code or Codex sign-in from Pulse. The runner runs that CLI's **own** login flow on the server (`claude auth login --claudeai`, `codex login --device-auth`), as the runner's user and with the runner's login folders. The person finishes it in their own browser with their own subscription. **The token the CLI writes stays on the server**: the runner never reads it and never sends it, and Pulse never stores or sees it.

### Login messages (in the poll answer)

```json
{ "logins": [
  { "id": "lgn_0123456789abcdef0123456789abcdef", "tool": "claude", "action": "start" },
  { "id": "lgn_…", "action": "code", "code": "one-time-authorisation-code#state" },
  { "id": "lgn_…", "action": "cancel" },
  { "id": "lgn_…", "tool": "codex", "action": "logout" }
] }
```

| `action` | Runner |
|---|---|
| `start` | Starts the CLI's login. Reports `starting`, then `waiting` with the link (and the device code, if the CLI printed one) once the CLI prints them. A second `start` for the same tool ends the first. Ends by itself after 15 minutes (`login_timeout`). |
| `code` | Claude Code's flow ends on a page that shows a one-time authorisation code; the person pastes it in Pulse and Pulse relays it once. The runner writes it to the CLI's stdin and reports `verifying`. That code is useless without the PKCE verifier only the CLI on this server holds. Pulse deletes it when it is delivered. |
| `cancel` | Stops the CLI's login and reports `cancelled`. |
| `logout` | Runs the CLI's own logout (`claude auth logout`, `codex logout`) and reports `succeeded` or `failed`. |

`id` is `^lgn_[0-9a-f]{32}$`; anything else is ignored. `tool` is `claude` or `codex` (others fail with `unknown_tool`).

### `POST /runner/v1/logins/{id}`

```json
{ "state": "waiting", "url": "https://claude.com/cai/oauth/authorize?…", "userCode": null, "needsCode": true }
```

| Field | Rules |
|---|---|
| `state` | `starting`, `waiting`, `verifying`, `succeeded`, `failed` or `cancelled` |
| `url` | Only with `waiting`: the `https://` sign-in link the CLI printed (terminal escape codes removed), up to 2048 characters |
| `userCode` | Only with `waiting`: a device code such as `ABCD-12345`, or `null` |
| `needsCode` | `true` when the CLI waits for a pasted code (Claude Code) |
| `error` | `{ "code", "message" }` with `failed` (`login_failed`, `login_timeout`, `binary_not_found`, `unknown_tool`, `login_not_running`, `logout_failed`) or `invalid_code` with `waiting` |

Response `{ "ok": true }`; `404`/`409 login_not_active` when Pulse no longer wants it. After `succeeded` (a login or a logout) the runner sends a new capability report at once, so Pulse shows the plan (`ai.claude.subscriptionType`) and status. Pulse shows "needs a new login" when a CLI that was signed in reports `loggedIn: false`.
