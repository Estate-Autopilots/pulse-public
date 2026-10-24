import Link from "next/link";
import { CircleAlert, Handshake } from "lucide-react";
import { SidebarLink, SidebarSection } from "@pulse/ui-shell";
import { api, apiV1, getMe, type DeliveryClaimsResponse, type EditorList, type EditorWeekResponse, type Insights, type PersonRow } from "../lib/api";
import { apiPeriod, count, isoWeek, plural, type PeriodParams } from "../lib/format";
import { type FieldDef } from "../records";
import { Message, Page, PageHeader, QueryTabs, styles } from "../ui";
import { PeriodSwitcher } from "../period-switcher";
import { AccountClaimsReview, type UploaderAccountClaim } from "../account-claims/panels";
import { editorTargetsFromWeek } from "./accounts/targets";
import { Tracking, type TargetedEditor } from "./tracking";
import { Directory } from "./directory";
import { POD_TEAM } from "../pod-team";
import { EMPLOYMENT } from "./shared";
import { AddMember } from "./add-member";
import type { AiTeamRow } from "./ai-rows";

const FLAG: Record<string, string> = { pod: "pod", role: "role", status: "still here?", joined_on: "joined", identity: "name" };

export default async function Team({ searchParams }: { searchParams: Promise<PeriodParams & { tab?: string; view?: string; pod?: string; team?: string; status?: string; add?: string }> }) {
  const query = await searchParams;
  const accountsView = query.tab === "tracking" && query.view === "accounts";
  const [r, insights, editorResult, viewerResult, connResult] = await Promise.all([
    api<{ attendanceEnabled?: boolean; people: PersonRow[]; pods: string[]; canEdit: boolean; viewer: string | null }>("people"),
    api<Insights>("insights"),
    accountsView ? api<EditorList>(`editors${apiPeriod(query)}`) : Promise.resolve(null),
    getMe(),
    // FEATURES-1024 (CONNECT 2): the connected organisations and their contacts, beside the team.
    api<{ connections: { id: string; other: { name: string }; theirs: { person: string; name: string }[] }[] }>("connections"),
  ]);
  const connected = (connResult?.data?.connections ?? []).filter((c) => c.theirs?.length);
  const editorList = editorResult && "data" in editorResult ? editorResult.data ?? null : null;
  const reviewer = viewerResult && "data" in viewerResult ? viewerResult.data : null;
  const canReviewAccountClaims = Boolean(reviewer && ["admin", "hr", "leadership", "manager", "pgs"].includes(reviewer.role));
  const canReviewDeliveryClaims = Boolean(editorList && reviewer && ["admin", "manager", "pgs"].includes(reviewer.role));
  const claimWeek = editorList?.period.week ?? (editorList ? isoWeek(editorList.period.from) : null);
  // EST-1737: AI employees are listed for leaders and admins only; the API refuses everyone else, so they are never asked.
  const leader = Boolean(reviewer && ["admin", "leadership"].includes(reviewer.role));
  const [accountClaimsResult, deliveryClaimsResult, aiResult] = await Promise.all([
    query.tab === "tracking" && canReviewAccountClaims
      ? apiV1<{ claims: UploaderAccountClaim[] }>("/v1/accounts/claims?status=pending")
      : Promise.resolve(null),
    canReviewDeliveryClaims && claimWeek
      ? apiV1<DeliveryClaimsResponse>(`/v1/deliveries/claims?week=${encodeURIComponent(claimWeek)}&status=pending`)
      : Promise.resolve(null),
    leader ? api<{ agents: AiTeamRow[] }>("agents/team") : Promise.resolve(null),
  ]);
  const editorAccounts: TargetedEditor[] | null = editorList ? await Promise.all(editorList.accounts.map(async (account) => {
    const targetWeek = editorList.period.week ?? isoWeek(editorList.period.from);
    const targetResult = account.holder_person_id && !account.sharedLogin
      ? await apiV1<EditorWeekResponse>(`/v1/editors/${encodeURIComponent(account.holder_person_id)}/week?week=${encodeURIComponent(targetWeek)}`)
      : null;
    return { ...account, targets: editorTargetsFromWeek(targetResult && "data" in targetResult ? targetResult.data ?? null : null) };
  })) : null;
  // Tracking shows the whole team's signals, so it is for organisation admins; everyone sees their own on My desk.
  const tracking = insights.data; const tab = query.tab === "tracking" && (tracking || canReviewAccountClaims) ? "tracking" : "directory";
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
  const active = people.filter((p) => p.status === "active").length; const flagged = people.filter((p) => p.flags.length).length; const toConfirm = people.filter((p) => p.status === "active" && p.flags.length).length;
  const teams = [...new Set(people.map((p) => p.department).filter((t): t is string => !!t))].sort();
  const fields: FieldDef[] = [
    { key: "name", label: "Full name", required: true, wide: true, section: "Who" }, { key: "role", label: "Role", required: true, placeholder: "e.g. Video editor" },
    { key: "employmentType", label: "Employment", type: "select", options: Object.entries(EMPLOYMENT).map(([value, label]) => ({ value, label })) },
    { key: "pod", label: "Pod", type: "choice", options: pods.map((value) => ({ value, label: value })), section: "Where they work", hint: POD_TEAM.pod },
    { key: "department", label: "Team", suggest: teams, placeholder: "e.g. Creative", hint: "The function. Pick one in use or type a new one." },
    { key: "managerId", label: "Reports to", type: "select", options: people.filter((p) => p.status === "active").map((p) => ({ value: p.id, label: p.name })).sort((a, b) => a.label.localeCompare(b.label)), hint: "Their manager approves leave and corrections." },
    { key: "joinedOn", label: "Joined on", type: "date" }, { key: "workLocation", label: "Work location", suggest: ["Office", "Remote", "Hybrid"], placeholder: "Office, Remote, Hybrid" },
    { key: "email", label: "Work e-mail", type: "email", section: "Work contact", placeholder: "name@company.com", hint: "Enter the full work e-mail address." }, { key: "phone", label: "Work phone", type: "tel" },
    { key: "notes", label: "Notes", type: "textarea", placeholder: "Anything the team should know: shift, tools, start plan…" },
  ];
  return (
    <Page fit>
      <PageHeader title="Team" context={[`${count(active)} current`, `${count(people.length)} on record`, canEdit && toConfirm ? `${plural(toConfirm, "current record")} to confirm` : null, ai && !aiError ? `AI ${count(ai.length)}` : null]}
        actions={<><Link className={styles.btn} href="/people/org">Org chart</Link>{reviewer && ["hr", "leadership", "admin"].includes(reviewer.role) ? <Link className={styles.btn} href="/people/pay">People &amp; pay</Link> : null}{accountsView && editorList ? <PeriodSwitcher period={editorList.period} /> : null}{canEdit ? <AddMember admin={reviewer?.role === "admin"} fields={fields} owners={people.filter((p) => p.status === "active").map((p) => ({ value: p.id, label: p.name })).sort((a, b) => a.label.localeCompare(b.label))} defaultOpen={query.add === "member"} /> : null}</>} />
      {tracking || canReviewAccountClaims ? <QueryTabs base="/people" items={[{ key: "directory", label: "Directory" }, { key: "tracking", label: "Tracking" }]} current={tab} /> : null}
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
