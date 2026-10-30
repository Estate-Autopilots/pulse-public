import Link from "next/link";
import { headers } from "next/headers";
import { Devices } from "./devices";
import type { DevicesData } from "./device-types";
import { readDownloads } from "./downloads";
import { installOrigin } from "../lib/app-updates";
import { TrackingHealth, type HealthData } from "./tracking-health";
import { Testers, type Feedback, type TestersData } from "./testers";
import { TestDevice } from "./test-device";
import { DataHealthView } from "../research/views";
import type { LeadData } from "../research/types";
import { Hourglass, ShieldCheck } from "lucide-react";
import { DesktopBuildPanel } from "@pulse/ui-shell";
import { api, getMe } from "../lib/api";
import { Empty, Message, Page, PageHeader, Panel, styles } from "../ui";
import { Sections } from "../sections";
import { Appearance } from "./appearance";
import { MuteKinds } from "../notifications/mute";
import { NotificationStatus } from "../notify-status";
import type { CompanySetup } from "../companies/types";
import { CompanySetupView } from "./company-setup";
import { PilotFeedback, type PilotFeedbackState } from "./pilot-feedback";
import { Connected } from "./connected";
import type { PolicyData } from "../hr/types";
import { Organisation, WorkingRules } from "./organisation";
import { Roles } from "./roles";
import { TypesSettings } from "./types-settings";
import { SignIn } from "./sign-in";
import { Team } from "./team";
import { WorkRules, type RulesData } from "./work-rules";
import { ModulesSettings } from "./modules";
import { IndustrySettings } from "./industry";
import { AppsSettings } from "./apps";
import { AiSettings } from "./ai";
import { MailboxSettings } from "./mailbox";
import { ChatSettings } from "./chats";
import { PrivacyPanel } from "../privacy-note";
import rulesCss from "./work-rules.module.css";
import css from "./settings.module.css";
import { WorkModel } from "../tasks/work-two";
import { ReviewSettings } from "../tasks/review-settings";
import { TABS, type AccessData, type SettingsData, type TabKey } from "./types";
import { SettingsNav } from "./nav";
import { ConnectedApps, DeveloperApps } from "./connected-apps";

/** Shown in place of a tab whose data the service could not give, so the rest of Settings keeps working. */
function Unavailable({ what, error }: { what: string; error: string }) {
  return <section className={styles.panel}><Empty icon={Hourglass} first title={`${what} is not available yet`} text={`The settings service did not answer for this tab (“${error}”). Nothing has been changed; try again in a few minutes.`} /></section>;
}

export default async function Settings({ searchParams }: { searchParams: Promise<{ tab?: string; view?: string; pilot?: string }> }) {
  const query = await searchParams;
  const me = await getMe();
  if (me.error) return <Message text={me.error} />; if (!me.data) return null;
  if (query.tab === "roles" && me.data.role !== "admin") return <Page fit><PageHeader title="Settings" context={["Roles & permissions"]} />
    <section className={styles.panel}><Empty icon={ShieldCheck} first title="Organisation admin access required"
      text="Ask an organisation admin to review your roles and permissions. Only organisation admins can open these settings. Your access has not changed."
      action={{ href: "/finance", label: "Back to Finance" }} /></section></Page>;
  if(query.tab==='devices') {
    const r=query.pilot==='synthetic'?null:await api<DevicesData>('sensing/desk'); const origin=installOrigin(await headers()); const downloads=await readDownloads(origin);
    // Admin and leadership also see every person's connected apps and tracking health, and run the tester programme.
    const team=me.data.role==='admin'||me.data.role==='leadership';
    const [health,testers,feedback]=team?await Promise.all([api<HealthData>('devices/health'),api<TestersData>('testers'),api<{rows:Feedback[]}>('feedback')]):[null,null,null];
    // R54: while the company runs its pilot, everyone answers four questions once (anonymous, totals only).
    const pilot=query.pilot==='synthetic'?null:(await api<PilotFeedbackState>('pilot-feedback')).data;
    // MOBILE-READY (1260): an admin signs a test phone in as themselves with a one-time code (no password on the phone).
    const extra=[...(me.data.role==='admin'&&query.pilot!=='synthetic'?[{label:'Add a test device',content:<TestDevice/>}]:[]),...(pilot?.open?[{label:'Pilot feedback',content:<PilotFeedback initial={pilot}/>}]:[]),...(health?.data?[{label:'Devices & tracking health',content:<TrackingHealth data={health.data}/>}]:[]),...(testers?.data?[{label:'Invite testers',content:<Testers initial={testers.data} feedback={feedback?.data?.rows??[]}/>}]:[])];
    return <Page fit><PageHeader title="Your devices" context={['Pulse apps', 'Private evidence']} />{me.data.role === 'admin' ? <SettingsNav current="devices" available={TABS.filter((t) => t.key !== "roles")} /> : null}<Devices initial={r?.data} synthetic={query.pilot==='synthetic'} error={r?.error} downloads={downloads} origin={origin} extra={extra}/></Page>;
  }
  // UX-TASKS-2: how Pulse names the work (leadership and admins change it) sits above Who can do what.
  const model = query.tab === "work-rules" ? (await api<Parameters<typeof WorkModel>[0]["data"]>("work/settings")).data : null;
  // FLOW-E: leadership sets the company's industry, words and roles too (Settings → Industry & roles).
  // FLOW-E: Settings → Apps: every app a process can use, connected or not (Sales X-Ray and Gmail are each person's own).
  if (query.tab === "apps" && me.data.role !== "admin") return <Page fit><PageHeader title="Settings" context={["Apps"]} back={{ href: "/settings", label: "Settings" }} /><AppsSettings /></Page>;
  // CONNECT-AI: leadership connects AI too (Settings → AI); admins have it as a tab.
  if (query.tab === "ai" && me.data.role === "leadership") return <Page fit><PageHeader title="Settings" context={["AI"]} back={{ href: "/settings", label: "Settings" }} /><AiSettings /></Page>;
  // GROUP-ACCESS: leadership decides who reads client group conversations too (Settings → Chats); admins have it as a tab.
  if (query.tab === "chats" && me.data.role === "leadership") return <Page fit><PageHeader title="Settings" context={["Chats"]} back={{ href: "/settings", label: "Settings" }} /><ChatSettings /></Page>;
  if (query.tab === "industry" && me.data.role === "leadership") return <Page fit><PageHeader title="Settings" context={["Industry & roles"]} back={{ href: "/settings", label: "Settings" }} /><IndustrySettings /></Page>;
  if (me.data.role !== "admin" && me.data.role !== "hr") {
    const rules = await api<RulesData>("work/rules");
    if (query.tab === "work-rules") return <Page fit><PageHeader title="Settings" context={["Who can do what"]} back={{ href: "/settings", label: "Settings" }} />
      <div className={rulesCss.stack} data-grow="">{model ? <WorkModel data={model} /> : null}{model ? <ReviewSettings data={model} /> : null}{rules.data ? <WorkRules data={rules.data} /> : <Message text={rules.error ?? "Unavailable"} />}</div></Page>;
    // UI-POLISH-3: a member's preferences are short cards; they show at their own size, two columns on a computer, instead
    // of one card at a time stretched over the window. Who can do what (a wide table) follows below.
    return (
    <Page>
      <PageHeader title="Settings" context={["Your preferences"]} />
      <div className={css.prefs}>
        <Appearance />
        <Panel title="Your account" sub="How you sign in to Pulse">
          <dl className={styles.facts} style={{ padding: "12px 16px" }}>
            <dt>Name</dt><dd>{me.data.name}</dd>
            <dt>Username</dt><dd className={styles.mono}>{me.data.username ?? "—"}</dd>
            <dt>Signs in with</dt><dd>{me.data.via === "password" ? "A Pulse password" : "The company Google account"}</dd>
            <dt>Devices</dt><dd><Link href="/settings?tab=devices">Get the apps · your devices</Link></dd>
          </dl>
          <p className={styles.panelFoot}><span>Pods, roles and everyone&apos;s sign-in are managed by HR and organisation admins.</span><Link href="/settings?tab=apps">Apps</Link>{me.data.role === "leadership" ? <Link href="/settings?tab=industry">Industry & roles</Link> : null}{me.data.role === "leadership" ? <Link href="/settings?tab=ai">AI</Link> : null}{me.data.role === "leadership" ? <Link href="/settings?tab=chats">Chats</Link> : null}{me.data.via === "password" ? <Link href="/login?change=own">Change your password</Link> : null}</p>
        </Panel>
        {/* RELEASE-3: notifications on this device, with Turn on and a test. */}
        <Panel title="Notifications" sub="On this device, and what may ping you"><div style={{ padding: "12px 16px" }}><NotificationStatus /><MuteKinds /></div></Panel>
        {/* PULSE-ID: the apps this person signed in to with Pulse, and what each can see. */}
        <ConnectedApps orgName={me.data.orgName ?? "your organisation"} />
        <PrivacyPanel />
      </div>
      {rules.data ? <WorkRules data={rules.data} /> : <Panel title="Who can do what"><p className={styles.muted} style={{ padding: 14 }}>{rules.error}</p></Panel>}
    </Page>
  ); }
  // EST-1205: one entry for permissions. "Who can do what" holds the work rules and the roles; ?tab=roles opens its roles.
  const shown = TABS.filter((t) => t.key !== "roles");
  if(query.tab==='data-health'&&me.data.role==='admin'){const r=await api<LeadData>('research');if(r.error||!r.data)return <Message text={r.error??'Research observations unavailable'}/>;return <Page fit><PageHeader title="Settings" context={['Data health']}/><SettingsNav current="data-health" available={shown}/><DataHealthView d={r.data}/></Page>;}
  // R54: HR of a company set up with the checklist reads it and signs off the pilot's walkthrough under Organisation → Setup.
  const hrSetup = me.data.role === "hr" ? (await api<CompanySetup>("company-setup")).data : null;
  const hrOnly = me.data.role === "hr";
  const available = hrOnly ? shown.filter(t=>t.key==="sign-in"||t.key==="work-rules"||t.key==="connected-apps"||(t.key==="organisation"&&!!hrSetup?.managed)) : shown;
  const asked = query.tab === "roles" ? "work-rules" : query.tab;
  const tab: TabKey = available.find((t) => t.key === asked)?.key ?? "sign-in";
  const label = TABS.find((t) => t.key === tab)!.label;
  const workRules = tab === "work-rules" ? await api<RulesData>("work/rules") : null;
  const access = tab === "sign-in" ? await api<AccessData>("admin/access") : null;
  const settings = tab === "sign-in" || tab === "desktop-app" || tab === "industry" || tab === "apps" || tab === "ai" || tab === "mail" || tab === "chats" || tab === "connected-apps" || hrOnly ? null : await api<SettingsData>("settings");
  const rules = tab === "organisation" && !hrOnly ? await api<PolicyData>("hr/policy") : null;
  // R53: a company set up on this Pulse follows its setup checklist here (first while it is in trial).
  const setup = tab === "organisation" ? hrSetup ?? (await api<CompanySetup>("company-setup")).data : null;
  const setupSection = setup?.managed ? { label: "Setup", content: <CompanySetupView initial={setup} /> } : null;
  return (
    <Page fit>
      <PageHeader title="Settings" context={[me.data.orgName ?? settings?.data?.org?.name ?? "Pulse", me.data.role==="hr"?"HR onboarding":"Organisation admin"]} recent={{ title: "Settings" }} />
      <SettingsNav current={tab} available={available} />
      {access ? access.data ? <SignIn people={access.data.people ?? []} requests={access.data.requests ?? []} admin={me.data.role === "admin"} /> : <Unavailable what={label} error={access.error ?? "no data"} /> : null}
      {tab === "sign-in" ? <PrivacyPanel /> : null}
      {tab === "desktop-app" ? <DesktopBuildPanel /> : null}
      {tab === "industry" && !hrOnly ? <IndustrySettings /> : null}
      {tab === "apps" && !hrOnly ? <AppsSettings /> : null}
      {tab === "ai" && !hrOnly ? <AiSettings /> : null}
      {tab === "mail" && !hrOnly ? <MailboxSettings /> : null}
      {tab === "chats" && !hrOnly ? <ChatSettings /> : null}
      {tab === "connected-apps" ? <div style={{ display: "grid", gap: 16, alignContent: "start" }} data-grow=""><ConnectedApps orgName={me.data.orgName ?? "your organisation"} /><DeveloperApps /></div> : null}
      {hrOnly && tab === "organisation" && setupSection ? <Sections items={[setupSection]} /> : null}
      {workRules ? (() => {
        const rulesView = <div className={rulesCss.stack} data-grow="">{model ? <WorkModel data={model} /> : null}{model ? <ReviewSettings data={model} /> : null}{workRules.data ? <WorkRules data={workRules.data} /> : <Unavailable what={label} error={workRules.error ?? "no data"} />}</div>;
        if (!settings) return rulesView;
        const s = settings.data;
        return <Sections param="permissions" initial={query.tab === "roles" ? 1 : 0} items={[{ label: "Work rules", content: rulesView },
          { label: "Roles & permissions", content: s ? <Roles roles={s.roles ?? []} people={s.people ?? []} permissions={s.permissions ?? []} canGrant={!!s.canGrant} canEdit={!!s.canEdit} viewer={me.data.person} salaryList={s.salaryList} /> : <Unavailable what="Roles & permissions" error={settings.error ?? "no data"} /> }]} />;
      })() : null}
      {settings && tab !== "work-rules" ? (() => {
        const s = settings.data; const missing = s ? null : <Unavailable what={label} error={settings.error ?? "no data"} />;
        if (tab === "team") return s ? <Team pods={s.pods ?? []} unassigned={s.unassigned ?? []} people={s.people ?? []} canEdit={!!s.canEdit} initialView={query.view === "lines" ? "lines" : "pods"} /> : missing;
        if (tab === "connected") return s ? <Connected sources={s.sources ?? []} sync={s.sync} runs={s.runs ?? []} connectors={!me.data.modules?.off?.includes("connectors")} /> : missing;
        return <Sections items={[
          ...(setupSection && setup?.managed && setup.company.activation === "trial" ? [setupSection] : []),
          // UI-POLISH-3: "Name & logo", not a third "Organisation" under the Organisation area and section.
          {label: "Name & logo", content: s?.org ? <Organisation org={s.org} canEdit={!!s.canEdit} /> : missing},
          // UX-TENANT: the organisation's module switches and accent; the platform operator also reaches Companies here.
          {label: "Modules", content: <ModulesSettings operator={!!me.data.operator} />},
          {label: "Working rules", content: <WorkingRules data={rules?.data} error={rules?.error} />},
          // PEOPLE-CONTACTS: the organisation's own contact and client types (admins add, rename, recolour, archive).
          {label: "Contact & client types", content: <TypesSettings />},
          {label: "Appearance", content: <Appearance />},
          // RELEASE-3: notifications on this device, with Turn on and a test (everyone also has them in Notifications).
          {label: "Notifications", content: <Panel title="Notifications" sub="On this device, and what may ping you"><div style={{ padding: "12px 16px" }}><NotificationStatus /><MuteKinds /></div></Panel>},
          ...(setupSection && setup?.managed && setup.company.activation === "live" ? [setupSection] : []),
        ]} />;
      })() : null}
    </Page>
  );
}
