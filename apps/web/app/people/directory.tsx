"use client";

import { ChevronDown, CircleAlert, LayoutGrid, List, Search, UserRoundSearch } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import type { PersonRow } from "../lib/api";
import { dayYear, plural, userId } from "../lib/format";
import { Avatar, Badge, Empty, Pager, Why, styles } from "../ui";
import { Segmented } from "../kit";
import { POD_TEAM } from "../pod-team";
import css from "./people.module.css";
import { idQuery, monthYear, tenure } from "./shared";
import { useOrgCode } from "../org-code";
import { AiCards, AiTable, aiMatch, type AiTeamRow } from "./ai-rows";
import { RetryButton } from "../retry-button";
import { SelectField } from "../kit/select-field";

type Status = "active" | "past" | "all";
type Kind = "all" | "people" | "ai";
type Skip = "pod" | "department" | "skill";
const NO_POD = "No pod";
const current = (p: PersonRow) => p.status === "active";
const alumnus = (p: PersonRow) => !current(p) && !["candidate", "offer"].includes(p.stage ?? "");
/** LIFECYCLE: where someone is besides plain current (HR sees every stage; colleagues only current or alumni). */
const STAGE_BADGE: Record<string, { label: string; tone: "warning" | "neutral" | "accent" }> = { candidate: { label: "Candidate", tone: "neutral" }, offer: { label: "Offer", tone: "neutral" },
  joining: { label: "Joining", tone: "accent" }, probation: { label: "Probation", tone: "accent" }, notice: { label: "On notice", tone: "warning" } };
function StageBadge({ p }: { p: PersonRow }) {
  if (p.possiblyLeft) return <Badge tone="warning">Possibly left: confirm</Badge>;
  const b = STAGE_BADGE[p.stage ?? ""];
  return b ? <Badge tone={b.tone}>{b.label}</Badge> : current(p) ? null : <Badge tone="neutral">{p.leftOn ? `Left ${monthYear(p.leftOn)}` : "Alumni"}</Badge>;
}
const skillsOf = (p: PersonRow) => p.skills ?? [];

/** The staff directory: search and quick filters work in the browser, so every click answers at once. */
/** `ai` is the leaders' list of AI employees; null for everyone else, who get no People · AI · All toggle. */
export function Directory({ people, pods, viewer, staff, attendanceEnabled = false, pod: firstPod, team: firstTeam, status: firstStatus, ai = null, aiError = false }: { people: PersonRow[]; pods: string[]; viewer: string | null; staff: boolean; attendanceEnabled?: boolean; pod?: string; team?: string; status?: Status; ai?: AiTeamRow[] | null; aiError?: boolean }) {
  const orgCode = useOrgCode();
  const [query, setQuery] = useState(""); const [status, setStatus] = useState<Status>(firstStatus ?? "active");
  const [pod, setPod] = useState<string | null>(firstPod === "none" ? NO_POD : firstPod ?? null); const [department, setDepartment] = useState<string | null>(firstTeam ?? null); const [skill, setSkill] = useState<string | null>(null);
  const [flagged, setFlagged] = useState(false); const [kind, setKind] = useState<Kind>("all");
  const search = useSearchParams(); const pathname = usePathname();
  const view = search.get("view") === "list" ? "list" : "cards";
  const setView = (next: "cards" | "list") => { const query = new URLSearchParams(search.toString()); query.set("view", next); history.replaceState(null, "", `${pathname}?${query}`); };
  const inStatus = useMemo(() => people.filter((p) => status === "all" || (status === "active" ? current(p) : alumnus(p))), [people, status]);
  // Pods in the organisation's own order; a pod that was removed but is still on a record comes after them.
  const podOrder = useMemo(() => [...pods, ...[...new Set(people.map((p) => p.pod).filter((name): name is string => !!name && !pods.includes(name)))].sort(), NO_POD], [pods, people]);
  const q = query.trim().toLowerCase(); const idNo = idQuery(q);
  const text = (p: PersonRow) => `${p.name} ${p.role} ${p.pod ?? ""} ${p.department ?? ""} ${p.username ?? ""} ${p.accounts.join(" ")} ${skillsOf(p).join(" ")} ${p.managerName ?? ""} ${p.workLocation ?? ""} ${userId(p.userNo, orgCode) ?? ""}`.toLowerCase();
  const match = (p: PersonRow, skip?: Skip) =>
    (!q || (idNo !== null && p.userNo === idNo) || text(p).includes(q))
    && (skip === "pod" || !pod || (p.pod ?? NO_POD) === pod) && (skip === "department" || !department || p.department === department)
    && (skip === "skill" || !skill || skillsOf(p).some((s) => s.toLowerCase() === skill))
    && (!flagged || p.flags.length > 0);
  const shown = inStatus.filter((p) => match(p));
  const tally = (keys: (p: PersonRow) => (string | null)[], skip: Skip) => {
    const counts = new Map<string, number>();
    for (const p of inStatus) if (match(p, skip)) for (const k of keys(p)) if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
    return counts;
  };
  const podCounts = tally((p) => [p.pod ?? NO_POD], "pod"); const departments = tally((p) => [p.department], "department");
  // Skills are compared without case; the chip shows the spelling used most recently in the list.
  const skillNames = new Map<string, string>(); for (const p of people) for (const s of skillsOf(p)) skillNames.set(s.toLowerCase(), s);
  const skillCounts = tally((p) => skillsOf(p).map((s) => s.toLowerCase()), "skill");
  const skillChips = [...skillCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 14);
  if (skill && !skillChips.some(([key]) => key === skill)) skillChips.push([skill, skillCounts.get(skill) ?? 0]);
  // Cards run in the organisation's pod order; each card names its pod, so the grid needs no headings.
  const ordered = kind === "ai" ? [] : podOrder.flatMap((name) => shown.filter((p) => (p.pod ?? NO_POD) === name));
  // AI employees have no pod, team, skills or alumni, so a filter on any of those leaves them out.
  const aiShown = !ai || kind === "people" || (kind === "all" && (pod || department || skill || flagged || status === "past")) ? [] : ai.filter((a) => aiMatch(a, q));
  const humanTools = kind !== "ai";
  const statuses: [Status, string, number][] = [["active", "Current", people.filter(current).length], ["past", "Alumni", people.filter(alumnus).length], ["all", "Everyone", people.length]];
  const needing = inStatus.filter((p) => p.flags.length).length;
  const filtered = !!(q || pod || department || skill || flagged);
  const clear = () => { setQuery(""); setPod(null); setDepartment(null); setSkill(null); setFlagged(false); };
  const teamNames = [...departments.keys()].sort(); if (department && !departments.has(department)) teamNames.push(department);
  return <>
    <div className={`${styles.toolbar} ${css.bar}`}>
      <div className={css.tools}>
        {ai ? <Segmented label="Members" size="sm" value={kind} onChange={setKind} options={[{ value: "people", label: "People" }, { value: "ai", label: "AI" }, { value: "all", label: "All" }]} /> : null}
        {humanTools ? <div suppressHydrationWarning className={styles.segmented} role="group" aria-label="Status">
          {statuses.map(([key, label, n]) => <button key={key} type="button" className={styles.segment} aria-pressed={status === key} onClick={() => setStatus(key)}>{label}<span className={styles.muted}>{n}</span></button>)}
        </div> : null}
        <label className={css.searchBox}><Search size={14} aria-hidden="true" /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name, employee ID, role, skill…" aria-label="Search the team" /></label>
      </div>
      <div className={css.tools}>
        {needing && humanTools && staff ? <button type="button" className={css.chip} aria-pressed={flagged} onClick={() => setFlagged(!flagged)} title="Records where the sources disagree"><CircleAlert size={13} aria-hidden="true" />To confirm<small>{needing}</small></button> : null}
        <Why detail="“Current” means named in a current team list or the newest salary sheet; everyone else stays listed as “not current” until HR confirms." more={`${POD_TEAM.pod} ${POD_TEAM.team}`} />
        <div suppressHydrationWarning className={styles.segmented} role="group" aria-label="View" onKeyDown={(event) => { if (["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); const next = view === "cards" ? "list" : "cards"; setView(next); event.currentTarget.querySelector<HTMLButtonElement>(`button[aria-label="${next === "list" ? "List" : "Cards"}"]`)?.focus(); } }}>
          <button type="button" className={`${styles.segment} ${css.viewBtn}`} aria-pressed={view === "cards"} aria-label="Cards" title="Cards" onClick={() => setView("cards")}><LayoutGrid size={15} aria-hidden="true" /></button>
          <button type="button" className={`${styles.segment} ${css.viewBtn}`} aria-pressed={view === "list"} aria-label="List" title="List" onClick={() => setView("list")}><List size={15} aria-hidden="true" /></button>
        </div>
      </div>
    </div>
    {humanTools ? <div className={`${styles.toolbar} ${css.bar}`}>
      <div className={css.filterGroup} role="group" aria-label="Pod">
        <span className={css.filterLabel} title={POD_TEAM.pod}>Pod</span>
        {podOrder.filter((name) => podCounts.has(name) || pod === name).map((name) => <button key={name} type="button" className={css.chip} aria-pressed={pod === name} onClick={() => setPod(pod === name ? null : name)}>{name}<small>{podCounts.get(name) ?? 0}</small></button>)}
      </div>
      <div className={css.tools}>
        {filtered ? <button type="button" className={css.clear} onClick={clear}>Clear filters</button> : null}
        <label className={css.pick} data-on={department ? "" : undefined} title={POD_TEAM.team}><span>Team</span>
          <SelectField value={department ?? ""} onChange={(event) => setDepartment(event.target.value || null)} aria-label="Team">
            <option value="">All</option>{teamNames.map((name) => <option key={name} value={name}>{name} ({departments.get(name) ?? 0})</option>)}
          </SelectField><ChevronDown size={13} aria-hidden="true" /></label>
        {skillChips.length ? <label className={css.pick} data-on={skill ? "" : undefined}><span>Skill</span>
          <SelectField value={skill ?? ""} onChange={(event) => setSkill(event.target.value || null)} aria-label="Skill">
            <option value="">Any</option>{skillChips.map(([key, n]) => <option key={key} value={key}>{skillNames.get(key) ?? key} ({n})</option>)}
          </SelectField><ChevronDown size={13} aria-hidden="true" /></label> : null}
      </div>
    </div> : null}
    {aiError && kind !== "people" ? <div role="status" aria-label="AI employees unavailable" className={`${styles.panel} ${styles.panelHead}`}><span>AI employees didn’t load</span><RetryButton /></div> : null}
    {aiError && kind !== "people" && !ordered.length ? null
      : kind === "ai" && !ai?.length ? <section className={styles.panel}><Empty icon={UserRoundSearch} first title="No AI employees yet" text="An AI employee an admin adds appears here with its employee ID, owner, lane and the budget it has left today." /></section>
      : !ordered.length && !aiShown.length ? <section className={styles.panel}><Empty icon={UserRoundSearch} first title="Nobody matches" text={idNo !== null ? `No ${status === "active" ? "current " : ""}team member has the employee ID ${userId(idNo, orgCode)}, and nothing else matches “${query.trim()}”.` : "Try a different search, or clear the filters."}><button type="button" className={styles.btn} onClick={clear}>Clear filters</button></Empty></section>
      : view === "cards" ? (
        <Pager key="cards" primary stretch unit="people" mobile={12}>
          {ordered.length ? <div className={css.cards} data-items="">{ordered.map((p) => {
            const skills = skillsOf(p); const since = p.joinedOn ? tenure(p.joinedOn) : null;
            return (
              // One compact card: who, what they do, where they sit and since when, with no hollow band in between.
              <Link key={p.id} href={`/people/${p.id}`} className={`${css.card} ${css.tight}`} data-status={p.status} title={`${p.name} · ${p.role}`}>
                <Avatar name={p.name} id={p.id} photoAt={p.photoAt} size={44} status />
                <span className={css.cardText}>
                  <span className={css.cardHead}><span className={css.cardName}>{p.name}{p.id === viewer ? <span className={css.you}> · you</span> : null}</span>
                    {p.flags.length ? <span className={css.confirm} title="Needs confirmation: the sources disagree about this record"><CircleAlert size={14} aria-hidden="true" /><span className={styles.srOnly}>Needs confirmation</span></span> : null}
</span>
                  <span className={css.cardLine}><span className={css.cardRole}>{p.role}</span><span className={css.empId} title="Employee ID" data-none={p.userNo ? undefined : ""}><span className={styles.srOnly}>Employee ID </span>{userId(p.userNo, orgCode) ?? "No ID yet"}</span></span>
                  <span className={css.cardTags}>
                    {/* Where someone is in their lifecycle comes first: it is what the row is about when it is there. */}
                    <StageBadge p={p} />
                    {p.pod ? <Badge tone={p.pod.startsWith("Pod") ? "accent" : "neutral"}>{p.pod}</Badge> : null}
                    {p.department && p.department !== p.pod ? <Badge>{p.department}</Badge> : null}
                    {skills.slice(0, 2).map((s) => <span key={s} className={css.skillTag} title={s}>{s}</span>)}
                    {skills.length > 2 ? <span className={css.skillTag} title={skills.slice(2).join(", ")}>+{skills.length - 2}</span> : null}
                  </span>
                  <span className={css.cardFacts}>{[p.managerName ? `Reports to ${p.managerName.split(/\s+/)[0]}` : null, p.joinedOn ? `Joined ${monthYear(p.joinedOn)}${!current(p) && p.leftOn ? ` · ${tenure(p.joinedOn, p.leftOn) ?? "a short time"} with the team` : since && since !== "under a month" ? ` · ${since}` : ""}` : null].filter(Boolean).join(" · ")
                    || (p.accounts.length ? `${plural(p.accounts.length, "account")} linked` : "No joining date yet")}</span>
                </span>
              </Link>
            );
          })}</div> : null}
          {aiShown.length ? <>{ordered.length ? <div className={styles.subhead} data-pager-head="">AI employees</div> : null}<div className={css.cards} data-items=""><AiCards rows={aiShown} /></div></> : null}
        </Pager>
      ) : (
        <Pager key="list" primary unit="people" mobile={12}>
          <section className={`${styles.panel} ${css.roster}`}>{ordered.length ? <table className={styles.table}>
            {/* With AI rows below, each table's head goes with its rows from page to page. */}
            <thead data-pager-head={aiShown.length ? "" : undefined}><tr><th scope="col">Member</th><th scope="col">Employee ID</th><th scope="col">Role</th><th scope="col">Pod</th><th scope="col" data-wide="">Team</th><th scope="col">Reports to</th><th scope="col" data-mid="">Joined</th><th scope="col" data-wide="">Skills</th><th scope="col">Status</th></tr></thead>
            <tbody>{ordered.map((p) => { const skills = skillsOf(p); return (
              <tr key={p.id}>
                <td><Link href={`/people/${p.id}`} className={styles.person}><Avatar name={p.name} id={p.id} photoAt={p.photoAt} size={32} status /><span><span className={`${styles.cellLink} ${styles.nowrap}`}>{p.name}</span>{p.username ? <span className={styles.cellSub}>{p.username}</span> : null}</span></Link></td>
                <td className={`${styles.nowrap} ${styles.mono}`}>{userId(p.userNo, orgCode) ?? <span className={styles.muted}>None</span>}</td>
                <td><span className={css.clip} title={p.role}>{p.role}</span></td><td className={styles.nowrap}>{p.pod ?? <span className={styles.muted}>No pod</span>}</td><td data-wide="" className={styles.nowrap}>{p.department ?? <span className={styles.muted}>Not set</span>}</td>
                <td className={styles.nowrap}>{p.managerId ? <Link href={`/people/${p.managerId}`} className={styles.cellLink}>{p.managerName}</Link> : <span className={styles.muted}>Not set</span>}</td>
                <td data-mid="" className={styles.nowrap}>{p.joinedOn ? <span title={tenure(p.joinedOn) ?? undefined}>{dayYear(p.joinedOn)}</span> : <span className={styles.muted}>Not known</span>}</td>
                <td data-wide="">{skills.length ? <span className={css.skillCell} title={skills.join(", ")}>{skills.slice(0, 3).join(", ")}{skills.length > 3 ? ` +${skills.length - 3}` : ""}</span> : <span className={styles.muted}>None listed</span>}</td>
                <td className={styles.nowrap}>{current(p) && !STAGE_BADGE[p.stage ?? ""] && !p.possiblyLeft ? <Badge tone="success">Current</Badge> : <StageBadge p={p} />}{p.flags.length ? <span className={css.confirm} title={`To confirm: ${p.flags.map((f) => f.replace("_", " ").replace("identity", "name")).join(", ")}`}> <CircleAlert size={14} aria-hidden="true" /><span className={styles.srOnly}>Needs confirmation</span></span> : null}</td>
              </tr>
            ); })}</tbody>
          </table> : null}{aiShown.length ? <AiTable rows={aiShown} paged={ordered.length > 0} /> : null}</section>
        </Pager>
      )}
  </>;
}
