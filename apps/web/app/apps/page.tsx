import Link from "next/link";
import { LayoutGrid, MonitorSmartphone, PlugZap } from "lucide-react";
import { api, getMe } from "../lib/api";
import { GUIDES } from "../settings/app-guides";
import { Badge, Empty, Page, PageHeader, Panel, styles } from "../ui";
import { APPS } from "./catalogue";
import css from "./store.module.css";
import type { Status } from "./sales-xray/types";

export const metadata = { title: "Apps" };

/** EST-1363: Apps. The apps a company can use inside Pulse (repo data, catalogue.ts), each with this person's state,
 *  and Pulse on their own devices. Signed out, only the device guides show (they need no sign-in). */
export default async function AppsPage() {
  const me = (await getMe()).data;
  const off = me?.modules?.off ?? [];
  const status = me && !off.includes("sales_xray") ? await api<Status>("sales-xray/status") : null;
  return (
    <Page>
      <PageHeader title="Apps" context={me ? ["Apps in Pulse and Pulse on your devices"] : ["Pulse on your devices"]} />
      {me ? <Panel title="Apps in Pulse" sub="Each person connects their own account">
        <ul className={css.cards}>{APPS.map((app) => {
          const on = !off.includes(app.module), s = status?.data;
          const state = !on ? <Badge>Not switched on here</Badge> : s?.connected ? <Badge tone="success">Connected</Badge> : s && !s.configured ? <Badge tone="warning">Not set up yet</Badge> : <Badge>Not connected</Badge>;
          return <li key={app.id} className={css.card}>
            <span className={css.icon} aria-hidden="true"><PlugZap size={20} /></span>
            <div className={css.body}>
              <div className={css.title}><b>{app.name}</b>{state}</div>
              <small className={css.maker}>By {app.maker}</small>
              <p>{app.purpose}</p>
              {on ? <Link className={`${styles.btn} ${styles.btnPrimary} ${css.open}`} href={app.href}>{s?.connected ? "Open" : "Connect"}</Link> : <p className={css.note}>Your organisation’s admin switches it on in Settings → Modules.</p>}
            </div>
          </li>;
        })}</ul>
      </Panel> : <Panel title="Apps in Pulse"><Empty icon={LayoutGrid} compact title="Sign in to add apps" text="Apps like Sales X-Ray connect to your own Pulse account." action={{ href: "/login?next=%2Fapps", label: "Sign in" }} /></Panel>}
      <Panel title="Pulse on your devices" sub="Install guides, no sign-in needed">
        <ul className={css.devices}>{GUIDES.map((g) => <li key={g.slug}><Link href={`/apps/${g.slug}`}><MonitorSmartphone size={16} aria-hidden="true" />{g.title}</Link></li>)}</ul>
      </Panel>
    </Page>
  );
}
