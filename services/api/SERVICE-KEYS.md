# Install-local service keys (v1.1.0)

Contract: [service.yaml](openapi/service.yaml). Model: `0504_service_key.sql` + `0560_service_chat_post.sql`.
Keys authorize only their explicit scopes on the issuing install; they never authorize a staff session.
Use `withServiceKey(request, reply, scope, work)` for every service handler: authentication and work share
one transaction/client. Do not use staff viewer helpers. The authenticated actor is `service:<UUID>`.
No ERP table grants or staff policies change. Cookies and Access identities do not authorize service calls.

On **your own installation's server**, build/migrate and configure the existing operator secret through
`PULSE_OPERATOR_TOKEN_FILE` (or `PULSE_OPERATOR_TOKEN`). From `services/api`:

```sh
node dist/service-key-admin.js issue /your-install-secret-store/quote-agent.key --scopes catalog.read,clients.read,leads.read,quotes.draft.create,notify.quote_ready --label "Quote agent"
node dist/service-key-admin.js list
node dist/service-key-admin.js revoke <key-uuid>
```

Issue creates a new mode-0600 file using exclusive creation, sends only the SHA-256 digest to the loopback
operator API and prints only its UUID. List prints UUIDs only; the operator GET also returns labels, scopes
and timestamps, never hashes or secrets. Store the UUID for revocation. Never paste secrets into tickets,
git, logs, screenshots or browser JavaScript. A failed issue call retains the file for local investigation.
For rotation: issue a fresh file, switch the consuming server's secret reference, verify access, revoke the old UUID.
Consumers read the file at runtime and send `Authorization: Bearer <file contents>` to their own Pulse origin.
Never configure another company's URL, credential, browser session or proxy. Never follow redirects with a key.

Invalid/malformed/revoked keys return 401; missing scope, another company's host or other endpoints return 403,
even alongside a staff cookie. Unknown query fields return 400. Responses use no-store and no-referrer.
Budget: 120 authenticated service requests/minute/API process, service-key catalogue reads included;
429 returns Retry-After: 60. 1.1: failed authentication and pre-auth refusals spend a separate 120/minute bucket. The web proxy forwards only authorization/content-type/idempotency-key and its Host,
with a 10-second timeout, no redirects and a 64-KB body cap (3 MiB only for chat posting). No poller; the phone budget tracks only authenticated key IDs.
Logs contain only serviceKeyId/scope/result; last-used timestamps update at most once/minute, displayed at minute grain.
`quotes.draft.create`: `service-quotes.ts` + `0506_service_quote.sql` (EST-1248); the SQL re-checks the transaction's
authenticated key, never a digest from the handler. Known limit: the notice handler ships separately.
1.1 phone lookup: clients/leads accept `?phone=` alone (10 digits → +91), return at most 5 matches, audit key ID + match count and allow 30/minute/key; more than 64 lead aliases returns 503, never partial matches.
1.1 `sourceRef`: optional 1..100 characters on a draft, included in its request hash, stored with the draft and created history, echoed (null when absent), and excluded from PDF content.

`chats.post` (`0560_service_chat_post.sql`) binds a key to one active install-local AI member:

```sh
node dist/service-key-admin.js issue /your-install-secret-store/updates.key --scopes chats.post --agent <AI-member-uuid> --label "Updates agent"
```

POST `/api/v1/service/chats/<chat-uuid>/messages` with `Idempotency-Key: YYYY-MM-DD-am|pm` (a real date)
and `{text, image?: {name, mime, bytes}}`. Text is 1–12000 characters; image bytes are canonical base64,
PNG or JPEG only, matching magic bytes, at most 2 MiB decoded. The API/proxy body cap is 3 MiB only here.
The AI member must still belong to the chat, even for retries. The slot belongs to that AI member across
keys and chats: an identical retry returns 200 with `replayed:true`; another chat, text or image returns 409.
A new post returns 201. Both responses contain only `messageId`, `chatId`, `replayed`; the scope reads no
messages. The existing chat attachment validation and normal notification/outbox paths handle the post.
Operator key listings include `agentId` (null for keys without `chats.post`). Chat setup and post-only AI
member creation are handled by the separate operator agent command, never by this credential.

`updates.post`: POST `/api/v1/service/updates` with `{slot,headline,sections,audience,onBehalfOf}` (OpenAPI); key label is shown as `(AI)`, slot replays per sender, no AI member binding. Staff GET `/api/v1/updates?cursor&limit` lists audience/sender updates without receipts; POST `/api/v1/updates/:id/open` records the first audience opening, with minute-grain `openedBy` only for the sender. No admin bypass.

`updates.requests.manage` (0720): GET/POST `/api/v1/service/update-requests` and POST `/:id/progress`; install-local register management with ref replay, eight statuses, no delete. Staff replies and request reads are limited to asker/on-behalf participants, without an admin bypass.
