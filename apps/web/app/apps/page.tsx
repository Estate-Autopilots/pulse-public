import Link from "next/link";
import { ArrowLeftRight, LayoutGrid, MonitorSmartphone, ScanSearch } from "lucide-react";
import { api, getMe } from "../lib/api";
import { GUIDES } from "../settings/app-guides";
import { Badge, Empty, Page, PageHeader, Panel, styles } from "../ui";
import { APPS } from "./catalogue";
import css from "./store.module.css";
import type { Status } from "./sales-xray/types";
import { ConnectSheet } from "./sales-xray/connect";

export const metadata = { title: "Apps" };

/** EST-1363: Apps. The apps a company can use inside Pulse (repo data, catalogue.ts), each with this person's state,
 *  and Pulse on their own devices. Signed out, only the device guides show (they need no sign-in).
 *  NAV-CONNECT (owner, 17 Nov 2026): as app stores do it, Connect works from the card in one click (the sheet names the
 *  company it is for and what the app may do), and a connected app says which company it is connected for and which of
 *  its organisations: "Estate Autopilots ⇄ <the Sales X-Ray organisation>". */
export default async function AppsPage() {
  const me = (await getMe()).data;
  const off = me?.modules?.off ?? [];
  const status = me && !off.includes("sales_xray") ? await api<Status>("sales-xray/status") : null;
  const company = status?.data?.company ?? { name: me?.orgName ?? "this company", handle: me?.orgHandle ?? null };
  const others = (me?.account?.orgs ?? []).filter((o) => !o.current && !o.mine && o.kind === "staff").map((o) => ({ id: o.id, name: o.name }));
  return (
    <Page>
      <PageHeader title="Apps" context={me ? ["Apps in Pulse and Pulse on your devices"] : ["Pulse on your devices"]} />
      {me ? <Panel title="Apps in Pulse" sub="Everyone connects their own account">
        <ul className={css.cards}>{APPS.map((app) => {
          const on = !off.includes(app.module), s = status?.data;
          const held = !!s?.connected && !!s.check, ws = s?.account?.kind === "personal" ? "Personal" : s?.account?.workspace ?? null;
          const state = !on ? <Badge>Not switched on here</Badge> : held ? <Badge tone="warning">Check the organisation</Badge> : s?.connected ? <Badge tone="success">Connected</Badge> : s && !s.configured ? <Badge tone="warning">Not set up yet</Badge> : <Badge>Not connected</Badge>;
          return <li key={app.id} className={css.card}>
            <span className={css.icon} aria-hidden="true"><ScanSearch size={20} /></span>
            <div className={css.body}>
              <div className={css.title}><b>{app.name}</b>{state}</div>
              <small className={css.maker}>By {app.maker}</small>
              <p>{app.purpose}</p>
              {on && s?.connected && ws ? <p className={css.linkedTo}><b>{company.name}</b><ArrowLeftRight size={14} aria-label="connected to" /><b>{ws}</b><small>in {app.name}</small></p> : null}
            </div>
            {on && s && !s.connected && s.configured ? <div className={css.open}><ConnectSheet company={company} others={others} label="Connect" /></div>
                : on ? <Link className={`${styles.btn} ${styles.btnPrimary} ${css.open}`} href={app.href}>{held ? "Check it" : s?.connected ? "Open" : "See why"}</Link> : <p className={css.note}>{/* VISUAL-QA: true whether the company or this Pulse has it off (me.modules.off merges both). */}{me.role === "admin" ? "Not on for this company yet. If Settings → Company → Modules lists it, switch it on there; if not, this Pulse does not offer it yet." : "Not on for this company yet. Your organisation’s admin decides."}</p>}
          </li>;
        })}</ul>
      </Panel> : <Panel title="Apps in Pulse"><Empty icon={LayoutGrid} compact title="Sign in to add apps" text="Apps like Sales X-Ray connect to your own Pulse account." action={{ href: "/login?next=%2Fapps", label: "Sign in" }} /></Panel>}
      <Panel title="Pulse on your devices" sub="Install guides, no sign-in needed">
        <p className={css.getApp}><Link className={styles.btn} href="/apps/get">Get Vitals OS for your phone or computer</Link></p>
        <ul className={css.devices}>{GUIDES.map((g) => <li key={g.slug}><Link href={`/apps/${g.slug}`}><MonitorSmartphone size={16} aria-hidden="true" />{g.title}</Link></li>)}</ul>
      </Panel>
    </Page>
  );
}
