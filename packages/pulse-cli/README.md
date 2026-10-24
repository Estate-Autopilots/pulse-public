# Pulse CLI v1.0

Node 20+; no runtime dependencies or package publication. `pnpm --filter @pulse/cli build`
produces `dist/pulse.mjs`. Every Next build prerenders the same source at `/developers/pulse.mjs`.

```sh
curl -fS https://pulse.example.com/developers/pulse.mjs -o pulse.mjs
export PULSE_URL=https://pulse.example.com
node pulse.mjs auth login
node pulse.mjs ops
node pulse.mjs <operationId> --param limit=10 --all
node pulse.mjs <writeOperationId> --data @body.json --idempotency-key <uuid>
```

`--url` overrides `PULSE_URL`; scripts use `PULSE_API_KEY`. Login reads without echo and
atomically stores `auth.json` at `$XDG_CONFIG_HOME/pulse` (default `~/.config/pulse`) with
mode 0600. Saved keys are bound to their company origin. HTTPS is required except on loopback.
The served OpenAPI supplies operations; legacy entries without ids use method + PascalCase path
(e.g. `getServiceClients`). Documented person-token headers use `PULSE_PERSON_TOKEN`; credentials are refused in `--param`.
Service-specific scopes and idempotency formats remain the server's contract: chat slots need an explicit override.

`auth status` shows the local key id/prefix; scopes and validity are unknown because this reference
has no public introspection operation. It never infers grants from reads. No automatic retries;
writes use one invocation UUID unless overridden. `--all` stops at 100 pages and rejects loops,
with no partial output on failure. Each response is limited to 4 MiB; redirects are refused.
Exit codes: 0 success, 1 transport/server, 2 authentication, 3 scope, 4 validation/client, 5 rate limit.
Errors omit headers and redact credentials, as does JSON output. Review grants before calling writes.

`pnpm --filter @pulse/cli test` covers hidden login, file permissions, redaction, paging and standalone transport.
`services/api/test/pulse-cli.test.mjs` runs the actual v1 HTTP front door with two synthetic companies,
a synthetic DB seam and unchanged auth/scope/rate/replay hooks; database RLS remains covered by API/DB suites.
