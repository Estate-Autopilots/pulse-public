import { redirect } from "next/navigation";
import { Building2, Check, PlugZap, ShieldCheck, UserRound } from "lucide-react";
import { api, getMe } from "../../lib/api";
import { Badge, Empty, Page, PageHeader, Panel, QueryTabs } from "../../ui";
import { APPS } from "../catalogue";
import { AskView, CallsView, ConnectButton, DisconnectButton, LeadsView, SendWorkflowsButton } from "./controls";
import { RecordingButton } from "./linked";
import { SyncView } from "./sync";
import css from "./sales-xray.module.css";
import type { Status } from "./types";

export const metadata = { title: "Sales X-Ray" };

const ROLE: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member" };

/** EST-1363: Sales X-Ray inside Pulse. Each person connects their own Sales X-Ray account, then reads their calls (with
 *  the facts found in them) and their leads here, and asks Pulse about them. Nothing is copied into Pulse: each tab
 *  reads Sales X-Ray when it opens, as this person. */
export default async function SalesXrayApp({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const me = (await getMe()).data;
  if (!me) redirect("/login?next=%2Fapps%2Fsales-xray");
  const editor = me.role === "admin" || me.role === "leadership";
  const [{ tab }, status] = await Promise.all([searchParams, api<Status>("sales-xray/status")]);
  const app = APPS[0], s = status.data;
  const tabs = [{ key: "calls", label: "Calls" }, { key: "leads", label: "Leads" }, ...(s?.ask ? [{ key: "ask", label: "Ask" }] : []), { key: "sync", label: "Sync" }];
  const current = tabs.some((t) => t.key === tab) ? tab! : "calls";
  const account = s?.connected ? s.account : undefined;
  return (
    <Page>
      <PageHeader title="Sales X-Ray" back={{ href: "/apps", label: "Apps" }}
        context={account ? [account.person ?? "Your account", account.workspace ?? (account.kind === "personal" ? "Personal" : "")].filter(Boolean) : [`By ${app.maker}`]}
        actions={s?.connected ? <><RecordingButton />{editor ? <SendWorkflowsButton /> : null}<DisconnectButton /></> : undefined} />
      {!s ? <Panel title="Sales X-Ray"><Empty icon={PlugZap} title="This didn’t load" text="Pulse couldn’t check your Sales X-Ray connection just now. Reload the page to try again." /></Panel>
        : !s.connected && !s.configured ? <Panel title="Sales X-Ray"><Empty icon={PlugZap} first title="Sales X-Ray isn’t set up on this Pulse server yet" text="Ask the Pulse administrator to name the Sales X-Ray address for this server." /></Panel>
        : !s.connected ? <section className={css.hero} aria-labelledby="sx-connect">
          <span className={css.mark} aria-hidden="true"><PlugZap size={22} /></span>
          <div className={css.heroText}>
            <h2 id="sx-connect">Connect your Sales X-Ray account</h2>
            <p>{app.purpose}</p>
            <div className={css.lists}>
              <div><h3>Pulse will read</h3><ul>{app.reads.map((r) => <li key={r}><Check size={14} aria-hidden="true" />{r}</li>)}</ul></div>
              <div><h3>Pulse promises</h3><ul>{app.promises.map((r) => <li key={r}><ShieldCheck size={14} aria-hidden="true" />{r}</li>)}</ul></div>
            </div>
            <ConnectButton />
            <p className={css.small}>You sign in on Sales X-Ray with the account you bought or were added to, and choose the workspace there.</p>
          </div>
        </section>
        : <>
          <div className={css.account}>
            {account?.kind === "personal" ? <UserRound size={16} aria-hidden="true" /> : <Building2 size={16} aria-hidden="true" />}
            <span><b>{account?.workspace ?? "Personal"}</b>{account?.role ? <Badge>{ROLE[account.role] ?? account.role}</Badge> : null}</span>
            <small>Connected {s.connectedAt ? new Date(s.connectedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : ""} · reading only</small>
          </div>
          <QueryTabs base="/apps/sales-xray" items={tabs} current={current} />
          {current === "leads" ? <LeadsView /> : current === "ask" ? <AskView /> : current === "sync" ? <SyncView admin={me.role === "admin"} /> : <CallsView />}
        </>}
    </Page>
  );
}
