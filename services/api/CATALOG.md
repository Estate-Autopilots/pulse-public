# Install-local catalogue API

`GET /api/v1/catalog/items` uses `Authorization: Bearer <key read from this install's secret file>`.
No cookies, Access identity, caller-selected organisation, query parameters or write methods.
Contract: [OpenAPI](openapi/catalog.yaml); TypeScript: `CatalogResponse` / `API_V1_PATHS.catalogItems` in `@pulse/sdk-ts/v1`.
Only active entries return, with exactly `id`, `kind`, `name`, `description`, `price`, `currency`, `taxRate`, `publicLink`.
`price` is integer INR paise **before GST** (12345 = INR 123.45); `currency` is INR; `taxRate: 18` means 18%.
No cost, stock, code/SAC, package parts, source, customer, document or people fields cross this boundary.

On the issuing server, after migration/build, configure the existing operator secret through
`PULSE_OPERATOR_TOKEN_FILE` (or existing `PULSE_OPERATOR_TOKEN`), then run from `services/api`:

```sh
node dist/catalog-admin.js issue /your-install-secret-store/catalog-next.key
node dist/catalog-admin.js revoke <credential-uuid>
node dist/catalog-admin.js share <active-item-uuid>
node dist/catalog-admin.js unshare <item-uuid>
```

`issue` creates a new mode-0600 file without overwriting, sends only its SHA-256 digest and UUID to the loopback
operator API, and prints only the UUID. Keep the raw file in this installation's protected secret store; never
paste it in git, tickets, logs, screenshots or client-side JavaScript. Store the printed UUID for revocation.
For rotation, issue a fresh file, atomically switch the local app's secret reference, verify a read, then revoke
the old UUID. A failed/ambiguous issue call retains the file: inspect locally and revoke its UUID before retrying.
Invalid/revoked keys return 401; other endpoints reject catalogue keys even alongside a staff session.
Audit entries contain only key id/result; operator audit contains action/id. Request logging is disabled.

`share` returns an unguessable relative link for one active item. Resolve it against **this install's** approved
public HTTPS origin. The customer page displays only the same public fields (price in rupees); it has no staff
links or API privileges. Sharing again rotates the link; `unshare` revokes it immediately. Draft/archived items
never display, including through an old link. The list returns `publicLink: null` until explicitly shared.
Service-key revocation and public-link revocation are separate operations. Budget: 120 catalogue requests/minute
per API process, including invalid keys and public pages; 429 returns `Retry-After: 60`. No polling process.

For AC Sales Xray, run these commands **on AC's private Pulse server**, keep the key in AC's secret store, and
configure Lead Desk's server to call AC Pulse over loopback or its own approved HTTPS endpoint. Read the file
at runtime, disable auth-header/request logging, do not follow cross-origin redirects, and keep records AC-local.
Never configure an EA URL, EA credential, shared browser session or EA proxy. Existing perimeter controls and
the AC pilot gate still apply. Synthetic verification needs no AC data or production configuration.

## Flow (FLOW-A)

Flow's own API is not a catalogue or service-key surface: the browser calls `/api/v1/flow/…` as the signed-in person
(the web proxy forwards it to `/v1/flow/…`). Contract: [openapi/flow.yaml](openapi/flow.yaml); modules (plugins):
[src/flow/README.md](src/flow/README.md). A third-party module will declare the same manifest; until the Apps page
connects apps, the `webhook` module sends nothing.
