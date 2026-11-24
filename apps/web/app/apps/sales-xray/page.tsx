import { redirect } from "next/navigation";
import { Building2, Check, CheckCircle2, PlugZap, ShieldCheck } from "lucide-react";
import { api, getMe } from "../../lib/api";
import { Empty, Page, PageHeader, Panel, QueryTabs } from "../../ui";
import { APPS } from "../catalogue";
import { AskView, CallsView, DisconnectButton, LeadsView, SendWorkflowsButton } from "./controls";
import { Bridge, CheckPanel, ConnectSheet } from "./connect";
import { RecordingButton } from "./linked";
import { SyncView } from "./sync";
import css from "./sales-xray.module.css";
import type { Status } from "./types";

export const metadata = { title: "Sales X-Ray" };

const ROLE: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member" };

/** EST-1363: Sales X-Ray inside Pulse. Each person connects their own Sales X-Ray account, then reads their calls (with
 *  the facts found in them) and their leads here, and asks Pulse about them. Nothing is copied into Pulse: each tab
 *  reads Sales X-Ray when it opens, as this person. */
export default async function SalesXrayApp({ searchParams }: { searchParams: Promise<{ tab?: string; connect?: string }> }) {
  const me = (await getMe()).data;
  if (!me) redirect("/login?next=%2Fapps%2Fsales-xray");
  const editor = me.role === "admin" || me.role === "leadership";
  const [{ tab, connect }, status] = await Promise.all([searchParams, api<Status>("sales-xray/status")]);
  const app = APPS[0], s = status.data;
  const tabs = [{ key: "calls", label: "Calls" }, { key: "leads", label: "Leads" }, ...(s?.ask ? [{ key: "ask", label: "Ask" }] : []), { key: "sync", label: "Bring in leads" }];
  const current = tabs.some((t) => t.key === tab) ? tab! : "calls";
  const account = s?.connected ? s.account : undefined;
  // A connection made before Pulse asked for leads:update and calls:write keeps reading; it reconnects to send.
  const missing = s?.connected ? s.missing ?? [] : [], canSend = !missing.includes("calls:write");
  // NAV-CONNECT: the company this tab is in is the one being connected; someone in several companies may open another
  // here first (/at/<id>, back with ?connect=1, which opens the sheet again there).
  const company = s?.company ?? { name: me.orgName ?? "this company", handle: me.orgHandle ?? null };
  const others = (me.account?.orgs ?? []).filter((o) => !o.current && !o.mine && o.kind === "staff").map((o) => ({ id: o.id, name: o.name }));
  const held = !!s?.connected && !!s.check, personal = account?.kind === "personal";
  return (
    <Page>
      <PageHeader title="Sales X-Ray" back={{ href: "/apps", label: "Apps" }}
        context={s?.connected ? (held ? [`For ${company.name}`] : undefined) : [`By ${app.maker}`]}
        actions={s?.connected && !held ? <>{canSend ? <RecordingButton primary /> : null}{editor ? <SendWorkflowsButton /> : null}</> : undefined} />
      {!s ? <Panel title="Sales X-Ray"><Empty icon={PlugZap} title="This didn’t load" text="Pulse couldn’t check your Sales X-Ray connection just now. Reload the page to try again." /></Panel>
        : !s.connected && !s.configured ? <Panel title="Sales X-Ray"><Empty icon={PlugZap} first title="Sales X-Ray isn’t set up on this Pulse server yet" text="Ask the Pulse administrator to name the Sales X-Ray address for this server." /></Panel>
        : !s.connected ? <section className={css.hero} aria-labelledby="sx-connect">
          <span className={css.mark} aria-hidden="true"><PlugZap size={22} /></span>
          <div className={css.heroText}>
            <h2 id="sx-connect">Connect your Sales X-Ray account</h2>
            <p>{app.purpose}</p>
            <CompanyLine name={company.name} />
            {/* VITALS-SWEEP (22 Nov 2026; judge: on a phone the button sat at the bottom edge under 157 words): the button
                first, then what Pulse reads and promises, one tap away. */}
            <div className={css.connect}><ConnectSheet company={company} others={others} autoOpen={connect === "1"} /></div>
            <p className={css.small}>You sign in on Sales X-Ray with the account you bought or were added to, and pick the {company.name} organisation there.</p>
            <details className={css.what}><summary>What Pulse reads, and what it promises</summary><div className={css.lists}>
              <div><h3>Pulse will read</h3><ul>{app.reads.map((r) => <li key={r}><Check size={14} aria-hidden="true" />{r}</li>)}</ul></div>
              <div><h3>Pulse promises</h3><ul>{app.promises.map((r) => <li key={r}><ShieldCheck size={14} aria-hidden="true" />{r}</li>)}</ul></div>
            </div></details>
          </div>
        </section>
        : held ? <CheckPanel company={company.name} workspace={account?.workspace ?? null} personal={personal} />
        : <>
          {/* NAV-CONNECT: one line, so the calls lead: which company, which Sales X-Ray organisation, since when, Disconnect. */}
          <div className={css.linkedPair}>
            <Bridge company={company.name} workspace={account?.workspace ?? null} personal={personal} match={s.match !== "no"} role={account?.role ? ROLE[account.role] ?? account.role : undefined} />
            <small>{s.connectedAt ? `Connected ${new Date(s.connectedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })}` : "Connected"}{missing.length ? " · reading only" : ""} · <DisconnectButton quiet /></small>
          </div>
          {/* A phone: one line, so the calls come first. */}
          <p className={css.linkedPhone}><CheckCircle2 size={15} aria-hidden="true" /><span>Connected to <b>{personal ? "Personal" : account?.workspace ?? company.name}</b> in Sales X-Ray</span><DisconnectButton quiet /></p>
          {s.match === "no" ? <div className={css.account} role="status">
            <span><b>Not named like {company.name}</b></span>
            <small>This connection was made before Pulse checked the organisation. If {account?.workspace ?? "it"} is not {company.name}, disconnect and connect again.</small>
          </div> : null}
          {missing.length ? <div className={css.account} role="status">
            <span><b>Reconnect to allow updates</b></span>
            <small>Your connection was made before Sales X-Ray let Pulse send recordings and client changes. Reading still works; reconnect once to send them.</small>
            <ConnectSheet company={company} others={others} label="Reconnect to allow updates" ghost />
          </div> : null}
          <QueryTabs base="/apps/sales-xray" items={tabs} current={current} />
          {current === "leads" ? <LeadsView /> : current === "ask" ? <AskView /> : current === "sync" ? <SyncView admin={me.role === "admin"} /> : <CallsView />}
        </>}
    </Page>
  );
}

/** NAV-CONNECT: the company being connected, said before the button. */
function CompanyLine({ name }: { name: string }) {
  return <p className={css.forCompany}><Building2 size={15} aria-hidden="true" />For <b>{name}</b></p>;
}
