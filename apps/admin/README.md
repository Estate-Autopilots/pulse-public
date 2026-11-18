# apps/admin · the Pulse admin site

The company back office for Pulse's platform admins (PULSE-ADMIN, 27 Oct 2026), ported from the Sales X-Ray admin
console (Atlas Crest `apps/admin-web`): the same shell, navigation, kit and section structure, rebranded to Pulse
and wired to Pulse's platform API (`/api/v0/platform/*`, services/api/src/platform-admin.ts).

- **Who:** Pulse's platform admins only (pulse.platform_admin(), checked by the API and in the database). Sign-in is
  with Pulse itself (`/login` → `/auth/sign-in`, two-step when Pulse asks), behind Cloudflare Access.
- **Where:** production `pulse-admin.<domain>` (inside the Pulse container on 127.0.0.1:8083; Pulse's web forwards the
  host, `PULSE_ADMIN_HOSTS`), development `pulse-admin-dev.<domain>` (`next dev`).
- **Brand, company, domain:** environment only (app/lib/config.ts): `PULSE_PLATFORM_NAME`, `PULSE_PLATFORM_COMPANY`,
  `PULSE_SUPPORT_EMAIL`, `PULSE_ADMIN_ENV`, `PULSE_ADMIN_PRODUCTION_URL`, `PULSE_ADMIN_DEV_URL`, `PULSE_APP_URL`.
- **API:** `PULSE_API_URL` (default http://127.0.0.1:8081).
