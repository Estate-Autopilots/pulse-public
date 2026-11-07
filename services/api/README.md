# services/api · Product API (Fastify)

MCP adapter `pulse-mcp/1`: Streamable HTTP at your install's `/api/v1/mcp`, using the maintained TypeScript SDK
and the same v1 executor/principal/transaction, audit, budget and 24h write replay as HTTP. Configure a remote MCP
client with `https://<your-install-host>/api/v1/mcp` and a bearer read from a private placeholder file such as
`/path/to/your/pulse-token`; send no cookies, session or Access identity. Initialize with protocol `2025-11-25`,
then send the negotiated `MCP-Protocol-Version` and `Accept: application/json, text/event-stream` on POSTs.
SDK 1.32.2 negotiates the version. This endpoint is stateless: no session id; omit `Mcp-Session-Id`; GET/DELETE return 405.
Send one JSON-RPC message per POST; batches are refused before dispatch. Disconnects do not cancel committed work; retry with the same write key.
Tool names are registry operation ids; arguments are `{params?, query?, body?, idempotencyKey?}` using the HTTP
schemas. Supply one UUID `idempotencyKey` for each write and reuse it on retries (an HTTP Idempotency-Key also works).
Results carry the HTTP value in `structuredContent`, request/status in `_meta`; refusals set `isError` with the same
problem object. Discovery is scope-filtered and hides staff-only writes from app/AI principals. Resource membership
is checked on every call/replay. Only registered operations are exposed; legacy service
routes and OAuth sign-in are outside this adapter. Personal tokens work when their production resolver is installed.
Verify via `tests/core/test_api_v1_work.py` (synthetic tenants; includes the real SDK client and HTTP/MCP replay).

Connected apps and people operations (EST-2811, migration 1412): "Sign in with Pulse" for Claude, ChatGPT and the CLI
(`src/oauth.ts`: RFC 7591 registration, PKCE S256, rotating refresh tokens, RFC 7009 revocation; tokens stored as
SHA-256) and a `pat_` access token that acts as its person in API v1 (`pulse.v1_person_principal`). People/admin
operations in `src/v1-people.ts` reuse the screens' database functions and roles: whoAmI, searchPeople, getPerson,
listOnboarding, correctPersonField (HR correction with reason; `pulse.hr_profile_correct`), issueOneTimePassword,
sendSignInEmail, createChatGroup, changeChatGroupMembers, listBugReports, setBugReportStatus, listMyChanges,
undoChange (7 days; `pulse_priv.app_change`), search and fetch. Named MCP tools take flat arguments plus `requestId`.
The web app serves `/mcp`, `/oauth/mcp/*` (beside PULSE-ID's OpenID `/oauth/*`), `/.well-known/oauth-*`, `/privacy` and `/terms`. Setup and directory packet:
[docs/connectors/pulse-mcp.md](../../docs/connectors/pulse-mcp.md). Verify `tests/core/test_api_v1_people.py`.

EST-2284 adds persisted staff visit create/list/detail and bounded note saves (migration 0763; [staff slice OpenAPI](openapi/site-visits-staff.yaml)).
FLOW-A adds Flow, one engine for any company's work (migrations 0800–0801): processes, runs that follow "data, not permission", module backends as typed records, Pip per step; the browser's `/api/v1/flow/…` ([OpenAPI](openapi/flow.yaml), [module contract](src/flow/README.md), shapes in `src/flow/types.ts`).
Reads return persisted rows with immutable `starting_fields`, field notes and permission-filtered history. Customer identity comes only from the create path; sign-in and HR denial precede validation. Open assignees edit notes; admin/leadership edit at any time with atomic history. Leadership choosing another assignee at create remains for EST-1409.
Prefill contains customer name/phone, relationship salesperson and latest issued quote identity; site address (EST-1449) and hand-over capacity (EST-1401) stay null until their source records exist. Photos, submit, frozen Visit projection and SDK remain separate slices. Verify with `test_site_visit_notes.py` and the access matrix.

Company admins manage connected-app keys at `GET|POST /api/v0/integrations/keys` and `POST /api/v0/integrations/keys/:id/revoke`.
Creation accepts `{name,scopes,days,agentId?}` and reveals `{key,token}` once; lists expose metadata only. Other companies receive 403 until connected-app authentication supports them. Migration 0700
keeps operator keys unexpired, checks expiry on service/v1 authentication and audits issuance/revocation without secrets.
Focused real-DB coverage: `tests/core/test_integration_keys.py` drives `test/integration-keys-runner.mjs`.

Hosted Google sign-in selects the request company's private OAuth client (`google-client.ts`) and claimed origin.
Operator installation/rotation: `docs/ops/CONNECTORS.md#google-sign-in-client`; focused coverage:
`test/google-client.test.mjs` and `tests/core/test_google_sign_in.py` (synthetic companies and provider only).

Post-only AI chat setup (install operator, migration 0565): run `node dist/agent-admin.js chat --name "Pulse Updates" --username pulse-updates --chat "Studio updates" --members member@studio.example,lead@studio.example`.
Use `PULSE_OPERATOR_URL` (loopback only) and `PULSE_OPERATOR_TOKEN_FILE`; stdout contains only `agentId chatId`.
`POST /api/v1/operator/agent-chat` takes `{name, username, chat, members: string[]}` inside the existing operator authentication boundary.
It uses the install company, audits as `operator`, resolves individual active staff Workspace accounts, and makes the first member group owner/admin.
Reruns reuse the username and original group-name tuple, retaining existing membership; a callable, disabled or human username is refused.
The AI member has no staff sign-in, role, HR record or runner key, and replies/mentions never queue a run. Normal co-workers remain callable.

Private lead photos: `GET/POST /api/v0/acquisition/leads/:lead/photos`, authenticated read at `/:media`.
The [contract](openapi/lead-media.yaml) and `LEAD_PHOTO_PATHS`/`LeadPhoto` in `@pulse/sdk-ts/v0` describe the UI boundary.
Migration 0550 uses current acquisition ownership/manager scope and the existing `PULSE_DOCUMENT_KEY_FILE` envelope encryption.
Photos are normalized to metadata-free WebP; source/takenAt are unverified claims. Verify with `tests/core/test_lead_media.py`.

AI employee DB contract (migration 0660): creation requires a title (1–120 characters), active staff `ownerId` in the company,
and `lane: quick | thinking`. IDs are permanent `<company-code>-AI-001` values; switching off retires an employee without
reusing its number. `agent_profile` exposes only employee details to leaders or shared-chat members; `agent_count` counts
active, switched-on AI employees. Model means runtime metadata, not evaluated performance. API/UI projections follow separately.

AI employee API (EST-1733): `POST /api/v0/agents` (admins only, `{name,title,ownerId,lane}`, optional `username`, else
`first.last`+n under the staff-identity lock) returns `{id,employeeId}` and never a key. `GET /api/v0/agents/:id` is the
profile, 404 wherever the viewer can't already see the employee. `GET /api/v0/agents/team` (leaders and admins) lists
`{id,employeeId,name,title,ownerName,lane,status,budgetLeft}`. Chat authors, members and everyone carry `employeeId`
(null for people), and the audit names an AI actor `<name> · <ID>` (`actorEmployeeId`). The model shows only on the profile.

The public REST API `/v1` (OpenAPI 3.1, generated from Zod schemas): auth (OIDC Google sign-in first), sets
`pulse.org_id` / `pulse.viewer_id` per transaction for row-level security, applies the visibility filter, writes the
access log, sends outbound webhooks. It reads projections and writes only declared events (corrections,
confirmations); domain rules stay in the Python workers. This is `apps/api/` in spec 05 §4.1.

- **Lane:** `platform` (Platform Engineer).
- **Spec:** 05 §4 (`api`), 05 §7 (multi-tenancy), 05 §8.1–8.2 (API style and v1 surface), 05 §9 (privacy as code),
  06 §5 (visibility floor), ADR-0004, ADR-0005, ADR-0015.
- **Roadmap:** 07 §3 week 2 (`POST /v1/tasks`, `/v1/assets` for the Assign screen), week 4 (People, Coach, Projects,
  Privacy endpoints).

Service client/lead reads live in `service-reads.ts` and migration `0505_service_reads.sql`; the scoped-key contract
is `openapi/service.yaml`. Run `tests/core/test_service_reads.py` against a throwaway PostgreSQL database after
building this package; its Fastify runner checks exact projections, pagination, scope and acquisition switches.

EST-1406/1879: migration 0685, `service.yaml` 1.2.0 (EST-1392 1.0.2). Calendar-day buckets; due-soon excludes in-review; disabled AI members stop both reads. Google person-token verifier v1 uses discovery/JWKS, RS256, a 60-second leeway and the authenticated tenant's allowed domains. Configure `PULSE_SERVICE_PERSON_TOKEN_AUDIENCES` as comma-separated client IDs; unset/empty refuses all tokens. Run `tests/core/test_service_tasks_people.py` after building (synthetic RSA/JWKS, 401/403/200 and issuer normalization). No token or claims are logged; only linked, active staff can read their own tasks.

## Synthetic My Tasks acceptance contract

EST-1016's `synthetic-my-tasks.ts` is a standalone acceptance harness, never registered by the install API.
`GET /synthetic/my-tasks` accepts only an out-of-band random bearer credential (server stores SHA-256) and no
query selectors. A server-owned directory maps its single synthetic principal to active org-local people.
Each org uses a read-only `pulse_api` transaction, active-person recheck and existing task RLS; revocation is
rechecked across async waits. Only organization, title, status and dueAt leave the harness. It refuses databases
outside `pulse_ci` / `pulse_ci_*`. There is no production route, account linking, shared task store or deployment.
Contract: `openapi/synthetic-my-tasks.yaml`; TypeScript projection: `@pulse/sdk-ts/synthetic-my-tasks`.
Verify with API build plus `tests/core/test_synthetic_my_tasks.py` on scratch PostgreSQL through `ea-heavy`.

## Synthetic federated My Tasks (EST-2087)

`synthetic-federation.ts` holds one acceptance harness per install (`createSyntheticInstall`, never registered by
createApp or server.ts) and a hub (`readFederatedMyTasks`). Each install alone owns its tasks and a server-side registry
of private, revocable links to org-local people. `POST /synthetic/federation/context` swaps a link credential for an
HMAC context of at most 300 s (install key, no DB); `GET /synthetic/federation/tasks` rechecks context and link on every
read, then runs EST-1016's guarded read-only `readOrgTasks`. The hub takes only `TaskSource[]` (no pool, cache or store),
mints a fresh context per read, keeps only exact four-field rows and marks each source `ok`, `denied` or `unavailable`.
CI's two installs share one scratch cluster: per-install keys, link registries and RLS keep them apart. Live EA/AC
linking waits for EST-1003. Contract `openapi/synthetic-federation.yaml`; proof `tests/core/test_federated_my_tasks.py`.

## Update request register (0720)

`update-requests.ts` adds participant-only replies/reads and the `updates.requests.manage` service register (OpenAPI and `SERVICE-KEYS.md`). Requests are live status rows, visible from the next update onward; completed rows age out after 24 hours. No admin bypass or delete. Limits: 50 rows per update, 100 per service page; ref replay preserves an omitted creation time. Build the API, then run `tests/core/test_update_requests.py` on an isolated scratch database for API/proxy and forced-RLS acceptance.

## Editors read model

- `GET /api/v0/editors` lists every uploader account for admins and only the signed-in person's account for people.
- `GET /api/v0/editors/:account` returns delivery details; people can request only their own account, while admins may request any account.
- The `attribution` object summarizes the last 30 days. `credited_to_person` and `shared_login` are counts; their `*_share` values are fractions of `total_deliveries`, including unresolved deliveries in the denominator.
- Delivery detail rows include `credited_to` (an opaque person ID, `shared login`, or `unresolved`) and `how`. For person credit, `how` comes from the last decisive evidence item. API tests use synthetic accounts and people only.

## Editor weekly report

- `GET /v1/editors/{person}/week?week=YYYY-Www` returns delivery counts and weekly targets for the EST-207 types: `model_video`, `vov`, `founder_video`, `testimonial`, `walkthrough`, and `other`. It classifies indexed files using the active tenant `folder_rules.creative_type_rules` document. Editors can read their own week; admins can read any editor week, including Access admins without a linked person record. Those admin reads keep the subject, resource, grain, and purpose in `privacy.access_log` with a null `viewer_id`. File names and person details are never returned.
- An editor's own weekly report also includes `openTasks`, assigned to the authenticated viewer and excluding `done` and `cancelled` tasks. Each task has its ID, title, status, due date, and linked assets (`id` plus a Google Drive viewer URL for the latest non-trashed file, or `null` when no safe link exists). Admin cross-editor reports keep their existing behavior and omit `openTasks`; task assignee identity fields are never returned.
- Targets are stored in the active `pulse.tenant_config` document with `doc_kind: targets` and `doc_key: editors`. The body uses `editors.<type>.per_week` and `editors.<type>.placeholder`; optional overrides use `person_overrides.<person-uuid>.<type>`. A `null` target means a benchmark has not been set; such types return `gap: null`.
- Every target remains explicitly marked `placeholder: true` until the benchmark session replaces it. The EA seed sets model video/VOV/founder/testimonial/walkthrough to 4/3/1/1/1 per week; `other` remains unset until benchmarking.
- Confirmed claims from shared accounts count in `delivered` and reduce the target `gap`; a separate `claimed` draft/final count keeps claim credit distinct from individual-account credit.
- Managers may read weekly counts for their reports. Only each editor's own report includes `openTasks`.
- The response contract is [OpenAPI](openapi/editors-week.yaml); the TypeScript path and response types are in `@pulse/sdk-ts/v1`.

## Shared-login delivery claims

- `GET /v1/deliveries/claimable?week=YYYY-Www` lists shared-login delivery metadata in the signed-in editor's work projects.
- `POST /v1/deliveries/{id}/claim` creates a pending claim for the authenticated person. The delivery file identifier is opaque and is never resolved to the shared account holder.
- `GET /v1/deliveries/claims?week=YYYY-Www&status=pending` is limited to admins and managers; RLS permits a manager to see reports' claims and people to see their own.
- `POST /v1/deliveries/{id}/claim/decide` lets an admin or the editor's manager confirm or reject a pending claim. Self-decisions are denied. Decisions are written to the audit log; confirmed claims carry `credited_via=claim` separately from account attribution.
- Contracts: [OpenAPI](openapi/delivery-claims.yaml), [editor week](openapi/editors-week.yaml). TypeScript paths and types are in `@pulse/sdk-ts/v1`.
- Shared-login design export claims: [OpenAPI](openapi/design-claims.yaml); API routes in `design-claims.ts` and TypeScript paths and types in `@pulse/sdk-ts/v1`.

## Uploader account claims

- GET /v1/accounts/claimable lists unlinked, non-shared Google uploader accounts with deliveries in the signed-in staff member's work projects. Known client domains and client identity evidence are excluded; reads are access-logged.
- GET /v1/accounts/claims shows the signed-in person's claims; admins and HR can review all claims, and managers can review their reports. POST /v1/accounts/{id}/claim creates a pending self-claim; POST /v1/accounts/{id}/claim/decide lets an admin, HR, or the claimant's manager confirm or reject it.
- Confirmation sets the account holder and a reversible account_claim identity_link. If a conflicting person link appears while a claim is pending, authorized reviewers can reject it while confirmation remains blocked; rejection leaves both links and holder state untouched and frees the account claim slot. POST /v1/accounts/{id}/claim/revert removes a confirmed claim link; reads and decisions are access-logged and audited.
- Contract: [OpenAPI](openapi/account-claims.yaml). TypeScript paths and types are in @pulse/sdk-ts/v1.

## Employee-owned HR record

- `GET /api/v0/me/hr` returns the authenticated person's own HR record, allowlisted field history, safe document slots, and the latest 30 HR access receipts. It takes no person identifier; the database derives the subject from the signed-in viewer.
- The response includes name, employment status, role, department, employment type, start date, changes to those four HR fields, and document availability metadata for appointment, joining, offer, and relieving letters. It never returns document filenames, Drive IDs, or links.
- Salary, finance, personal-contact, KYC, government-ID, passport, identity-document, and bank fields are excluded. The `additionalProperties: false` response schema enforces the same allowlist.
- The database writes a subject-specific `privacy.access_log` receipt for each section read; the API also writes its restricted-read audit event. Attempting the existing ID-scoped HR route as a regular employee remains denied for any other person.
- Contract: [OpenAPI](openapi/hr-self.yaml); TypeScript path and response: `API_V0_PATHS.myHr` and `MyHrResponse` in `@pulse/sdk-ts/v0`.

## Design delivery totals

- `GET /api/v0/design-deliveries/summary` returns counts for the five design types plus `other` over the last 30 days, with `unmatched_count` equal to `types.other`, and aggregate credit-status and evidence-method counts. It returns no file or person details and logs the aggregate attribution read. Admins see organisation totals; managers see only their work projects. Individual and HR-only accounts are denied. Image, PDF, PSD and AI exports are classified from recent `index_file` rows using the active tenant `folder_rules.design_type_rules` document; only a known staff account or an internal shared account with a known last modifier is counted. Video deliveries are excluded from design and attribution counts.

## Designers

- GET /api/v0/designers?week=YYYY-Www returns weekly per-type counts plus single-image expected, delivered, and gap values for configured designer roles. Only roles listed in `designers.roles` appear and receive the `designers.single_image.per_day` target; shared-login work appears separately with null expectation fields. Weekly expectation multiplies the per-day target by tenant workdays from `pulse.hr_policy.work_days` (default Monday–Saturday), excluding non-optional holidays. The current week counts only dates through today. Admins and leadership see the organisation; managers see managed designers and their own row; staff see only their own row. The response contains no file details or rankings and logs grain week.
- GET /api/v0/designers/{person}?week=YYYY-Www returns seven days of per-type counts plus daily single-image progress and a weekly total for the signed-in person's own week. Non-workdays, non-optional holidays, and future dates in the current week have expected and gap zero. Managers can read their own daily detail but never a report's. The response contains no file details and logs grain day.
- GET /api/v0/designers/brand-projects/open returns active brand asset tasks grouped by project, assignee, and asset type with days open against the tenant window. Days open uses the earliest task assignment or planned phase start; rows without either date report null. Project names and task titles are omitted, and reads are logged by subject at project grain.
- Targets use the active tenant `targets` document with `doc_key: designers`: `designers.roles` matches `people_profile.role` case-insensitively, `designers.single_image.per_day` sets the daily benchmark, and `windows.<brand_asset>.days.{min,max}` sets brand completion windows. EA's numeric seed values are placeholders (`placeholder: true`) pending CEO-approved benchmarks. Contract: [OpenAPI](openapi/designers.yaml); TypeScript paths and response types are in @pulse/sdk-ts/v0.

## Operator API (first run)

- `operator.ts`, only when `PULSE_OPERATOR_TOKEN` is set (at least 32 characters; otherwise the routes do not exist and answer 404). Callers send `Authorization: Bearer <token>`, which is compared in constant time; anything else gets 401. A request that carries the web tier's headers gets 404, and the web proxies never forward `/api/v1/operator/*`.
- `GET /api/v1/operator/status`, `POST /api/v1/operator/init` (one transaction in `pulse.install_init`: company, install marker, first admin with the `admin` role and a temporary password; 409 once initialised), `POST /api/v1/operator/org` (rename) and `GET`/`POST /api/v1/operator/roles` (break-glass `admin`, `hr`, `leadership` and `privacy`: the same `pulse.role_assignment` rows as Settings → Roles, in `pulse.operator_role_set`; revoking the last admin answers 409). Roles come only from the database. These routes answer before the install has a company. Every call is audited as actor `operator`. Contract: [OpenAPI](openapi/operator.yaml). The client is `pulse-admin` in `packages/sdk-py`.

## Drive project onboarding sort

- `GET /api/v0/admin/onboarding/receipt` returns the organisation's latest non-dry-run sort timestamp and counts only: `folders`, `matchedExisting`, `proposals`, and an optional `skippedReason`. It is admin-only and tenant-scoped.
- To check real indexed data without creating review proposals or projects, an organisation admin can `POST /api/v0/admin/onboarding/run` with `{"step":"sort","dryRun":true}`. The response reports the same sort counts; dry runs do not replace the saved receipt.

## Account recovery

Account recovery (`auth/forgot`, `auth/forgot-username`, and portal equivalents) checks shared configured mail
availability before account lookup or token writes. Disabled mail returns account-neutral `503 MAIL_UNAVAILABLE`;
configured mail keeps a conditional response even if delivery fails. Resets preserve fresh admin invites until
successful password setting consumes outstanding password links. Contract: [OpenAPI](openapi/auth-recovery.yaml);
TypeScript paths and response types: `@pulse/sdk-ts/v0`. Tests use synthetic accounts and the mail sink only.
Admin reset, invitation and private-copy actions still revoke older password links. When mail is unavailable,
the preflight also skips HR/support reset-request queue writes; the person must ask their admin directly.

## Definition of done

The install-local `catalog.read` API and independent customer offer links are documented in [CATALOG.md](CATALOG.md).

The shared checklist in [CONTRIBUTING.md](../../CONTRIBUTING.md#definition-of-done), plus:

- the OpenAPI document (`openapi/`) is the contract and is regenerated in the same change; `packages/sdk-ts` follows;
- every endpoint has a cross-tenant test (a second synthetic tenant sees nothing) and a visibility test;
- every read of personal data is written to the access log.

## Conventions

TypeScript package in the pnpm workspace (`lint`, `typecheck`, `test` scripts). Container on the `ea-deploy`
contract: port 8080, `GET /healthz` (see `infra/`).

## Local run

From the repository root, run `pnpm --filter @pulse/api test` for the injected health and database-config tests.
Start the API with `PULSE_DATABASE_URL_API=postgresql://... pnpm --filter @pulse/api start`, or use
`DATABASE_URL=postgresql://...` for a shared login; the API sets its session role to `pulse_api`. It listens on port
8081 by default. `GET /healthz`
runs `SELECT 1` and returns 503 with `part: "database"` when PostgreSQL is unavailable. The public port 8080
placeholder, `/api/*` API proxy, and `/v1/*` ingest proxy are started by `infra/` in the combined image.

## Service quotation drafts

`service-quotes.ts` implements `POST /api/v1/service/quotes` from `openapi/service.yaml`. Migration 0506 keeps catalogue snapshots, idempotency and the leadership approval gate inside SQL; draft figures reuse `erp-model.ts`. Verify with `tests/core/test_service_quotes.py` (real PostgreSQL plus Fastify, synthetic fixtures only).

`service-notice.ts` implements the no-body ready-notice POST from that contract and the staff-only
`GET /api/v0/quotes/:id` ([response](openapi/salesperson-quote.yaml), SDK `SalespersonQuote`). Migration 0509
serializes notices per document, preserves notification preferences and exposes only a read-only quotation.
Unnamed leads use their receipt date; neither route decrypts contacts. Verify with `tests/core/test_service_notice.py`.

## Install events (quotation status)

`openapi/service-events.yaml` 1.0.0 is the envelope an install publishes: `quote.sent`, `quote.accepted` and `quote.converted` (EST-1392 contract §5). Migration 0760 captures them in the transition's own transaction (a trigger on the quotation's status, install company only), numbers committed events install-wide and gaplessly in the workers' minute tick (`install_event_publish`), and hands due work to the sender through `install_event_due` / `install_event_attempt` (worker role only; no URL or secret in rows). Verify with `tests/core/test_install_events.py` (real PostgreSQL, synthetic fixtures only).


Install event delivery (EST-1260): the worker's existing minute tick runs `dist/install-event-delivery.js` with
`PULSE_DATABASE_URL_WORKER`; no service key, destination environment variable or additional poller is used.
Migration 0761 stores one active `pulse_priv.webhook_endpoint` per org (URL, events, key id, separate >=32-byte secret);
only delivery/admin security-definer functions may read secrets. Settings → Integrations owns configuration/redrive.
The 0761 lease reserves at most ten attempts per tick, freezes the raw body and bounds crashes to five attempts.
Retries use 1m/5m/30m/2h; only 2xx completes. An expired fifth lease becomes dead-letter on the next minute tick.
Logs contain host, status, latency and fixed error class, never URL paths/queries, credentials, body or response text.
Receivers verify `v1=HMAC-SHA256(secret, timestamp + "." + rawBody)` using constant-time comparison, reject clocks
outside ±300s, keep event ids >=30 days, and ignore sequences <= the subject's highest sequence. Persist the id and
sequence atomically with the follow-up stop on accepted/converted, then acknowledge 2xx within 3s. A retry/redrive
keeps the same id/body; rotation accepts old/new key ids temporarily. Committed event types are `quote.*`.
`test/install-event-delivery.test.mjs` includes a fixed signature vector and synthetic receiver verification.

API v1 call safety (`v1-call-safety/1`, migration 0695): registry writes require a UUID `Idempotency-Key`.
Write operations must declare `authorize(ctx,input)` for resource permissions/current membership; it runs before every
replay. Tenant + actual token UUID + operation ID + canonical params/query/body bind a response for 24 hours. Advisory
locks and the existing `open` transaction commit the write and private response together; failures are retriable.
The private audit holds only IDs, route templates, status and timings, including rejected attempts (unknown identity
is null). Expired replies are never served; each successful fresh write removes at most 32 other expired tenant rows,
so idle tenants retain inaccessible expired receipts until traffic resumes. No cleanup poller. Audit persistence failures
log only the request ID; database outage cannot guarantee a persisted attempt. Synthetic check: `tests/core/test_api_v1_call_safety.py`.

API v1 bounded runtime (`v1-paging/1`, `v1-limits/1`): list operations declare `PAGE_QUERY`, `pageResponse(itemSchema)`
and call `pageV1` with a tenant/permission-filtered SQL seek (`id > after ORDER BY id LIMIT take`) on `ctx.client`.
IDs must be immutable UUIDs; take is at most 101, output at most 100. Never adapt an offset or preload a collection.
Encrypted cursors bind tenant, token, viewer, operation, path params and filters; process restarts invalidate them.
Authenticated registry calls spend independent 120/min windows before validation/replay; the 4096-entry process map
rejects admission when full without evicting live budgets. Invalid credentials retain the separate service failed-auth
window; legacy service limits are unchanged. RateLimit-Reset and Retry-After are seconds. Limits reset on restart,
are process-local (not a distributed quota), and pre-auth/unresolved refusals report the default window until identity
is known. No production list operation is registered yet; later area operations must adopt this helper and verify SQL
keyset/RLS behavior on staging. Focused synthetic checks: `test/v1-paging-limits.test.mjs`.
