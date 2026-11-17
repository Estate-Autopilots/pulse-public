import Link from "next/link";
import { Bot, CircleAlert, Handshake, MoreHorizontal, ShieldCheck, Wallet } from "lucide-react";
import { Menu, type MenuItem } from "../kit";
import { SidebarLink, SidebarSection } from "@pulse/ui-shell";
import { api, vocabulary, apiV1, getMe, insightsFor, seesInsights, type DeliveryClaimsResponse, type EditorList, type EditorWeekResponse, type PersonRow } from "../lib/api";
import { apiPeriod, count, isoWeek, plural, type PeriodParams } from "../lib/format";
import { type FieldDef } from "../records";
import { Message, Page, PageHeader, QueryTabs, styles } from "../ui";
import { PeriodSwitcher } from "../period-switcher";
import { AccountClaimsReview, type UploaderAccountClaim } from "../account-claims/panels";
import { editorTargetsFromWeek } from "./accounts/targets";
import { Tracking, type TargetedEditor } from "./tracking";
import { Directory } from "./directory";
import { podTeam } from "../pod-team";
import { EMPLOYMENT } from "./shared";
import { AddPeopleButton } from "./add/add-flow";
import type { AiTeamRow } from "./ai-rows";

const FLAG: Record<string, string> = { pod: "pod", role: "role", status: "still here?", joined_on: "joined", identity: "name" };

export default async function Team({ searchParams }: { searchParams: Promise<PeriodParams & { tab?: string; view?: string; pod?: string; team?: string; status?: string; add?: string }> }) {
  const query = await searchParams;
  const tracked = query.tab === "tracking";
  const accountsView = tracked && query.view === "accounts";
  // SPEED-3 (16 Nov 2026: /people waited 1.4-3.2 s for its first byte in production): every read starts at once. The
  // list and the connections no longer wait for the person's own record (the vocabulary read it first), the AI team
  // starts as soon as the person is known instead of after the list, and the company-wide figures (/insights, 162 /
  // 517 ms p50 / p90 on the server) are read only on Tracking, which shows them; the directory only needs to know whether
  // the Tracking tab exists, and seesInsights() is the API's own rule for that (insights.ts: leadership).
  const viewerP = getMe();
  const leaderP = viewerP.then((v) => Boolean(v.data && ["admin", "leadership"].includes(v.data.role)));
  const [r, insights, editorResult, viewerResult, connResult, words, aiResult] = await Promise.all([
    api<{ attendanceEnabled?: boolean; people: PersonRow[]; pods: string[]; canEdit: boolean; viewer: string | null }>("people"),
    tracked ? insightsFor() : Promise.resolve(null),
    accountsView ? api<EditorList>(`editors${apiPeriod(query)}`) : Promise.resolve(null),
    viewerP,
    // FEATURES-1024 (CONNECT 2): the connected organisations and their contacts, beside the team.
    api<{ connections: { id: string; other: { name: string }; theirs: { person: string; name: string }[] }[] }>("connections"),
    vocabulary(),
    // EST-1737: AI employees are listed for leaders and admins only; the API refuses everyone else, so they are never asked.
    leaderP.then((leader) => leader ? api<{ agents: AiTeamRow[] }>("agents/team") : null),
  ]);
  const connected = (connResult?.data?.connections ?? []).filter((c) => c.theirs?.length);
  const editorList = editorResult && "data" in editorResult ? editorResult.data ?? null : null;
  const reviewer = viewerResult && "data" in viewerResult ? viewerResult.data : null;
  const canReviewAccountClaims = Boolean(reviewer && ["admin", "hr", "leadership", "manager", "pgs"].includes(reviewer.role));
  const canReviewDeliveryClaims = Boolean(editorList && reviewer && ["admin", "manager", "pgs"].includes(reviewer.role));
  const claimWeek = editorList?.period.week ?? (editorList ? isoWeek(editorList.period.from) : null);
  const leader = Boolean(reviewer && ["admin", "leadership"].includes(reviewer.role));
  const [accountClaimsResult, deliveryClaimsResult] = await Promise.all([
    tracked && canReviewAccountClaims
      ? apiV1<{ claims: UploaderAccountClaim[] }>("/v1/accounts/claims?status=pending")
      : Promise.resolve(null),
    canReviewDeliveryClaims && claimWeek
      ? apiV1<DeliveryClaimsResponse>(`/v1/deliveries/claims?week=${encodeURIComponent(claimWeek)}&status=pending`)
      : Promise.resolve(null),
  ]);
  const editorAccounts: TargetedEditor[] | null = editorList ? await Promise.all(editorList.accounts.map(async (account) => {
    const targetWeek = editorList.period.week ?? isoWeek(editorList.period.from);
    const targetResult = account.holder_person_id && !account.sharedLogin
      ? await apiV1<EditorWeekResponse>(`/v1/editors/${encodeURIComponent(account.holder_person_id)}/week?week=${encodeURIComponent(targetWeek)}`)
      : null;
    return { ...account, targets: editorTargetsFromWeek(targetResult && "data" in targetResult ? targetResult.data ?? null : null) };
  })) : null;
  // Tracking shows the whole team's signals, so it is for organisation admins; everyone sees their own on My desk.
  const tracking = insights?.data ?? null; const tab = tracked && (tracking || canReviewAccountClaims) ? "tracking" : "directory";
  // The Tracking tab is offered to whoever the API shows the figures to (seesInsights) or who reviews account claims.
  const trackingTab = seesInsights(reviewer) || canReviewAccountClaims;
  if (r.error) return <Message text={r.error} />; if (!r.data) return null;
  const { people, canEdit, viewer } = r.data; const pods = r.data.pods ?? [];
  const accountClaims = accountClaimsResult && "data" in accountClaimsResult
    ? (accountClaimsResult.data?.claims ?? []).filter((claim) => claim.personId !== viewer)
    : [];
  const accountClaimsError = accountClaimsResult && "error" in accountClaimsResult ? accountClaimsResult.error : undefined;
  const deliveryClaims = deliveryClaimsResult && "data" in deliveryClaimsResult ? deliveryClaimsResult.data?.claims ?? [] : [];
  const deliveryClaimsError = deliveryClaimsResult && "error" in deliveryClaimsResult ? deliveryClaimsResult.error : undefined;
  const aiError = Boolean(aiResult?.error);
  const ai = leader ? aiResult?.data?.agents ?? [] : null;
  const active = people.filter((p) => p.status === "active").length; const flagged = people.filter((p) => p.flags.length).length; // HR-PEOPLE: records to confirm are the directory's "N to check" chip, not a second line in the header.
  const teams = [...new Set(people.map((p) => p.department).filter((t): t is string => !!t))].sort();
  const fields: FieldDef[] = [
    { key: "name", label: "Full name", required: true, wide: true, section: "Who" }, { key: "role", label: "Role", required: true, placeholder: "e.g. Video editor" },
    { key: "employmentType", label: "Employment", type: "select", options: Object.entries(EMPLOYMENT).map(([value, label]) => ({ value, label })) },
    { key: "pod", label: words.team, type: "choice", options: pods.map((value) => ({ value, label: value })), section: "Where they work", hint: podTeam(words).pod },
    { key: "department", label: "Team", suggest: teams, placeholder: "e.g. Creative", hint: "The function. Pick one in use or type a new one." },
    { key: "managerId", label: "Reports to", type: "select", options: people.filter((p) => p.status === "active").map((p) => ({ value: p.id, label: p.name })).sort((a, b) => a.label.localeCompare(b.label)), hint: "Their manager approves leave and corrections." },
    { key: "joinedOn", label: "Joined on", type: "date" }, { key: "workLocation", label: "Work location", suggest: ["Office", "Remote", "Hybrid"], placeholder: "Office, Remote, Hybrid" },
    { key: "email", label: "Work e-mail", type: "email", section: "Work contact", placeholder: "name@company.com", hint: "Enter the full work e-mail address." }, { key: "phone", label: "Work phone", type: "tel" },
    { key: "notes", label: "Notes", type: "textarea", placeholder: "Anything the team should know: shift, tools, start plan…" },
  ];
  return (
    <Page fit>
      <PageHeader title="Team" context={[`${count(active)} current`, `${count(people.length - active)} past`, ai && !aiError ? `${count(ai.length)} AI ${ai.length === 1 ? "employee" : "employees"}` : null]}
        actions={<>{reviewer && ["hr", "leadership", "admin"].includes(reviewer.role) ? <AddPeopleButton key={query.add ?? ""} admin={reviewer.role === "admin"} record={canEdit} fields={fields} owners={people.filter((p) => p.status === "active").map((p) => ({ value: p.id, label: p.name })).sort((a, b) => a.label.localeCompare(b.label))} open={query.add} /> : null}<Link className={styles.btn} href="/people/org">Org chart</Link>{(() => {
          // HR-PEOPLE (owner, 13 Nov 2026, T1.1.8): two main actions (Add people, Org chart); the rest under More.
          const more: MenuItem[] = [
            ...(reviewer && ["hr", "leadership", "admin"].includes(reviewer.role) && reviewer.hrAccess !== false ? [{ key: "pay", label: "People & pay", hint: "Pay, offers and the pay policy", icon: <Wallet size={15} aria-hidden="true" />, href: "/people/pay" }] : []),
            ...(ai && !aiError && ai.length ? [{ key: "ai", label: "AI employees", hint: "AI helpers that do tasks for you", icon: <Bot size={15} aria-hidden="true" />, href: "/people/ai" }] : []),
            ...(reviewer?.role === "admin" ? [{ key: "access", label: "Who can do what", hint: "Roles and permissions", icon: <ShieldCheck size={15} aria-hidden="true" />, href: "/people/access" }] : []),
          ];
          return more.length === 1 ? <Link className={styles.btn} href={more[0].href!}>{more[0].icon}{more[0].label}</Link> : more.length ? <Menu label="More on Team" buttonLabel="More on Team" title="More" className={styles.btn} items={more}><MoreHorizontal size={16} aria-hidden="true" />More</Menu> : null;
        })()}{accountsView && editorList ? <PeriodSwitcher period={editorList.period} /> : null}</>} />
      {trackingTab ? <QueryTabs base="/people" items={[{ key: "directory", label: "Directory" }, { key: "tracking", label: "Tracking" }]} current={tab} /> : null}
      {tab === "tracking" && tracking ? <Tracking
        people={people} insights={tracking} attendanceEnabled={r.data.attendanceEnabled === true}
        view={query.view === "accounts" ? "accounts" : query.view === "claims" && canReviewAccountClaims ? "claims" : "people"}
        editorAccounts={editorAccounts} editorPeriod={editorList?.period ?? null} editorAttribution={editorList?.attribution ?? null}
        canReviewClaims={canReviewAccountClaims} accountClaims={accountClaims} accountClaimsError={accountClaimsError}
        canReviewDeliveryClaims={canReviewDeliveryClaims} pendingClaims={deliveryClaims} deliveryClaimsError={deliveryClaimsError}
      /> : tab === "tracking" && canReviewAccountClaims
        ? <AccountClaimsReview claims={accountClaims} error={accountClaimsError} />
        : <Directory people={people} pods={pods} viewer={viewer} staff={canEdit} attendanceEnabled={r.data.attendanceEnabled === true} pod={query.pod} team={query.team} status={query.status === "past" || query.status === "alumni" ? "past" : query.status === "all" ? "all" : undefined} ai={ai} aiError={aiError} />}
      {tab === "directory" && connected.length ? <SidebarSection title="Connected organisations">{connected.map((c) => (
        <SidebarLink key={c.id} href="/connections" label={c.other.name} note={c.theirs.map((t) => t.name).join(", ")} icon={<Handshake size={14} aria-hidden="true" />} />
      ))}</SidebarSection> : null}
      {canEdit && flagged ? <SidebarSection title="To confirm">{people.filter((p) => p.flags.length).map((p) => (
        <SidebarLink key={p.id} href={`/people/${p.id}`} label={p.name} note={p.flags.map((f) => FLAG[f] ?? f).join(", ")} icon={<CircleAlert size={14} aria-hidden="true" />} />
      ))}</SidebarSection> : null}
    </Page>
  );
}
