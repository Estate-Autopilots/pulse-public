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
import { CalendarCard } from "./calendar";
import { MuteKinds } from "../notifications/mute";
import { NewDotsSetting } from "../notifications/new-dots-setting";
import { NotificationStatus } from "../notify-status";
import { TelegramLink } from "./telegram-link";
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
import { ServersSettings } from "./servers";
import { ToolConnectors } from "./tool-connectors";
import { MailboxSettings } from "./mailbox";
import { ChatSettings } from "./chats";
import { PrivacyPanel } from "../privacy-note";
import rulesCss from "./work-rules.module.css";
import css from "./settings.module.css";
import { WorkModel } from "../tasks/work-two";
import { ReviewSettings } from "../tasks/review-settings";
import { TABS, type SettingsData, type TabKey } from "./types";
import { SettingsNav } from "./nav";
import { SettingsHome } from "./home";
import { AccountList } from "./account-list";
import { AccountAccess } from "./account-access";
import { getAccess, getHrSetup, settingsAvailable } from "./data";
import { Security } from "../account/security";
import { ConnectedApps, DeveloperApps } from "./connected-apps";
import { DriveBackup } from "./drive-backup"; // COMPANY-OPS: Backup to Google Drive (admins)
import { ApiKeys } from "./api-keys";
import { ConnectAi } from "./connect-ai";
import { AiAccess } from "./ai-access";
import { oauthAddresses } from "../lib/oauth-web.mjs";
import { seesDeveloperApps } from "../lib/settings-access.mjs";
import { AboutYou } from "./about-you";
import { FindMeSettings, PublicProfileSettings } from "../directory/settings";

/** Shown in place of a tab whose data the service could not give, so the rest of Settings keeps working. */
function Unavailable({ what, error }: { what: string; error: string }) {
  return <section className={styles.panel}><Empty icon={Hourglass} first title={`${what} is not available yet`} text={`The settings service did not answer for this tab (“${error}”). Nothing has been changed; try again in a few minutes.`} /></section>;
}

export default async function Settings({ searchParams }: { searchParams: Promise<{ tab?: string; view?: string; pilot?: string; part?: string; google?: string }> }) {
  const query = await searchParams;
  const me = await getMe();
  if (me.error) return <Message text={me.error} />; if (!me.data) return null;
  const role = me.data.role, admin = role === "admin", hrOnly = role === "hr";
  // ROLE-FIX (QA-2 role walk): Connect your AI's "For your company" part reads /api/v0/ai, which is for admins and leadership
  // (connect-ai.ts leaders()); everyone else connects their own AI app there and reads who sets the company's up, without a refused call.
  const companyAi = admin || role === "leadership" || !!me.data.lead;
  if (query.tab === "roles" && !admin) return <Page fit><PageHeader title="Settings" context={["Roles & permissions"]} />
    <section className={styles.panel}><Empty icon={ShieldCheck} first title="Organisation admin access required"
      text="Ask an organisation admin to review your roles and permissions. Only organisation admins can open these settings. Your access has not changed."
      action={{ href: "/finance", label: "Back to Finance" }} /></section></Page>;
  // R54: HR of a company set up with the checklist reads it and signs off the pilot's walkthrough under Company → Setup.
  const hrSetup = hrOnly ? await getHrSetup() : null;
  // UX-SETTINGS-CHAT: who opens which section is lib/settings-access.mjs (unit-tested); a section a person cannot open
  // sends them to the Settings home. SETTINGS-APPLE: the layout's list reads the same (settings/data.ts, once a request).
  const available = settingsAvailable(role, !!hrSetup?.managed);
  const asked = query.tab === "roles" ? "work-rules" : query.tab;
  const found = available.find((t) => t.key === asked)?.key;

  // UX-SETTINGS-CHAT (owner, 5 Nov 2026): no section asked for (or one this person cannot open): the Settings home.
  if (!found) {
    const access = admin || hrOnly ? await getAccess() : null;
    const setup = admin ? await getHrSetup() : hrSetup;
    // SETTINGS-APPLE (judge: a member's link to Who can sign in "silently gets the home: a dead link"): say why.
    const closed = asked ? TABS.find((t) => t.key === asked)?.label : undefined;
    return <Page><SettingsHome me={me.data} access={access?.data ?? null} setupTrial={!!(setup?.managed && setup.company.activation === "trial")}
      notice={closed ? `${closed} is for your company’s admins. Here is everything you can change.` : undefined} available={available} /></Page>;
  }
  const tab: TabKey = found;
  const label = TABS.find((t) => t.key === tab)!.label;

  if (tab === "devices") {
    const r = query.pilot === "synthetic" ? null : await api<DevicesData>("sensing/desk"); const origin = installOrigin(await headers()); const downloads = await readDownloads(origin);
    // Admin and leadership also see every person's connected apps and tracking health, and run the tester programme.
    const team = admin || role === "leadership";
    const [health, testers, feedback] = team ? await Promise.all([api<HealthData>("devices/health"), api<TestersData>("testers"), api<{ rows: Feedback[] }>("feedback")]) : [null, null, null];
    // R54: while the company runs its pilot, everyone answers four questions once (anonymous, totals only).
    const pilot = query.pilot === "synthetic" ? null : (await api<PilotFeedbackState>("pilot-feedback")).data;
    // MOBILE-READY (1260): an admin signs a test phone in as themselves with a one-time code (no password on the phone).
    const extra = [...(admin && query.pilot !== "synthetic" ? [{ label: "Add a test device", content: <TestDevice /> }] : []), ...(pilot?.open ? [{ label: "Pilot feedback", content: <PilotFeedback initial={pilot} /> }] : []), ...(health?.data ? [{ label: "Devices & tracking health", content: <TrackingHealth data={health.data} /> }] : []), ...(testers?.data ? [{ label: "Invite testers", content: <Testers initial={testers.data} feedback={feedback?.data?.rows ?? []} /> }] : [])];
    return <Page fit><SettingsNav current="devices" available={available} label="Your devices" /><Devices initial={r?.data} synthetic={query.pilot === "synthetic"} error={r?.error} downloads={downloads} origin={origin} extra={extra} /></Page>;
  }

  // A person's own sections: one column at a readable width.
  // SETTINGS-APPLE (owner, 13 Nov 2026, T1.3.2: "your account should be as simple as that, a list of things"): Your
  // account is one short list; each longer part opens one step in, with its own breadcrumb (Your account › part):
  // Password & security, About you, Let people find me, and Google Calendar (only when this server has it switched on).
  const calendarOn = tab === "account" ? !!(await api<{ on?: boolean }>("calendar")).data?.on : false;
  const ACCOUNT_PARTS: Record<string, { label: string; lede: string }> = {
    // ACCOUNT-META (owner, 15 Nov 2026): the e-mails that sign you in (only yours, never a shared mailbox) and where.
    access: { label: "Account access", lede: "The e-mails that sign you in, and where you are signed in" },
    security: { label: me.data.via === "password" ? "Password & security" : "Security", lede: "Your password, where you are signed in, two-step, and the e-mail your codes go to" },
    about: { label: "About you", lede: "What describes you, and what this space was set up for" },
    find: { label: "Let people find me", lede: "Whether people in other companies can find you in search" },
    ...(calendarOn ? { calendar: { label: "Google Calendar", lede: "Your tasks and meetings on your own Google Calendar" } } : {}),
  };
  const part = tab === "account" && query.part && ACCOUNT_PARTS[query.part] ? query.part : null;
  const security = part === "security";
  if (tab === "account" || tab === "notifications" || tab === "appearance" || tab === "privacy") return <Page>
    <SettingsNav current={tab} available={available} part={part ? ACCOUNT_PARTS[part] : undefined} />
    <div className={security ? undefined : css.narrow} data-settings-section={part ?? tab}>
      {tab === "account" && !part ? <AccountList me={me.data} calendar={calendarOn} /> : null}
      {security ? <Security google={query.google} tab={query.view} /> : null}
      {part === "access" ? <AccountAccess /> : null}
      {/* SELF-SERVE (owner, 4 Nov 2026): the account's types (employed, practice, freelancer ...) under Your account. */}
      {part === "about" ? <AboutYou /> : null}
      {/* COMPANY-SEARCH: each person's own choice to show up in "Find companies and people" (off by default). */}
      {part === "find" ? <FindMeSettings /> : null}
      {/* GAP-FOUNDER-VIEW (PM-08): your own Google Calendar; only when the server switches it on. */}
      {part === "calendar" ? <CalendarCard /> : null}
      {/* RELEASE-3: notifications on this device, with Turn on and a test (everyone also has them in Notifications). */}
      {/* VITALS-SWEEP (22 Nov 2026; judge, phone 1: 150 words of device and Telegram text sat above the choices): what may ping you first. */}
      {tab === "notifications" ? <Panel title="Notifications"><div style={{ padding: "12px 16px" }}><MuteKinds /><NotificationStatus /><TelegramLink /><NewDotsSetting /></div></Panel> : null}
      {tab === "appearance" ? <Appearance /> : null}
      {tab === "privacy" ? <PrivacyPanel /> : null}
    </div>
  </Page>;

  if (tab === "data-health") { const r = await api<LeadData>("research"); if (r.error || !r.data) return <Message text={r.error ?? "Research observations unavailable"} />; return <Page fit><SettingsNav current="data-health" available={available} /><DataHealthView d={r.data} finance={me.data.financeAccess !== false} /></Page>; }
  // VITALS-SWEEP (speed): the tab's reads go out together (Work rules made three in a row, Organisation three: each one a
  // round trip to the API before the next started).
  const [modelRead, workRules, access, settings, rules, setup] = await Promise.all([
    tab === "work-rules" ? api<Parameters<typeof WorkModel>[0]["data"]>("work/settings") : null,
    tab === "work-rules" ? api<RulesData>("work/rules") : null,
    tab === "sign-in" ? getAccess() : null,
    admin && (tab === "work-rules" || tab === "team" || tab === "connected" || tab === "organisation") ? api<SettingsData>("settings") : null,
    tab === "organisation" && !hrOnly ? api<PolicyData>("hr/policy") : null,
    // R53: a company set up on this Pulse follows its setup checklist here (first while it is in trial).
    tab === "organisation" ? hrSetup ?? getHrSetup() : null,
  ]);
  // UX-TASKS-2: how Pulse names the work (leadership and admins change it) sits above Who can do what.
  const model = modelRead ? modelRead.data : null;
  const setupSection = setup?.managed ? { label: "Setup", content: <CompanySetupView initial={setup} /> } : null;
  return (
    <Page fit>
      <SettingsNav current={tab} available={available} />
      {access ? access.data ? <SignIn people={access.data.people ?? []} requests={access.data.requests ?? []} admin={admin} /> : <Unavailable what={label} error={access.error ?? "no data"} /> : null}
      {tab === "desktop-app" ? <DesktopBuildPanel /> : null}
      {tab === "industry" ? <IndustrySettings /> : null}
      {tab === "apps" ? <AppsSettings /> : null}
      {tab === "ai" ? <AiSettings /> : null}
      {tab === "servers" ? <ServersSettings /> : null}
      {/* CONNECTORS-CONTRACTS: connected apps (remote MCP servers) for the company's people and AI employees. */}
      {tab === "connectors" ? <ToolConnectors /> : null}
      {tab === "mail" ? <MailboxSettings /> : null}
      {tab === "chats" ? <ChatSettings /> : null}
      {tab === "connected-apps" ? <div style={{ display: "grid", gap: 16, alignContent: "start" }} data-grow="">{admin ? <DriveBackup /> : null}<ConnectedApps orgName={me.data.orgName ?? "your organisation"} />{seesDeveloperApps(role) ? <DeveloperApps /> : null}</div> : null}
      {/* AGENT-API: personal tokens for scripts and the pulse CLI (everyone), bot keys for AI members (admins). */}
      {tab === "api-keys" ? <ApiKeys origin={installOrigin(await headers()) ?? ""} /> : null}
      {/* DOCS-MCP: Settings → Connect your AI (steps for Claude, Claude Code and Gemini; keys made here). */}
      {/* AI-CONNECT: the MCP address discovery names for this host (oauth-web.mjs), so the copied address matches the sign-in. */}
      {tab === "connect-ai" ? (async () => { const origin = oauthAddresses(await headers() as unknown as Headers).mcp; return <ConnectAi origin={origin} appName={/vitals/i.test(origin) ? "Vitals" : "Pulse"} companyAi={companyAi} />; })() : null}
      {/* AI-ACCESS: every connected AI app across the companies this account manages, and what AI may do in each. */}
      {tab === "ai-access" ? (async () => <AiAccess appName={/vitals/i.test(oauthAddresses(await headers() as unknown as Headers).mcp) ? "Vitals" : "Pulse"} />)() : null}
      {hrOnly && tab === "organisation" && setupSection ? <Sections items={[setupSection]} /> : null}
      {workRules ? (() => {
        const rulesView = <div className={rulesCss.stack} data-grow="">{model ? <WorkModel data={model} /> : null}{model ? <ReviewSettings data={model} /> : null}{workRules.data ? <WorkRules data={workRules.data} /> : <Unavailable what={label} error={workRules.error ?? "no data"} />}</div>;
        if (!settings) return rulesView;
        const s = settings.data;
        return <Sections param="permissions" initial={query.tab === "roles" ? 1 : 0} items={[{ label: "Work rules", content: rulesView },
          { label: "Roles & permissions", content: s ? <Roles roles={s.roles ?? []} people={s.people ?? []} permissions={s.permissions ?? []} canGrant={!!s.canGrant} canEdit={!!s.canEdit} viewer={me.data.person} salaryList={s.salaryList} rules={workRules.data ?? null} /> : <Unavailable what="Roles & permissions" error={settings.error ?? "no data"} /> }]} />;
      })() : null}
      {settings && tab !== "work-rules" ? (() => {
        const s = settings.data; const missing = s ? null : <Unavailable what={label} error={settings.error ?? "no data"} />;
        if (tab === "team") return s ? <Team pods={s.pods ?? []} unassigned={s.unassigned ?? []} people={s.people ?? []} canEdit={!!s.canEdit} initialView={query.view === "lines" ? "lines" : "pods"} /> : missing;
        if (tab === "connected") return s ? <Connected sources={s.sources ?? []} sync={s.sync} runs={s.runs ?? []} connectors={!me.data.modules?.off?.includes("connectors")} /> : missing;
        // Company: the organisation's own settings. A person's appearance and notifications are sections of You now.
        // UX-SETTINGS-CHAT: Company's parts are chips under the section's header, not a second row of tabs.
        return <Sections chips label="Company parts" items={[
          ...(setupSection && setup?.managed && setup.company.activation === "trial" ? [setupSection] : []),
          // UI-POLISH-3: "Name & logo", not a third "Organisation" under the Organisation area and section.
          { label: "Name & logo", content: s?.org ? <Organisation org={s.org} canEdit={!!s.canEdit} /> : missing },
          // COMPANY-SEARCH: what everyone on Vitals sees about the company (name, @handle, logo and city by default).
          ...(admin ? [{ label: "Public profile", content: <PublicProfileSettings /> }] : []),
          // UX-TENANT: the organisation's module switches and accent; the platform operator also reaches Companies here.
          { label: "Modules", content: <ModulesSettings operator={!!me.data.operator} /> },
          { label: "Working rules", content: <WorkingRules data={rules?.data} error={rules?.error} /> },
          // PEOPLE-CONTACTS: the organisation's own contact and client types (admins add, rename, recolour, archive).
          { label: "Contact & client types", content: <TypesSettings /> },
          ...(setupSection && setup?.managed && setup.company.activation === "live" ? [setupSection] : []),
        ]} />;
      })() : null}
    </Page>
  );
}
