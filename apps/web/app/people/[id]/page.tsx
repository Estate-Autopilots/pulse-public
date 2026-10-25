import Link from "next/link";
import { Fragment } from "react";
import { AtSign, CalendarDays, CircleAlert, Ellipsis, FileLock2, FileText, FolderKanban, Inbox, Lock, MapPin, Network, ShieldCheck, UserRound, UserRoundSearch, UsersRound, Info, Activity, ListChecks, History as HistoryIcon } from "lucide-react";
import { RecentVisit } from "@pulse/ui-shell";
import { api, type FieldSource, type HrRecord, type PersonDetail, type PersonRow } from "../../lib/api";
import { ago, apiPeriod, count, dayTime, dayYear, plural, range, userId, type PeriodParams } from "../../lib/format";
import { SkillsEditor } from "../../hr/actions";
import { AttendanceLeaveTab, PerformancePanel } from "../../hr/person-tab";
import type { PersonHr } from "../../hr/types";
import { Deck } from "../../fit";
import { PeriodSwitcher } from "../../period-switcher";
import { POD_TEAM } from "../../pod-team";
import { LinkAccount, LoginActions, PhotoControls, RecordForm, type FieldDef } from "../../records";
import { LinkedCalls } from "../../apps/sales-xray/linked";
import { Avatar, Badge, DeliveryFeed, Empty, Fact, Fit, History, Message, Page, Panel, QueryTabs, styles, Workspace } from "../../ui";
import { ProfileHeader } from "../../profile-header";
import { MyInfo, type MyInfoData } from "./my-info";
import { PulseKnows } from "../../me/pulse-knows";
import type { MyPulse } from "../../me/my-pulse";
import { SkillsTab, type CvData, type MyChecks, type MyWork, type SkillProfile } from "./skills";
import { DeliveriesPanel, ProjectsPanel, WeekTiles } from "../../weekly-views";
import { FlagActions, SalaryTable } from "../hr";
import { CopyId, ReportingLine } from "../parts";
import { EvidenceDeliveries, Mark, Missing, ProjectList, TaskList, WorkDocuments, WorkSummary, type PersonWork } from "../work";
import css from "../people.module.css";
import { DomainsPanel, type DomainsView } from "../../tasks/domains-panel";
import { EMPLOYMENT as TYPES, tenure } from "../shared";
import { MoveButton } from "../../hr/moves/move";
import { LEFT_LABEL, STAGE_LABEL, type PersonLifecycle } from "../../hr/moves/types";
import { LifecycleTimeline } from "../lifecycle";
import { ProofOpen, ProofViewer, type ProofItem } from "../../tasks/proof-viewer";
import { readBrand } from "../../lib/brand-server";
import { CarriedProfile, type Carried } from "../../orgs/carried";
import { AiBadge, Menu } from "../../kit";
import { AiTab, type AiDetail } from "../ai/[id]/parts";
import { WaChatsSection, WaInsightKpis } from "../../chats/whatsapp/wa";
import { AUTONOMY, KINDS, PROVIDER, THINKING, TOOL_LABEL, modelName } from "../ai/[id]/model";

const fileProof = (f: { id: string; title: string }): ProofItem => ({ id: f.id, kind: "document", label: f.title, url: null, src: `/api/v0/people/files/${f.id}` });

// AI-EMPLOYEES v2: an AI employee has this same profile; "ai" is its extra section.
const TABS = ["overview", "ai", "info", "skills", "work", "domains", "projects", "chats", "deliveries", "salesxray", "attendance", "hr", "documents"] as const;
type AiEmployee = { id: string; employeeId: string; status: "on" | "paused" | "off"; pausedReason: string | null; dailyBudget: number; usedToday: number };
type Tab = typeof TABS[number];
const STATUS: Record<string, { label: string; tone: "success" | "warning" | "neutral" }> = { active: { label: "Current", tone: "success" }, inactive: { label: "Not in current lists", tone: "warning" }, offboarded: { label: "Left", tone: "neutral" } };
const FLAG_FIELD: Record<string, string> = { pod: "Pod", role: "Role", status: "Still here?", joined_on: "Joining date", identity: "Name" };
const DOCS: Record<string, string> = { appointment_letter: "Appointment letter", joining_letter: "Joining letter", offer_letter: "Offer letter", salary_certificate: "Salary certificate", relieving_letter: "Relieving letter", resume: "CV" };
const ID_DOCS: [string, string][] = [["id_aadhaar", "Aadhaar"], ["id_pan", "PAN"], ["id_passport", "Passport"], ["bank_details", "Bank details"]];
const RESOURCE: Record<string, string> = { "hr.salary": "Salary history", "hr.contact": "Personal contact", "hr.documents": "Documents" };

/** Where a field's value comes from, for HR and admins. */
function Prov({ source }: { source?: FieldSource }) {
  if (!source) return null;
  const text = `${source.source}${source.detail ? `. ${source.detail}` : ""}`;
  // Where a value comes from is one quiet mark beside it; only a value that still needs confirming says so in words.
  return source.confirm ? <span className={css.prov} data-confirm="">To confirm · {text}</span>
    : <span className={css.provMark} title={`How Pulse knows: ${text}`} aria-label={`How Pulse knows: ${text}`} tabIndex={0}><Info size={12} aria-hidden="true" /></span>;
}

export default async function Profile({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<PeriodParams & { tab?: string; month?: string; s?: string }> }) {
  const { id } = await params; const query = await searchParams;
  let tab: Tab = TABS.includes(query.tab as Tab) ? query.tab as Tab : "overview";
  // LAYOUT-SWEEP (Documents in under a second): the record asks only for what the open tab shows (`for`), and every
  // further read starts at once, side by side, instead of one after another.
  const period = apiPeriod(query);
  // E2E-4P (the AI tab took 24-28 s on pulse-dev): a link to an AI's tab reads the AI's settings, run log and pickers
  // side by side with the profile instead of after it, and the staff list is read once for the pickers and the form.
  const enc = encodeURIComponent(id);
  let lite: Promise<{ people: PersonRow[]; pods: string[] } | undefined> | null = null;
  const litePeople = () => (lite ??= api<{ people: PersonRow[]; pods: string[] }>("people?lite=1").then((x) => x.data));
  const early = tab === "ai" ? [api<AiEmployee>(`agents/${enc}`).then((x) => x.data ?? null), api<AiDetail>(`agents/${enc}/detail`).then((x) => x.data ?? null), litePeople()] as const : null;
  const r = await api<PersonDetail>(`people/${enc}${period}${period ? "&" : "?"}for=${tab}`);
  if (r.error) return <Message text={r.error} />; const p = r.data as PersonDetail & { agent?: boolean; employeeId?: string | null }; if (!p) return null;
  const isAi = !!p.agent;
  if (!isAi && tab === "ai") tab = "overview";
  // AI-EMPLOYEES v2: what is set only for AI (its section), read with the profile; the AI tab also reads the pickers.
  const [aiBase, aiDetail, aiPeople] = isAi ? await Promise.all([
    early?.[0] ?? api<AiEmployee>(`agents/${p.id}`).then((x) => x.data ?? null),
    early?.[1] ?? api<AiDetail>(`agents/${p.id}/detail`).then((x) => x.data ?? null),
    tab === "ai" ? litePeople().then((x) => (x?.people ?? []).filter((m) => m.status === "active").map((m) => ({ value: m.id, label: m.name })).sort((a, b) => a.label.localeCompare(b.label))) : Promise.resolve([]),
  ]) : [null, null, []];
  const aiStatus = aiBase?.status ?? "on";
  const restricted = p.can.salary || p.can.contact || p.can.documents;
  // Leadership and outcome-based people are shown by tasks and projects, not attendance: their Work tab skips the baseline.
  const outcome = p.workTerms?.workMode === "outcome" || p.pod === "Leadership";
  const none = Promise.resolve(undefined);
  const [work, personHr, hr, domains, life, files, lists, info, skillData, cv, myWork, myChecks, knows] = await Promise.all([
    // Work from evidence (PEOPLE-LIVE): tasks, projects, deliveries and documents, accepted and suggested. Never pay.
    !isAi && ["overview", "work", "projects", "deliveries", "documents"].includes(tab) ? api<PersonWork>(`people/${p.id}/work`).then((x) => x.data) : none,
    // Attendance, leave and the performance baseline come from the HR record; the API refuses anyone but the person, their manager, HR and admins.
    tab === "attendance" || (tab === "work" && !outcome) ? api<PersonHr>(`hr/person/${p.id}${typeof query.month === "string" ? `?month=${encodeURIComponent(query.month)}` : ""}`).then((x) => x.data) : none,
    // Restricted HR data is fetched only when its tab is open: each fetch is a logged read.
    restricted && (tab === "hr" || tab === "documents") ? api<HrRecord>(`people/${p.id}/hr`).then((x) => x.data) : none,
    // UX-TASKS-2: responsibility domains (everyone sees active ones; the sides see proposals and their buttons).
    tab === "domains" ? api<DomainsView>(`work/domains?person=${p.id}`).then((x) => x.data) : none,
    // LIFECYCLE: where the person is between candidate and alumni (colleagues see only current or not), and its history.
    isAi ? Promise.resolve(null) : api<PersonLifecycle>(`people/${p.id}/lifecycle`).then((x) => x.data ?? null),
    // Protected files (role terms, invoices) open for HR with the documents permission and for the person themself; each read is logged.
    tab === "documents" && (p.can.documents || p.can.self) ? api<{ rows: { id: string; kind: string; title: string; name: string; size: number; addedAt: string }[] }>(`people/${p.id}/files`).then((x) => x.data?.rows ?? []) : Promise.resolve([]),
    // The edit form's choices come from the live lists: current staff for "Reports to", the organisation's pods for "Pod".
    p.can.edit ? litePeople() : none,
    // PEOPLE-CONTACTS: My info (the person and HR; bank details inside for the person and the HR role only).
    tab === "info" && p.can.self ? api<MyInfoData>(`people/${p.id}/info`).then((x) => x.data) : none,
    // R48: skills, experience and the CV: the person, their manager or pod head, HR and admins. The person's own CV (and
    // work they may link) loads with the tab; anyone else opens the kept CV on purpose, because that read is logged.
    tab === "skills" && p.can.skills ? api<SkillProfile>(`people/${p.id}/skills`).then((x) => x.data) : none,
    tab === "skills" && p.can.skills && p.can.me ? api<CvData>(`people/${p.id}/cv`).then((x) => x.data ?? null) : none,
    tab === "skills" && p.can.skills && p.can.me ? api<MyWork>("skills/my-work").then((x) => x.data ?? null) : none,
    // R49: checks HR asked of the person about what internal job matching read (their own only).
    tab === "skills" && p.can.skills && p.can.me ? api<MyChecks>("ats/my-checks").then((x) => x.data ?? null) : none,
    // UX-5A: what Pulse knows about the person, on their own profile (My info).
    tab === "info" && p.can.me ? api<MyPulse>("me/pulse").then((x) => x.data ?? null) : none,
  ]);
  const terms = p.workTerms;
  const rhythm = terms ? [terms.hoursMin !== null ? `${terms.hoursMin}${terms.hoursMax !== null && terms.hoursMax !== terms.hoursMin ? `–${terms.hoursMax}` : ""} h a week` : null, terms.officeMin !== null ? `${terms.officeMin}${terms.officeMax !== null && terms.officeMax !== terms.officeMin ? `–${terms.officeMax}` : ""} office days` : null].filter(Boolean).join(" · ") : "";
  const termsForm = p.can.workMode ? <RecordForm path={`people/${p.id}/work-terms`} title={`Work mode and role terms for ${p.name}`} label="Work mode" variant="ghost"
    fields={[{ key: "workMode", label: "Work mode", type: "choice", options: [{ value: "shift", label: "Shift", hint: "Check-in, check-out and the HR attendance rules" }, { value: "outcome", label: "Outcome-based", hint: "No check-in; no late marks or absence flags; measured by KPIs and work" }] },
      { key: "roleTitle", label: "Role title", placeholder: "e.g. Head of Technology, AI and Data (proposed)", wide: true }, { key: "roleStatus", label: "Role status", placeholder: "e.g. Offer not yet accepted: trial period", wide: true },
      { key: "weeklyHoursMin", label: "Hours a week from", type: "number" }, { key: "weeklyHoursMax", label: "Hours a week to", type: "number" },
      { key: "officeDaysMin", label: "Office days from", type: "number" }, { key: "officeDaysMax", label: "Office days to", type: "number" },
      { key: "otherRoles", label: "Other disclosed roles (one per line)", type: "textarea", wide: true }, { key: "note", label: "Note", type: "textarea", wide: true }]}
    values={{ workMode: terms?.workMode ?? "shift", roleTitle: terms?.roleTitle, roleStatus: terms?.roleStatus, weeklyHoursMin: terms?.hoursMin?.toString(), weeklyHoursMax: terms?.hoursMax?.toString(), officeDaysMin: terms?.officeMin?.toString(), officeDaysMax: terms?.officeMax?.toString(), otherRoles: terms?.otherRoles?.join("\n"), note: terms?.note }}
    note="Only admins and HR set this. Outcome-based people need no check-in and get no late marks or absence flags; their time comes from work." /> : null;
  const managers = (lists?.people ?? []).filter((m) => m.id !== p.id && (m.status === "active" || m.id === p.managerId)).map((m) => ({ value: m.id, label: m.name })).sort((a, b) => a.label.localeCompare(b.label));
  const pods = [...new Set([...(lists?.pods ?? []), ...(p.pod ? [p.pod] : [])])].map((value) => ({ value, label: value }));
  const employeeId = userId(p.userNo, (await readBrand())?.code); const since = p.joinedOn ? tenure(p.joinedOn) : null; const first = p.name.split(/\s+/)[0];
  const skills = p.skills ?? []; const line = { managers: p.managers ?? [], reports: p.reports ?? [] };
  const base = `/people/${p.id}`; const status = STATUS[p.status] ?? STATUS.active;
  const open = p.flags.filter((f) => f.status === "open"); const settled = p.flags.filter((f) => f.status === "resolved");
  const teams = [...new Set((lists?.people ?? []).map((m) => m.department).filter((t): t is string => !!t))].sort();
  const fields: FieldDef[] = [
    { key: "name", label: "Full name", required: true, wide: true, section: "Identity" }, { key: "role", label: "Role", required: true, placeholder: "e.g. Video editor" },
    { key: "status", label: "Status", type: "select", required: true, options: [{ value: "active", label: "Current" }, { value: "inactive", label: "Not current" }, { value: "offboarded", label: "Left" }] },
    { key: "pod", label: "Pod", type: "choice", options: pods, section: "Where they work", hint: POD_TEAM.pod },
    { key: "department", label: "Team", suggest: teams, placeholder: "e.g. Creative", hint: "The function. Pick one in use or type a new one." }, { key: "managerId", label: "Reports to", type: "select", options: managers },
    { key: "employmentType", label: "Employment", type: "choice", options: Object.entries(TYPES).map(([value, label]) => ({ value, label })) },
    { key: "joinedOn", label: "Joined on", type: "date" }, { key: "workLocation", label: "Work location", suggest: ["Office", "Remote", "Hybrid"], placeholder: "Office, Remote, Hybrid" },
    { key: "email", label: "Work e-mail", type: "email", section: "Work contact" }, { key: "phone", label: "Work phone", type: "tel" }, { key: "notes", label: "Notes", type: "textarea" },
  ];
  const edit = p.can.edit ? { path: `people/${p.id}`, title: `Edit ${p.name}`, fields, note: "A field you change here is kept as you set it; the sources no longer overwrite it.",
    values: { name: p.name, role: p.role, pod: p.pod, department: p.department, managerId: p.managerId, joinedOn: p.joinedOn, employmentType: p.employmentType, status: p.status, workLocation: p.workLocation, email: p.email, phone: p.phone, notes: p.notes } } : undefined;
  const seeWork = p.can.work || p.can.record;
  const self = !!p.can.me;
  // ORG: what this person carries from their Pulse account (only what they share with this organisation).
  const carried = tab === "overview" ? (await api<{ card: Carried | null }>(`people/${p.id}/carried`)).data?.card ?? null : null;
  // WA-IMPORT: the WhatsApp groups this person wrote in (the ones the viewer reads), a tab only when there are any.
  const chats = isAi ? 0 : (await api<{ total: number }>(`chats/whatsapp?person=${p.id}&limit=1`)).data?.total ?? 0;
  // XRAY-LINK: this person's Sales X-Ray calls linked in Pulse (a tab only when there are any; none when the app is off).
  const sxCalls = isAi ? 0 : (await api<{ calls: unknown[] }>(`sales-xray/linked?person=${p.id}`)).data?.calls?.length ?? 0;
  const tabs = isAi ? [{ key: "overview", label: "Overview" }, { key: "ai", label: "AI" }, { key: "work", label: "Work" }, { key: "projects", label: "Projects", count: work?.counts?.projects }]
    : [{ key: "overview", label: "Overview" }, ...(p.can.self ? [{ key: "info", label: self ? "My info" : "Personal" }] : []), ...(p.can.skills ? [{ key: "skills", label: "Skills & CV" }] : []), { key: "work", label: "Work" }, { key: "domains", label: "Domains" }, { key: "projects", label: "Projects", count: work?.counts?.projects },
    ...(chats || tab === "chats" ? [{ key: "chats", label: "Chats", count: chats }] : []), { key: "deliveries", label: "Deliveries" }, ...(sxCalls || tab === "salesxray" ? [{ key: "salesxray", label: "Sales calls", count: sxCalls }] : []), { key: "attendance", label: "Attendance & leave" },
    ...(p.can.record ? [{ key: "hr", label: "HR" }] : []), ...(seeWork ? [{ key: "documents", label: "Documents" }] : [])];
  const noWork = <Panel title="Work"><Empty icon={UserRoundSearch} title={p.can.work ? "No deliveries are credited to this person yet" : "Not visible to your account"} text={p.workDetail} action={p.can.work ? { href: "/people?tab=tracking", label: "Explore uploader accounts" } : undefined} /></Panel>;
  const tabBar = <QueryTabs base={base} current={tab} items={tabs.map((t) => t.key === "hr" || (t.key === "documents" && p.can.record) ? { ...t, label: <>{t.label}<Lock size={11} className={css.tabLock} aria-label="restricted" /></> } : t)} />;
  const phoneForm = <RecordForm path={`people/${p.id}/self`} title={`Work phone for ${p.name}`} label={p.phone ? "Edit phone" : "Add phone"} variant="ghost"
    fields={[{ key: "phone", label: "Work phone", type: "tel", wide: true, placeholder: "The number colleagues can reach you on" }]} values={{ phone: p.phone }} note="Leave it empty to remove the number. Personal contact details are kept separately in the restricted HR record." />;
  const confirm = open.length ? (
    <section className={`${styles.panel} ${css.flagBox}`} aria-label="Needs confirmation">
      <div className={styles.panelHead}><h3 className={styles.panelTitle}>Needs confirmation<small title="The sources disagree; nothing was picked silently">The sources disagree; nothing was picked silently</small></h3></div>
      {open.map((f) => (
        <div key={f.id} className={css.flag}><CircleAlert size={15} aria-hidden="true" />
          <p><b>{FLAG_FIELD[f.field] ?? f.field}.</b> {f.summary}</p>
          {p.can.edit ? <FlagActions personId={p.id} flag={f} /> : null}
        </div>
      ))}
    </section>
  ) : null;
  const docsNote = <p className={css.restricted}><Lock size={14} aria-hidden="true" /><span><b>Restricted.</b> Letters and identity documents are visible to HR and leadership only, and every view is logged. Work documents are Drive files the person owns or edited: names only, the files stay in Drive.</span></p>;
  const hrNote = <p className={css.restricted}><Lock size={14} aria-hidden="true" /><span><b>Restricted.</b> Only HR and leadership can open this tab. Salary, personal contact details and document names are kept apart from the rest of Pulse, never appear on dashboards or in notifications, and every view is logged.</span></p>;
  return (
    <Page fit>
      <RecentVisit title={p.name} kind="person" />
      {/* PEOPLE-CONTACTS: the photo (changed in place with the cropper), who they are, and the facts as chips. */}
      <ProfileHeader name={p.name} id={p.id} photoAt={p.photoAt} back={{ href: "/people", label: "Team" }}
        picker={p.can.photo ? <PhotoControls personId={p.id} hasPhoto={!!p.photoAt} name={p.name} /> : null}
        badges={<>{isAi ? <AiBadge employeeId={p.employeeId} size="md" /> : null}<Badge tone={status.tone}>{status.label}</Badge>
          {isAi && aiBase && aiBase.status !== "on" ? <Badge tone="warning">{aiBase.status === "paused" ? "Paused" : "Switched off"}</Badge> : null}
          {open.length ? <Badge tone="warning"><CircleAlert size={11} aria-hidden="true" /> {plural(open.length, "detail")} to confirm</Badge> : null}
          {life && !["active", "left"].includes(life.stage) ? <Badge tone={life.stage === "notice" ? "warning" : "neutral"}>{STAGE_LABEL[life.stage]}{life.stage === "notice" && life.employment?.lastWorkingDay ? ` · last day ${dayYear(life.employment.lastWorkingDay)}` : life.stage === "probation" && life.employment?.probationTo ? ` until ${dayYear(life.employment.probationTo)}` : ""}</Badge> : null}
          {life?.stage === "left" && (life.leftOn || life.leftType) ? <Badge tone="neutral">Alumni{life.leftType ? ` · ${LEFT_LABEL[life.leftType].toLowerCase()}` : ""}{life.leftOn ? ` ${dayYear(life.leftOn)}` : ""}</Badge> : null}
          {life?.review ? <Link href="/hr?tab=moves"><Badge tone="warning">Possibly left: confirm</Badge></Link> : null}</>}
        subtitle={<>{p.role}{p.department ? ` · ${p.department}` : ""}{p.pronouns ? <span className={css.pronouns}> · {p.pronouns}</span> : null}</>}
        chips={[
          // E2E-4P: an AI without a pod shows no "Pod not set", and its AI ID stands in for the staff ID (two IDs read as a mistake).
          isAi && !p.pod ? null : { icon: <UsersRound size={13} aria-hidden="true" />, label: "Pod", value: p.pod ?? "not set", href: p.pod ? `/people?pod=${encodeURIComponent(p.pod)}` : undefined },
          p.managerId ? { icon: <Avatar name={p.managerName ?? "Manager"} id={p.managerId} photoAt={line.managers[0]?.photoAt} size={18} />, label: "Reports to", value: p.managerName ?? "", href: `/people/${p.managerId}` }
            : { icon: <UserRound size={13} aria-hidden="true" />, label: "Reports to", value: "not set" },
          p.joinedOn ? { icon: <CalendarDays size={13} aria-hidden="true" />, label: "Joined", value: <>{dayYear(p.joinedOn)}{since ? <span className={css.since}> · {since}</span> : null}</> } : null,
          p.workLocation ? { icon: <MapPin size={13} aria-hidden="true" />, value: p.workLocation } : null,
          p.username ? { icon: <AtSign size={13} aria-hidden="true" />, value: <span className={styles.mono}>{p.username}</span>, title: "Pulse username" } : null,
        ]}
        actions={<>
          {self ? <Link className={`${styles.btn}${tab === "info" ? "" : ` ${styles.btnPrimary}`}`} href={`${base}?tab=info`}>Edit my info</Link> : null}
          {tab === "work" && p.activity ? <PeriodSwitcher period={p.activity.period} /> : null}
          {p.can.login ? <LoginActions personId={p.id} hasLogin={!!p.login} active={p.login?.status === "active"} /> : null}
          {life?.canMove ? <MoveButton person={{ id: p.id, name: p.name }} stage={life.stage} today={life.today} /> : null}
          {/* On your own page "Edit my info" (personal details) sits beside this one: say it edits the work record. */}
          {/* UI-POLISH: one primary action: on your own page that is "Edit my info". */}
          {edit ? <RecordForm {...edit} label={self ? "Edit work record" : "Edit"} variant={self ? undefined : "primary"} /> : null}
          {isAi && aiDetail?.canManage && tab !== "ai" ? <Link className={`${styles.btn} ${styles.btnPrimary}`} href={`${base}?tab=ai`}>AI settings</Link> : null}
          {/* UI-UPGRADE: the kit's menu (icons, arrow keys, Escape) instead of a bare list under a details element. */}
          <Menu label={`More for ${p.name}`} buttonLabel="More for this person" title="More" className={`${styles.btn} ${css.moreBtn}`} items={[
            { key: "activity", label: "Observed activity", icon: <Activity size={15} aria-hidden="true" />, href: `/activity?person=${p.id}` },
            { key: "tasks", label: "Tasks", icon: <ListChecks size={15} aria-hidden="true" />, href: `/tasks?person=${p.id}` },
            ...(p.can.hr ? [{ key: "history", label: "Imported history", icon: <HistoryIcon size={15} aria-hidden="true" />, href: `/hr-history?person=${p.id}` }] : [])]}>
            <Ellipsis size={15} aria-hidden="true" /></Menu>
        </>} />

      {tab === "overview" ? <Deck tall={open.length || p.sources.length > 8 ? 880 : 800} head={tabBar} views={[
        // The record: who they are, what they can do, where they sit. Window-tall enough: the sources follow as a second row.
        // (About has twelve rows since PRESENCE and LIFECYCLE: the record row alone is ~510 px, so at 640 the sources row
        // was squeezed to a paged list showing nothing at 1440×900. LAYOUT-SWEEP.)
        { label: "Record", content: <Fit className={`${css.overview} ${css.recordRow}`}>
        <div className={css.ovCol}>
          <Panel title="About" tools={edit || (p.can.hr && p.can.self) ? <>{p.can.hr && p.can.self ? phoneForm : null}{edit ? <RecordForm {...edit} label="Edit" variant="ghost" /> : null}</> : undefined}>
            {/* UI-POLISH: the record in three short groups (the work, how to reach them, the record itself) instead of one
                long list; Pod, Reports to and Joined also lead the header, so each group reads on its own. */}
            <h4 className={css.factHead}>Work</h4>
            <dl className={`${styles.facts} ${css.factsAligned}`}>
              <dt>Role</dt><dd>{p.role}<Prov source={p.fieldSources.role} /></dd>
              <dt>Pod</dt><dd><Fact value={p.pod} /><Prov source={p.fieldSources.pod} />{work?.pods?.map(l => <span key={l.linkId} className={styles.muted}>{l.status === "suggested" ? ` · ${l.pod} is suggested ` : " "}<Mark link={l} review={work.can.review} label={`pod ${l.pod}`} /></span>)}</dd>
              <dt>Team</dt><dd><Fact value={p.department} /><Prov source={p.fieldSources.department} /></dd>
              <dt>Reports to</dt><dd>{p.managerId ? <Link href={`/people/${p.managerId}`} className={styles.fill}>{p.managerName}</Link> : <Fact />}</dd>
              {p.can.hr ? <><dt>Employment</dt><dd><Fact value={p.employmentType ? TYPES[p.employmentType] : null} /><Prov source={p.fieldSources.employment_type} /></dd></> : null}
              {terms || p.can.workMode ? <><dt>Work mode</dt><dd>{terms?.workMode === "outcome" ? <><Badge tone="accent">Outcome-based</Badge> <Link className={styles.fill} href={`/tasks/outcomes?person=${p.id}`}>Outcomes</Link></> : "Shift"}{termsForm}</dd></> : null}
              {terms?.roleTitle ? <><dt>Role terms</dt><dd>{terms.roleTitle}{terms.roleStatus ? <> · <Badge tone="warning">{terms.roleStatus}</Badge></> : null}</dd></> : null}
              {rhythm ? <><dt>Rhythm</dt><dd>{rhythm}<span className={styles.muted}> · measured by KPIs, not hours</span></dd></> : null}
              {terms?.otherRoles?.length ? <><dt>Other roles</dt><dd>{terms.otherRoles.join(" · ")}<span className={styles.muted}> (kept separate)</span></dd></> : null}
            </dl>
            <h4 className={css.factHead}>Contact</h4>
            <dl className={`${styles.facts} ${css.factsAligned}`}>
              {p.can.hr ? <><dt>Work e-mail</dt><dd><Fact value={p.email ? <a className={`${styles.fill} ${css.email}`} href={`mailto:${p.email}`}>{p.email}</a> : null} missing="No company e-mail" /></dd>
              <dt>Work phone</dt><dd><Fact value={p.phone ? <a className={styles.fill} href={`tel:${p.phone}`}>{p.phone}</a> : null} missing="Not added yet" /></dd></> : null}
              <dt>Work location</dt><dd><Fact value={p.workLocation} /></dd>
            </dl>
            <h4 className={css.factHead}>Record</h4>
            <dl className={`${styles.facts} ${css.factsAligned}`}>
              <dt>Pulse ID</dt><dd>{p.pulseId ?? "Not assigned yet"}</dd><dt>{isAi ? "AI ID" : "Employee ID"}</dt><dd>{isAi && p.employeeId ? <span className={styles.mono}>{p.employeeId}</span> : employeeId ? <CopyId id={employeeId} /> : <Fact missing="Not assigned yet" />}</dd>
              <dt>Joined</dt><dd><Fact value={p.joinedOn ? <>{dayYear(p.joinedOn)}{since ? <span className={styles.muted}> · {since}</span> : null}</> : null} missing="Not in any source" /><Prov source={p.fieldSources.joined_on} /></dd>
              {p.editedBy?<><dt>Edited by</dt><dd>{p.editedBy}</dd></>:null}
              {p.can.hr && p.notes ? <><dt>Notes</dt><dd>{p.notes}</dd></> : null}
            </dl>
          </Panel>
        </div>
        <div className={css.ovCol}>
          {work?.can.view ? <WorkSummary data={work} base={base} /> : null}
          <Panel title="Skills" sub={skills.length ? count(skills.length) : undefined} tools={p.can.skills ? <Link className={styles.fill} href={`${base}?tab=skills`}>Levels, work and CV</Link> : undefined}>
            <SkillsEditor personId={p.id} skills={skills} canEdit={p.can.self} />
          </Panel>
          {isAi && aiDetail ? <Panel fill title="AI" sub={PROVIDER[aiDetail.settings.provider] ?? aiDetail.settings.provider} tools={<Link className={styles.fill} href={`${base}?tab=ai`}>{aiDetail.canManage ? "Settings" : "Details"}</Link>}>
            <dl className={styles.facts}>
              <dt>Model</dt><dd>{modelName(aiDetail.settings.model)}</dd>
              <dt>Thinking</dt><dd>{THINKING[aiDetail.settings.effort] ?? aiDetail.settings.effort}</dd>
              {KINDS.map((k) => <Fragment key={k.key}><dt>{k.label}</dt><dd>{AUTONOMY[aiDetail.settings.autonomy?.[k.key] ?? (k.key === "group" ? "off" : "own")]}</dd></Fragment>)}
              <dt>Approves for it</dt><dd>{aiDetail.settings.approverName ?? <Fact />}</dd>
              <dt>Tools</dt><dd>{aiDetail.settings.tools.map((t) => TOOL_LABEL[t] ?? t).join(", ") || "None"}</dd>
            </dl>
          </Panel> : null}
          {isAi ? null : <Panel fill title="Accounts" sub="Upload evidence is shown in Activity" tools={p.can.link ? <LinkAccount personId={p.id} /> : undefined}>
            {p.accounts.length ? <ul className={styles.list}>{p.accounts.map((a) => (
              <li key={a.handle} className={styles.row}><span className={styles.rowMain}><Link href={`/people/accounts/${encodeURIComponent(a.handle)}`} className={styles.rowTitle}>{a.handle}</Link>
                <span className={styles.rowMeta}><span>{a.purpose}</span><span>{plural(a.deliveries, "delivery", "deliveries")}</span></span></span>
              {p.can.link && !a.purpose?.startsWith("Workspace") ? <LinkAccount personId={p.id} unlink={a.handle} /> : null}</li>
            ))}</ul> : <Empty icon={AtSign} compact title="No account linked" text="Shared logins stay uncredited. Qualified uploads appear in Activity." />}
          </Panel>}
        </div>
        <div className={css.ovCol}>
          {confirm}
          <Panel fill title="Reporting line" sub={line.managers.length || line.reports.length ? [line.managers.length ? `Reports to ${line.managers[0].name.split(/\s+/)[0]}` : null, line.reports.length ? `${plural(line.reports.length, "direct report")}` : null].filter(Boolean).join(" · ") : undefined}>
            {line.managers.length || line.reports.length ? <ReportingLine managers={line.managers} person={{ id: p.id, name: p.name, role: p.role, userNo: p.userNo, photoAt: p.photoAt }} reports={line.reports} />
              : <Empty icon={Network} compact title="No reporting line yet" text={p.can.edit ? `Set who ${first} reports to with Edit. Admins can also set managers for the whole team in Settings. A manager can approve their reports' leave and attendance corrections.` : `Nobody is recorded as ${first}'s manager yet, and nobody reports to ${first}. HR or an admin can set this.`} />}
          </Panel>
        </div>
      </Fit> },
        { label: settled.length || p.history.length ? "Sources & changes" : "How Pulse knows", content: <Fit className={`${css.overview} ${settled.length || p.history.length ? "" : css.wide}`}>
          <Panel fill title="How Pulse knows" sub={plural(p.sources.length, "document")} foot={p.sources.some((s) => s.restricted) ? <span className={css.lock}><Lock size={12} aria-hidden="true" />HR documents are listed for HR and leadership only.</span> : undefined}>
            {p.sources.length ? <ul className={`${css.sourceList} ${css.sourceGrid}`}>{p.sources.map((s, i) => (
              <li key={i} className={css.source}>{s.restricted ? <FileLock2 size={14} aria-hidden="true" /> : <FileText size={14} aria-hidden="true" />}
                <span><b>{s.label}</b><small>As “{s.writtenName}”{s.role ? ` · ${s.role}` : ""}{s.group && s.group !== s.role ? ` · ${s.group}` : ""}</small></span>
                {s.lastSeen ? <time dateTime={s.lastSeen}>{dayYear(s.lastSeen).slice(dayYear(s.lastSeen).indexOf(" ") + 1)}</time> : <span className={css.sourceEnd}>Current list</span>}</li>
            ))}</ul> : <Empty icon={Info} compact title="Added in Pulse" text="No team list or HR document names this person yet; the record was entered by hand." />}
          </Panel>
          {settled.length ? <Panel fill title="Confirmed" sub="Questions already settled"><ul className={styles.timeline} style={{ paddingTop: 10 }}>{settled.map((f) => (
            <li key={f.id}><span><b>{FLAG_FIELD[f.field] ?? f.field}</b> set to “{f.resolution}”</span><small>{f.resolvedBy ?? "Pulse"}{f.resolvedAt ? ` · ${dayTime(f.resolvedAt)}` : ""}</small></li>
          ))}</ul></Panel> : null}
          {p.history.length ? <Panel fill title="Changes" sub="Edits made in Pulse"><History items={p.history} /></Panel> : null}
      </Fit> },
        ...(carried ? [{ label: "Profile everywhere", content: <CarriedProfile person={p.id} card={carried} canGive={!carried.self && (p.can.edit || p.can.hr)} /> }] : []),
      ]} /> : tab === "attendance" && personHr ? <AttendanceLeaveTab data={personHr} base={base} head={tabBar} /> : tabBar}

      {/* AI-EMPLOYEES v2: the AI section of the same profile. */}
      {/* UI-UPGRADE: a summary over a settings layout with a left sub-nav (?s= opens a section). */}
      {tab === "ai" && isAi ? (aiDetail ? <AiTab id={p.id} detail={aiDetail} status={aiStatus} people={aiPeople} initial={typeof query.s === "string" ? query.s : undefined}
        usage={aiBase ? { dailyBudget: aiBase.dailyBudget, usedToday: aiBase.usedToday } : null} /> : <Panel title="AI"><Empty icon={Lock} title="Not visible to your account" text="Its AI settings are shown to leaders, HR and the person it reports to." /></Panel>) : null}

      {/* UX-5A: what Pulse knows about the person, moved here from My desk (their own profile only). */}
      {tab === "info" && self && knows ? <PulseKnows knows={knows.knows} /> : null}
      {tab === "info" ? (info ? <MyInfo data={info} /> : <Panel title="Personal"><Empty icon={Lock} title="Not visible to your account" text={`Only ${first}, HR and leadership see this.`} /></Panel>) : null}

      {tab === "skills" ? (skillData ? <SkillsTab person={{ id: p.id, name: p.name }} data={skillData} cv={cv ?? null} work={myWork ?? null} checks={myChecks ?? null} />
        : <Panel title="Skills & CV"><Empty icon={Lock} title="Not visible to your account" text={`Only ${first}, their manager or pod head, HR and admins see this.`} /></Panel>) : null}

      {/* The week's figures stay on top; deliveries, the projects they went to and the person's recorded work are views. */}
      {tab === "work" && (p.activity || work?.can.view) ? <Workspace param="view">
        {work?.can.view ? <TaskList data={work} title="Tasks" /> : null}
        {p.activity ? <WeekTiles data={p.activity} /> : null}
        {p.activity ? <DeliveriesPanel data={p.activity} /> : null}
        {p.activity ? <ProjectsPanel data={p.activity} /> : null}
        {!p.activity ? noWork : null}
        {personHr?.can.performance && !outcome ? <PerformancePanel data={personHr} compact /> : null}
      </Workspace> : null}

      {tab === "overview" || tab === "ai" || tab === "info" || tab === "skills" || (tab === "work" && (p.activity || work?.can.view)) || (tab === "attendance" && personHr) ? null : <Workspace>
      {tab === "work" ? noWork : null}

      {/* Called as a function so each panel becomes one of the Workspace's views. */}
      {tab === "domains" ? (domains ? DomainsPanel({ data: domains }) : <Panel title="Responsibility domains"><Empty icon={Lock} title="Not available" text="Domains could not be read for this person." /></Panel>) : null}
      {tab === "chats" ? <Panel title="Chats they're in" sub="Imported from WhatsApp, with what they wrote"><WaInsightKpis subject="person" id={p.id} /><WaChatsSection filter={{ person: p.id }} title="WhatsApp chats" person empty={`No imported chat ${p.name.split(/\s+/)[0]} wrote in is visible to you.`} /></Panel> : null}
      {tab === "projects" ? (work?.can.view ? <ProjectList data={work} title="Projects" />
        : <Panel title="Projects"><Empty icon={FolderKanban} title="Not visible to your account" text={p.workDetail} /></Panel>) : null}

      {/* Evidence comes first when nothing is credited yet. */}
      {tab === "salesxray" ? <LinkedCalls query={`person=${p.id}`} title="Sales X-Ray calls" empty="Calls linked to this person in Sales X-Ray → Calls show here with their analysis." /> : null}
      {tab === "deliveries" && work?.can.view && (work.deliveries?.length ?? 0) > 0 && p.deliveries.length === 0 ? <EvidenceDeliveries data={work} title="From evidence" /> : null}
      {tab === "deliveries" ? (p.deliveries.length ? <Panel title="Credited" sub={`Latest ${p.deliveries.length}`}><DeliveryFeed items={p.deliveries} today={new Date().toISOString().slice(0, 10)} /></Panel>
        : <Panel title="Credited">{work?.can.view ? <Missing text={work.missing?.deliveries ?? p.workDetail} /> : <Empty icon={Inbox} title="Not visible to your account" text={p.workDetail} />}</Panel>) : null}
      {tab === "deliveries" && work?.can.view && (work.deliveries?.length ?? 0) > 0 && p.deliveries.length > 0 ? <EvidenceDeliveries data={work} title="From evidence" /> : null}

      {tab === "attendance" && !personHr ? (<Panel title="Attendance & leave"><Empty icon={Lock} title="Not visible to your account" text="Attendance and leave are visible to the person, their manager, HR and organisation admins." /></Panel>) : null}

      {tab === "hr" && p.can.record ? <>
        {hrNote}
        <div className={styles.columns} style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}>
          <Panel title="Employment" sub="From company documents and edits in Pulse">
            <dl className={styles.facts}>
              <dt>Designation</dt><dd>{p.role}<Prov source={p.fieldSources.role} /></dd>
              <dt>Department</dt><dd><Fact value={p.department} /><Prov source={p.fieldSources.department} /></dd>
              <dt>Employment</dt><dd><Fact value={p.employmentType ? TYPES[p.employmentType] : null} missing="Not in any document" /><Prov source={p.fieldSources.employment_type} /></dd>
              <dt>Joining date</dt><dd><Fact value={p.joinedOn ? dayYear(p.joinedOn) : null} missing="Not in any document" /><Prov source={p.fieldSources.joined_on} /></dd>
              <dt>Reports to</dt><dd>{p.managerId ? <Link href={`/people/${p.managerId}`}>{p.managerName}</Link> : <Fact missing="Not in any document" />}</dd>
              <dt>Status</dt><dd>{status.label}<Prov source={p.fieldSources.status} /></dd>
            </dl>
          </Panel>
          <Panel title="Personal contact" sub="HR and leadership only" tools={p.can.contactWrite ? <RecordForm path={`people/${p.id}/hr-contact`} title={`Personal contact for ${p.name}`} label="Edit" variant="ghost"
            fields={[{ key: "personalPhone", label: "Personal phone", type: "tel" }, { key: "personalEmail", label: "Personal e-mail", type: "email" }, { key: "emergency", label: "Emergency contact", wide: true }]}
            values={{ personalPhone: hr?.contact?.personalPhone, personalEmail: hr?.contact?.personalEmail, emergency: hr?.contact?.emergency }} note="Saved to the restricted HR record. Every view and edit is logged." /> : undefined}>
            {p.can.contact ? <dl className={styles.facts}>
              <dt>Phone</dt><dd><Fact value={hr?.contact?.personalPhone} missing="Not in any document" /></dd>
              <dt>Personal e-mail</dt><dd><Fact value={hr?.contact?.personalEmail} missing="Not in any document" /></dd>
              <dt>Emergency</dt><dd><Fact value={hr?.contact?.emergency} /></dd>
              {hr?.contact ? <><dt>Source</dt><dd>{hr.contact.source}</dd></> : null}
            </dl> : <Empty icon={Lock} compact title="Your account cannot read personal contact details" />}
          </Panel>
        </div>
        {life ? <LifecycleTimeline life={life} name={p.name} /> : null}
        <Panel title="Salary history" sub="As read from the salary sheets in Drive" foot={p.can.salary && hr?.compensation?.length ? <>The sheets are read as text, so each figure states how it was read. “Base salary” is the figure that repeats across a person’s months; “Total paid” is the sheet’s own total for the month. Check a figure against its sheet before relying on it.</> : undefined}>
          {!p.can.salary ? <Empty icon={Lock} title="Your account cannot read salary" text="Salary needs the HR or admin role and the separate salary permission." />
            : hr?.compensation?.length ? <SalaryTable rows={hr.compensation} /> : <Empty icon={FileLock2} title="No salary entries" text="No salary sheet in the Drive index names this person." />}
        </Panel>
        <div className={styles.columns} style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}>
          {p.can.login ? <Panel title="Pulse sign-in" sub="Private sign-in links and account security">
            <dl className={styles.facts}>
              <dt>Username</dt><dd className={styles.mono}><Fact value={p.username} /></dd>
              <dt>Account</dt><dd>{p.login ? <>{p.login.status === "active" ? "Active" : "Disabled"} {dayTime(p.login.issuedAt)}{p.login.mustChange ? " · must be changed at first sign-in" : ""}</> : <span className={styles.muted}>Not issued</span>}</dd>
              <dt>Last sign-in</dt><dd><Fact value={p.login?.lastLoginAt ? ago(p.login.lastLoginAt) : null} missing="Never" /></dd>
            </dl>
            <p className={styles.panelFoot}><LoginActions personId={p.id} hasLogin={!!p.login} active={p.login?.status === "active"} small /></p>
          </Panel> : null}
          {p.can.salary ? <Panel title="Access log" sub="Who opened this person's restricted records">
            {hr?.accessLog.length ? <ul className={styles.timeline} style={{ paddingTop: 10 }}>{hr.accessLog.map((l, i) => <li key={i}><span><b>{l.viewer ?? "Unknown"}</b> {l.purpose === "hr_profile_edit" ? "edited" : "viewed"} {RESOURCE[l.resource]?.toLowerCase() ?? l.resource}</span><small>{dayTime(l.at)}</small></li>)}</ul>
              : <Empty icon={ShieldCheck} compact title="No views yet" />}
          </Panel> : null}
        </div>
      </> : null}

      {tab === "documents" && work?.can.view ? <WorkDocuments data={work} title="Work documents" /> : null}
      {tab === "documents" && p.can.record ? <>
        {docsNote}
        {/* POLISH-1: a protected file opens inside Pulse (PDF.js, images inline), on a phone too: no second download, no
            other app; Back closes it. */}
        {files.length ? <ProofViewer proofs={files.map(fileProof)} /> : null}
        {files.length ? <Panel title="Protected documents" sub="Kept in Pulse; HR, the founders and the person can open them, and every opening is logged">
          <div data-items="">{files.map((f) => <div key={f.id} className={css.docRow}><FileLock2 size={14} aria-hidden="true" /><span><b>{f.title}</b><small>{f.name} · {Math.max(1, Math.round(f.size / 1024))} KB</small></span>
            <ProofOpen proof={fileProof(f)} className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`}>Open</ProofOpen></div>)}</div>
        </Panel> : null}
        {!p.can.documents ? <Panel title="Documents"><Empty icon={Lock} title="Your account cannot read document names" /></Panel> : <div className={styles.columns} style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}>
          <Panel title="Letters and files" sub="Names only; the files stay in Drive">
            {(hr?.documents ?? []).filter((d) => d.fileName).length ? (hr?.documents ?? []).filter((d) => d.fileName).map((d, i) => (
              <div key={i} className={css.docRow}><FileText size={14} aria-hidden="true" /><span><b>{DOCS[d.type] ?? d.type}</b><small title={d.location ?? undefined}>{d.fileName}{d.location ? ` · ${d.location}` : ""}</small></span>
                {d.fileId ? <a className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} href={`https://drive.google.com/file/d/${encodeURIComponent(d.fileId)}/view`} target="_blank" rel="noreferrer">Open in Drive</a> : null}</div>
            )) : <Empty icon={FileText} compact title="No letters found in Drive" text="Appointment, offer and joining letters named after this person would be listed here." />}
          </Panel>
          <Panel title="Identity and bank documents" sub="On file or not; Pulse does not copy them">
            <div data-items="">{ID_DOCS.map(([type, label]) => { const onFile = (hr?.documents ?? []).some((d) => d.type === type); return (
              <div key={type} className={css.docRow}><FileLock2 size={14} aria-hidden="true" /><span><b>{label}</b><small>{onFile ? "A document is on file in Drive" : "Not found in the Drive index"}</small></span><Badge tone={onFile ? "success" : "neutral"}>{onFile ? "On file" : "Not on file"}</Badge></div>
            ); })}</div>
            <p className={styles.panelFoot}>ID numbers and scans stay in Drive. Pulse records only whether a document exists.</p>
          </Panel>
        </div>}
      </> : null}
      </Workspace>}
    </Page>
  );
}
