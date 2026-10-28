import { Fragment } from "react";

import { read } from "@/app/lib/api";
import { loadAccess } from "@/app/lib/access";
import { adminConfig } from "@/app/lib/config";
import { Page, PageHeader, Panel } from "@/app/ui/kit";
import css from "@/app/ui/console.module.css";

type PlatformConfig = { product: string; company: string | null; supportEmail: string | null; domain: string | null; publicUrl: string | null; bugTriagePath: string };

// PULSE-ADMIN: who runs this Pulse and how this site is set up. All of it comes from configuration (environment
// variables of the API and of this site), so moving Pulse to its own company and domain is a configuration change.
export default async function Settings() {
  const [api, access] = await Promise.all([read<PlatformConfig>("platform/config"), loadAccess()]);
  const site = adminConfig();
  const p = api.data;
  return (
    <Page>
      <PageHeader title="Settings" context={["Configuration, read only", "Change it in the server’s environment"]} />
      <Panel title="Who runs this Pulse" sub="API: PULSE_PLATFORM_NAME, PULSE_PLATFORM_COMPANY, PULSE_SUPPORT_EMAIL, PULSE_PLATFORM_DOMAIN">
        <dl className={css.facts}>
          <dt>Product</dt><dd>{p?.product ?? site.product}</dd>
          <dt>Company</dt><dd>{p?.company ?? site.company ?? <span className={css.muted}>Not set yet</span>}</dd>
          <dt>Support address</dt><dd>{p?.supportEmail ?? site.supportEmail ?? <span className={css.muted}>Not set yet</span>}</dd>
          <dt>Domain</dt><dd>{p?.domain ?? <span className={css.muted}>Not set</span>}</dd>
          <dt>Pulse address</dt><dd>{p?.publicUrl ?? site.appUrl ?? "—"}</dd>
        </dl>
      </Panel>
      <Panel title="This admin site" sub="PULSE_ADMIN_ENV, PULSE_ADMIN_PRODUCTION_URL, PULSE_ADMIN_DEV_URL, PULSE_APP_URL">
        <dl className={css.facts}>
          <dt>Environment</dt><dd>{site.environment === "development" ? "Development" : "Production"}</dd>
          {site.sites.map((s) => <Fragment key={s.key}><dt>{s.label} site</dt><dd>{s.url}</dd></Fragment>)}
          <dt>Signed in as</dt><dd>{access.displayName ?? access.email ?? "—"}{access.orgName ? ` · ${access.orgName}` : ""}</dd>
          <dt>Who may sign in</dt><dd>Pulse’s platform admins only, named from the server (POST /api/v1/operator/platform-admins); Cloudflare Access in front.</dd>
        </dl>
      </Panel>
    </Page>
  );
}
