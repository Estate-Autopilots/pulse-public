// UX-SETTINGS-CHAT (owner, 5 Nov 2026): the Settings home. SETTINGS-APPLE (owner, 13 Nov 2026, T1.3.1/T1.3.2): the list
// of sections moved to the left pane, so the home is the right pane's overview.
// PULSE-POLISH (owner, 14 Nov 2026: "When we go to the Settings page it shows a very blank and blunt page. It looks
// terrible."): the overview is an account home, as Apple's and Google's are (Codex concept 1, picked):
//   - who you are: your photo (the stored one, initials only when there is none), name, role and company;
//   - a search over every setting you can open;
//   - what needs you (only when something does), else one quiet "nothing needs you" line;
//   - the eight settings people change most, each as a card with its CURRENT value (theme, notifications on this device,
//     two-step, your companies, who can sign in …), so the page answers "how is it set?" before anything is opened.
// No "Change password" here ("why do you have change password in here?"): it sits under Your account › Password &
// security, and its card says how you sign in.
import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { Check, ChevronRight, Layers } from "lucide-react";
import { CalmPage } from "../components/page-kit";
import { Avatar } from "../avatar";
import css from "./settings.module.css";
import type { Me } from "../lib/api";
import type { AccessData, TabKey } from "./types";
import { AREAS, TAB_TEXT } from "./types";
import { TAB_ICON } from "./icons";
import { DeviceValue, SettingsSearch, type SearchItem } from "./home-live";

const NO_SIGN_IN = ["not invited", "invited", "link expired", "locked"];
const LEADS = new Set(["admin", "hr", "leadership"]);
const ROLE: Record<string, string> = { admin: "Organisation admin", hr: "HR", leadership: "Leadership", finance: "Finance", manager: "Manager", member: "Member", person: "Member", accountant: "Accountant" };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** Words people type for a section that its name does not say. */
const KEYWORDS: Partial<Record<TabKey, string>> = {
  account: "profile name username photo picture password two-step 2fa security sessions about find me calendar",
  appearance: "theme dark light mode colours fun effects confetti", notifications: "alerts ping sound telegram mute push",
  privacy: "telemetry measure data", devices: "phone app computer download install", "connected-apps": "oauth sign in with pulse",
  "sign-in": "invite invitation reset password locked two-step access", "work-rules": "permissions roles who can", team: "pods departments reports to manager",
  organisation: "company name logo modules working rules holidays types", mail: "email mailbox smtp", connected: "google drive gmail sync",
  ai: "claude openai model", "connect-ai": "mcp chatgpt claude gemini", "api-keys": "token cli bot",
};

type Card = { key: string; label: string; value: ReactNode; href: string; icon: TabKey; hue: number; tone?: "warn" };

export function SettingsHome({ me, access, setupTrial, notice, available }: { me: Me; access: AccessData | null; setupTrial: boolean; /** A section was asked for that this person cannot open. */ notice?: string;
  /** The sections this person may open (the search and the cards only offer those). */ available: readonly { key: TabKey; label: string }[] }) {
  const people = access?.people ?? [];
  const pending = (access?.requests ?? []).filter((r) => r.status === "pending").length;
  const cannot = people.filter((p) => NO_SIGN_IN.includes(p.authStatus ?? "not invited")).length;
  const leadsNoTwoStep = people.filter((p) => LEADS.has(p.role) && p.authStatus === "active" && !p.twoStep).length;
  const org = me.orgName ?? "Your company";
  const role = ROLE[me.role] ?? me.role;
  const has = new Map(available.map((t) => [t.key, t.label])); // the team card says the company's own word for teams (DE-EA)
  const hueOf = (k: TabKey) => AREAS.find((a) => (a.tabs as readonly string[]).includes(k))?.hue ?? 222;

  const picks: { key: string; title: string; sub: string; href: string }[] = [];
  if (setupTrial) picks.push({ key: "setup", title: `Finish setting up ${org}`, sub: "The setup checklist, while the company is on trial", href: "/settings?tab=organisation" });
  if (me.twoStepSetup) picks.push({ key: "mine", title: "Turn on two-step for your account", sub: "Your company asks for it; it takes a minute", href: "/settings?tab=account&part=security" });
  if (access) {
    if (pending) picks.push({ key: "requests", title: `${plural(pending, "password request")} waiting`, sub: "Someone cannot sign in until you answer", href: "/settings?tab=sign-in" });
    if (cannot) picks.push({ key: "cannot", title: `${plural(cannot, "person", "people")} cannot sign in yet`, sub: "Send their invitations, or a fresh link", href: "/settings?tab=sign-in" });
    if (leadsNoTwoStep) picks.push({ key: "two-step", title: `${plural(leadsNoTwoStep, "leader")} without two-step`, sub: "Admins, HR and leadership see the most", href: "/settings?tab=sign-in" });
  }

  // How this person signs in, and whether two-step is on (known for admins and HR, who read the sign-in list).
  const mine = people.find((p) => p.id === me.person);
  const companies = me.account?.orgs?.length ?? 0;
  const cards: Card[] = [
    { key: "security", label: me.via === "password" ? "Password & security" : "Security", icon: "account", hue: 222, href: "/settings?tab=account&part=security",
      value: me.twoStepSetup ? "Two-step not set up" : mine?.twoStep ? "Two-step on" : me.via === "password" ? "Signs in with a password" : "Signs in with Google", tone: me.twoStepSetup ? "warn" : undefined },
    { key: "notifications", label: "Notifications", icon: "notifications", hue: hueOf("notifications"), href: "/settings?tab=notifications", value: <DeviceValue kind="notifications" /> },
    { key: "appearance", label: "Appearance", icon: "appearance", hue: hueOf("appearance"), href: "/settings?tab=appearance", value: <DeviceValue kind="theme" /> },
    // While Needs you says who cannot sign in, this card would repeat it (judge): it shows only when all is well.
    ...(has.has("sign-in") && access && !cannot && !pending ? [{ key: "sign-in", label: "Who can sign in", icon: "sign-in" as TabKey, hue: hueOf("sign-in"), href: "/settings?tab=sign-in",
      value: `All ${plural(people.length, "person", "people")} can sign in` }] : []),
    ...(has.has("organisation") ? [{ key: "organisation", label: "Company", icon: "organisation" as TabKey, hue: hueOf("organisation"), href: "/settings?tab=organisation", value: org }] : []),
    ...(companies > 1 ? [{ key: "companies", label: "Your companies", icon: "organisation" as TabKey, hue: 265, href: "/orgs", value: `${companies} companies` }] : []),
    ...(has.has("team") ? [{ key: "team", label: has.get("team")!, icon: "team" as TabKey, hue: hueOf("team"), href: "/settings?tab=team", value: `${me.workLabels?.teams ?? "Teams"} and managers` }] : []),
    { key: "devices", label: "Devices", icon: "devices", hue: hueOf("devices"), href: "/settings?tab=devices", value: "Phone and computer apps" },
    ...(has.has("connected-apps") ? [{ key: "connected-apps", label: "Apps you sign in to", icon: "connected-apps" as TabKey, hue: hueOf("connected-apps"), href: "/settings?tab=connected-apps", value: "Apps using your sign-in" }] : []),
    { key: "privacy", label: "Privacy", icon: "privacy", hue: hueOf("privacy"), href: "/settings?tab=privacy", value: "What Pulse measures, and never records" },
  ];
  const shown = cards.slice(0, 8);

  const search: SearchItem[] = available.map((t) => ({ key: t.key, label: t.label, area: AREAS.find((a) => (a.tabs as readonly string[]).includes(t.key))?.label ?? "You",
    text: TAB_TEXT[t.key].replace(/\{(\w+)\}/g, "$1"), words: KEYWORDS[t.key] ?? "", href: `/settings?tab=${t.key}` }));
  search.splice(1, 0, { key: "security", label: me.via === "password" ? "Password & security" : "Security", area: "You", text: "Change your password, two-step, where you are signed in", words: "password two-step 2fa sessions sign out", href: "/settings?tab=account&part=security" });

  return <CalmPage>
    <div className={css.ov} data-settings-overview="" data-needs={picks.length ? "" : undefined}>
      <section className={css.ovWho} aria-label="Your account">
        <Avatar name={me.name || "You"} id={me.person} photoAt={me.photoAt} size={72} />
        <div className={css.ovWhoText}>
          <h1 className={css.ovName}>{me.name || "Your account"}</h1>
          <p className={css.ovRole}>{role} · {org}</p>
          {me.username ? <p className={css.ovHandle}>@{me.username}</p> : null}
        </div>
        <Link href="/settings?tab=account" className={css.ovEdit}>Your account<ChevronRight size={15} aria-hidden="true" /></Link>
      </section>
      {/* A section someone cannot open says why, under who they are. */}
      {notice ? <p role="status" className={css.homeNotice}>{notice}</p> : null}
      <SettingsSearch items={search} />
      {picks.length ? <section className={css.ovNeeds} aria-label="Needs you">
        <h2 className={css.ovHead}>Needs you</h2>
        <ul>{picks.map((p) => <li key={p.key}><Link href={p.href} className={css.ovNeed}><span className={css.ovDot} aria-hidden="true" />
          <span><b>{p.title}</b><small>{p.sub}</small></span><ChevronRight size={16} aria-hidden="true" /></Link></li>)}</ul>
      </section> : <p className={css.ovAllSet}><Check size={16} aria-hidden="true" />Nothing needs you right now.</p>}
      <section aria-label="Most used" className={css.ovMost}>
        <h2 className={css.ovHead}><Layers size={16} aria-hidden="true" />Most used</h2>
        <ul className={css.ovCards}>{shown.map((c) => { const Icon = TAB_ICON[c.icon]; return <li key={c.key}>
          <Link href={c.href} className={css.ovCard} data-settings-card={c.key}>
            <span className={css.ovTile} style={{ "--hue": c.hue } as CSSProperties} aria-hidden="true"><Icon size={17} strokeWidth={2.1} /></span>
            <span className={css.ovCardText}><span className={css.ovLabel}>{c.label}</span><b className={css.ovValue} data-tone={c.tone}>{c.value}</b></span>
            <ChevronRight size={16} className={css.ovGo} aria-hidden="true" />
          </Link></li>; })}</ul>
      </section>
    </div>
  </CalmPage>;
}
