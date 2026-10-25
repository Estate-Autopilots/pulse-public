import Link from "next/link";
import { ChevronRight, Compass, Flag, GitBranch, History, Hourglass, Inbox, Link2, ListTree, MessageSquare, Paperclip, Repeat, Sparkles, Timer, Unlock, Users } from "lucide-react";
import type { ReactNode } from "react";
import { api, apiV1, getMe } from "../../lib/api";
import { dayTime, plural } from "../../lib/format";
import { urgency, whyLine } from "../../lib/task-sense.mjs";
import { Avatar, Message, Page, PageHeader, styles } from "../../ui";
import { BlockerForm, ProofForm, QuickAdd, RemoveAttachment, RemoveProof, TaskRow, UnblockButton } from "../client";
import { AvatarStack, ProjectChip, UrgencyChip, protectedFor } from "../chips";
import { HowToFinish, SameWork, TaskActions } from "../focus";
import { Chip, PRIORITY, STATUS, dayMonthYear } from "../parts";
import { ProofIcon, ProofOpen, ProofViewer } from "../proof-viewer";
import type { Detail, Options } from "../types";
import { AskBanner } from "../work-client";
import { Threads } from "../threads";
import { DueEdit, HeroPeople, MemberList, ProjectMove, TagEditor } from "../task-people";
import { ValueCard } from "../value-card";
import { AskEstimate, TimeCard } from "../time-card";
import { KindChip, kindOf } from "../../work-kind";
import { StateBanner, Stepper, Timeline } from "../life-view";
import { ReviewBar } from "../life";
import { StepBanner } from "../../sops/run-parts";
import { FlowStepBanner } from "../../steps/banner";
import css from "../tasks.module.css";
import f from "../focus.module.css";
import tp from "./task-page.module.css";
import { orgZone } from "../../lib/brand-server";
import { zoneDay } from "../../lib/zone.mjs";
import { proposeFor, shellRole, targetFor } from "../../destinations/propose.mjs";
import { DoneWhen, GoThere, type CompanionState } from "../go-there";
import { QuoteFollowUp } from "../../erp/followup";

type StepInfo = { id: string; runId: string; position: number; of: number; kind: string; status: string; run: string; workflow: string; canDecide: boolean; choices: string[]; formId: string | null; canFill: boolean };

/** The request's moment: server components render once per request. */
const clock = () => Date.now();

const hours = (m: number) => m < 60 ? `${m} min` : `${Math.round(m / 6) / 10} h`;
const first = (name: string | null | undefined) => String(name ?? "").split(" ")[0];

/** A collapsible section; an empty one is a single line. */
function Section({ title, icon, count, open, children }: { title: string; icon: ReactNode; count?: ReactNode; open?: boolean; children: ReactNode }) {
  return <details className={f.section} open={open}><summary><h3>{icon}{title}</h3>{count ? <small>{count}</small> : null}</summary><div className={f.sectionBody}>{children}</div></details>;
}
function Line({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return <div className={f.line}>{icon}<h3>{title}</h3>{children}</div>;
}

export default async function TaskPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ask?: string; finish?: string }> }) {
  const { id } = await params; const q = await searchParams;
  const [r, o, wf, cp, me, fs] = await Promise.all([api<Detail>(`tasks/${encodeURIComponent(id)}`), api<Options>("tasks/options"), api<{ step: StepInfo | null }>(`workflows/task/${encodeURIComponent(id)}`),
    api<{ companion: CompanionState; repeat: string | null }>(`tasks/${encodeURIComponent(id)}/companion`), getMe(),
    apiV1<{ step: { id: string; runId: string; key: string; title: string; stateText: string; run: string; process: string } | null }>(`/v1/flow/task/${encodeURIComponent(id)}`)]);
  if (r.error) return <Message text={r.error} />;
  const d = r.data!; const t = d.task; const zone = await orgZone(); const today = zoneDay(zone, clock()); const options = o.data;
  const now = clock(); const u = urgency(t, now);
  const doer = !!d.me && d.me === t.assigneeId;
  const minutes = d.time.filter((e) => e.status === "confirmed").reduce((n, e) => n + e.minutes, 0);
  const unlocks = d.unlocks ?? { tasks: [], now: 0, people: 0, minutes: 0, chain: { tasks: 0, minutes: 0, people: 0 } };
  const waitingPeople = unlocks.tasks.map((w) => ({ id: w.personId, name: w.personName, photoAt: w.photoAt }));
  const why = whyLine(t, d.project?.summary ?? null);
  const done = ["done", "in_review", "accepted"].includes(t.status);
  const canTick = doer || d.can.edit;
  const live = d.children.filter((c) => c.status !== "cancelled"), closedSubs = live.filter((c) => ["done", "accepted", "in_review"].includes(c.status)).length;
  const openSubs = d.children.filter((c) => ["open", "in_progress", "blocked", "unknown"].includes(c.status)).length;
  const subtaskCount = `${closedSubs} of ${live.length} done${openSubs && done ? ` · ${openSubs} still open` : ""}`;
  // UX-5B: where this task is done ("Go to Office presence") and how Pulse can tell it is (Pip's proposal, confirmed signals).
  const companion = cp.data?.companion ?? null; const role = shellRole(me.data?.role); const modulesOff = me.data?.modules?.off;
  const target = targetFor({ title: t.title, notes: t.notes, target: companion?.target }, { role, modulesOff });
  const proposal = proposeFor({ title: t.title, notes: t.notes, target: companion?.target });
  const closed = done || t.status === "cancelled"; const canSet = doer || d.can.edit;
  // Owner workbench (21 Oct 2026): the task page redesigned. One calm reading column (where it sits, its title, why it
  // matters, where it stands with its one next action, then only the sections that hold something, the discussion and
  // the history) beside one properties panel where every fact is edited in place. Nothing was taken away: the panels that
  // repeated the same facts (Details, People, the hero's fact row) became the properties panel.
  // E2E-4P: a client's seat (or a partner's) sees the task, their own next step and the discussion: none of the staff
  // tools (people, tags, projects, waiting-on, Pip's "where it is done", value, time by hand).
  // SIM-CLIENTS (R132): nor the time estimate or Pip's plan (a client approving a reel was asked how long it would take).
  const client = me.data?.side === "client";
  const editable = d.can.edit && !done && !client;
  const open = !done && t.status !== "cancelled";
  return (
    <Page>
      <PageHeader title={t.title} back={{ href: "/tasks", label: "Work" }} recent={{ title: t.title }}
        context={[d.project ? <span key="p" className={css.ctxProject}><KindChip kind={kindOf(d.project.kind)} short /></span> : null,
          // QA-1024: an internal project's category is often "Internal" too: say it once.
          t.projectCategoryLabel && !(d.project && kindOf(d.project.kind) === "internal" && /^internal$/i.test(t.projectCategoryLabel.trim())) ? t.projectCategoryLabel : null]} />
      {d.asks.filter((a) => a.incoming || a.actions.length).map((a) => <AskBanner key={a.id} ask={a} highlight={q.ask === a.id} />)}
      {wf.data?.step ? <StepBanner step={wf.data.step} /> : null}
      {fs.data?.step ? <FlowStepBanner taskId={id} step={fs.data.step} /> : null}
      <div className={tp.layout} data-dock={open ? "" : undefined}>
        <div className={tp.main}>
          {t.projectId || d.parents.length ? <nav className={tp.crumbs} aria-label="Where this task sits">
            {t.projectId ? <Link href={`/tasks/projects/${t.projectId}`}>{t.projectName}</Link> : null}
            {d.parents.map((p) => <span key={p.id}><ChevronRight size={12} aria-hidden="true" /><Link href={`/tasks/${p.id}`}>{p.title}</Link></span>)}
            {d.blockedBy.length || d.blocks.length || d.children.length ? <Link className={tp.crumbMap} href={t.projectId ? `/tasks/map?project=${t.projectId}` : `/tasks/map?person=${t.assigneeId ?? ""}`}><GitBranch size={12} aria-hidden="true" />Map</Link> : null}
          </nav> : null}
          <div className={tp.stepper}><Stepper status={t.status} /></div>
          {why ? <p className={tp.why}><Sparkles size={15} aria-hidden="true" /><span>{why}</span></p> : null}
          <StateBanner d={d} now={now} dock={open} actions={<TaskActions d={d} options={options ?? null} finishNow={q.finish === "1"} repeat={cp.data?.repeat ?? null} client={client} />} />
          {d.can.accept && d.life ? <ReviewBar d={d} /> : null}
          {t.source === "quote_followup" && t.sourceRef ? <QuoteFollowUp quoteId={t.sourceRef} zone={zone} title={t.title} onTask /> : null}
          {d.life?.askEstimate && !client ? <AskEstimate taskId={t.id} pip={t.suggestion?.effortMinutes ?? null} /> : null}
          {d.same?.length ? <SameWork taskId={t.id} same={d.same} canDecide={doer || d.can.edit} /> : null}

          {d.attachments?.length || (d.can.edit && open) ? <section className={tp.block} aria-label="Attachments">
            <h2 className={tp.blockHead}><Paperclip size={15} aria-hidden="true" />Attachments<small>{d.attachments?.length ? plural(d.attachments.length, "item") : "the brief, references"}</small></h2>
            {d.attachments?.length ? <ul className={f.proofs}>{d.attachments.map((a) => <li key={a.id}>
              {a.kind === "file" ? <Paperclip size={16} aria-hidden="true" /> : <Link2 size={16} aria-hidden="true" />}
              <div style={{ minWidth: 0 }}><a href={a.kind === "link" ? a.url! : `/api/v0/tasks/attachments/${a.id}`} target="_blank" rel="noreferrer">{a.label}</a>
                <div className={f.proofMeta}><span>{a.addedBy ? `${a.addedBy} · ` : ""}{dayTime(a.addedAt)}</span></div></div>
              <span>{d.can.edit ? <RemoveAttachment id={a.id} /> : null}</span>
            </li>)}</ul> : null}
            {d.can.edit && open ? <ProofForm taskId={t.id} compact to="attachments" /> : null}
          </section> : null}

          <HowToFinish taskId={t.id} notes={t.notes} checks={d.checks ?? []} canTick={canTick && !done} plan={d.plan ?? null} canPlan={!!d.me && !done && !client} />

          {d.children.length || (editable && t.status !== "cancelled") ? <section className={tp.block} aria-label="Subtasks">
            <h2 className={tp.blockHead}><ListTree size={15} aria-hidden="true" />Subtasks{d.children.length ? <small>{subtaskCount}</small> : null}</h2>
            {d.children.length ? <>
              <div className={f.progress} role="progressbar" aria-label="Subtasks finished" aria-valuemin={0} aria-valuemax={live.length} aria-valuenow={closedSubs}><i style={{ width: `${live.length ? Math.round((closedSubs / live.length) * 100) : 0}%` }} /></div>
              <ul className={css.list}>{d.children.map((c) => <TaskRow key={c.id} task={c} today={today} me={d.me} hideProject={t.projectId} />)}</ul></> : null}
            {editable ? <QuickAdd parentId={t.id} autoFocusKey={false} label="Add a subtask" placeholder="Add a subtask: Repro on Android @me tomorrow" compact /> : null}
          </section> : null}

          {d.blockedBy.length || (t.status === "blocked" && open) ? <section className={tp.block} aria-label="Waiting on">
            <h2 className={tp.blockHead}><Hourglass size={15} aria-hidden="true" />Waiting on{d.blockedBy.length ? <small>{plural(d.blockedBy.length, "task")}</small> : null}</h2>
            {d.blockedBy.length ? <ul className={css.list}>{d.blockedBy.map((b) => <li key={b.linkId} className={css.row}>
              {b.assigneeName ? <Avatar name={b.assigneeName} id={b.assigneeId ?? undefined} photoAt={b.assigneePhotoAt ?? null} size={26} /> : <Hourglass size={16} aria-hidden="true" style={{ color: "var(--theme-danger)" }} />}
              <div className={css.rowMain}><Link className={css.title} href={`/tasks/${b.id}`}>{b.title}</Link><span className={css.meta}><Chip>{STATUS[b.status]?.label ?? b.status}</Chip><span>{b.assigneeName ? `${first(b.assigneeName)} owns it` : "Nobody owns it yet"}</span><span>since {dayMonthYear(b.since.slice(0, 10))}</span>{b.note ? <span>· {b.note}</span> : null}</span></div>
              <span className={css.end}>{d.can.edit || b.assigneeId === d.me ? <UnblockButton taskId={t.id} blockerId={b.id} /> : null}</span>
            </li>)}</ul> : <p className={tp.quiet}>Marked blocked by hand. Add what it waits on so someone owns it.</p>}
            {d.can.edit && !client ? <BlockerForm taskId={t.id} people={options?.people ?? []} /> : null}
          </section> : null}

          {d.proof.length || (t.requiresProof && open) ? <section className={tp.block} aria-label="Proof">
            <h2 className={tp.blockHead}><Paperclip size={15} aria-hidden="true" />Proof<small>{t.requiresProof ? "needed before it is accepted" : plural(d.proof.length, "item")}</small></h2>
            {d.proof.length ? <ul className={f.proofs}>{d.proof.map((p) => <li key={p.id}>
              <ProofIcon proof={p} />
              <div style={{ minWidth: 0 }}><ProofOpen proof={p} />
                <div className={f.proofMeta}>{protectedFor(p) ? <span className={f.guard}>{protectedFor(p)}</span> : null}<span>{p.addedBy ? `${p.addedBy} · ` : ""}{dayTime(p.addedAt)}</span></div></div>
              <span>{d.can.edit && t.status !== "accepted" ? <RemoveProof id={p.id} /> : null}</span>
            </li>)}</ul> : null}
            {d.can.edit && t.status !== "accepted" ? <ProofForm taskId={t.id} compact /> : null}
          </section> : null}

          {unlocks.tasks.length ? <section className={tp.block} aria-label="Unlocks">
            <h2 className={tp.blockHead}><Unlock size={15} aria-hidden="true" />{done ? "Unlocked" : "Unlocks"}<small>{plural(unlocks.now || unlocks.tasks.length, "task")} for {plural(Math.max(1, unlocks.people), "person", "people")}</small></h2>
            <ul className={f.unlocks}>{unlocks.tasks.map((w) => <li key={w.id}>
              {w.personName ? <span title={w.personName}><Avatar name={w.personName} id={w.personId ?? undefined} photoAt={w.photoAt} size={26} /></span> : <span />}
              <div style={{ minWidth: 0 }}><Link href={`/tasks/${w.id}`} title={w.title}>{w.title}</Link>
                <small>{w.personName ? first(w.personName) : "Nobody yet"}{urgency(w, now).key !== "none" ? ` · ${urgency(w, now).short}` : ""}</small></div>
              <span />
            </li>)}</ul>
          </section> : null}

          <section className={tp.block} aria-label="Discussion">
            <h2 className={tp.blockHead}><MessageSquare size={15} aria-hidden="true" />Discussion{d.comments.length ? <small>{plural(d.comments.length, "comment")}</small> : null}</h2>
            <Threads taskId={t.id} comments={d.comments} canComment={!!d.me} canResolve={d.can.edit} />
          </section>
          <details className={tp.history}>
            <summary><History size={15} aria-hidden="true" />History{d.events.length ? <small>{plural(d.events.length, "change")}</small> : null}</summary>
            <Timeline events={d.events} me={d.me} now={now} task={t} />
          </details>
        </div>

        <aside className={tp.side} aria-label="About this task">
          <dl className={tp.props}>
            <dt>Status</dt><dd><Chip>{STATUS[t.status]?.label ?? t.status}</Chip></dd>
            <dt>Due</dt><dd>{u.key === "done" ? <span className={tp.muted}>{t.dueOn ? dayMonthYear(t.dueOn) : "No date"}</span> : editable ? <DueEdit taskId={t.id} dueOn={t.dueOn} today={today}><UrgencyChip task={t} now={now} /></DueEdit> : <UrgencyChip task={t} now={now} />}</dd>
            <dt>People</dt><dd><ul className={tp.people}><HeroPeople taskId={t.id} doer={{ id: t.assigneeId, name: t.assigneeName, photoAt: t.assigneePhotoAt }} me={d.me} canEdit={editable} members={d.members} reviewer={{ id: t.reviewerId, name: t.reviewerName }} /></ul></dd>
            <dt>Reviewer</dt><dd>{t.reviewerName ? <span className={tp.person}><Avatar name={t.reviewerName} id={t.reviewerId ?? undefined} size={20} />{t.reviewerId === d.me ? "You" : t.reviewerName}</span> : <span className={tp.muted}>Leadership accepts</span>}</dd>
            {client && !t.projectName ? null : <><dt>Project</dt><dd>{d.can.edit && !client ? <ProjectMove taskId={t.id} projectId={t.projectId}>{t.projectName ? <ProjectChip id={t.projectId} name={t.projectName} color={t.projectColor} icon={t.projectIcon} category={t.projectCategoryLabel} link={false} /> : <span className={tp.muted}>None</span>}</ProjectMove>
              : <ProjectChip id={t.projectId} name={t.projectName} color={t.projectColor} icon={t.projectIcon} category={t.projectCategoryLabel} />}</dd></>}
            {client && !t.tags?.length ? null : <><dt>Tags</dt><dd><TagEditor taskId={t.id} tags={t.tags ?? []} canEdit={editable} /></dd></>}
            {t.priority !== "normal" ? <><dt>Priority</dt><dd><Flag size={14} aria-hidden="true" style={{ color: t.priority === "urgent" ? "var(--theme-danger)" : t.priority === "high" ? "var(--theme-warning)" : undefined }} />{PRIORITY[t.priority]}</dd></> : null}
            {t.estimateMinutes ? <><dt>Estimate</dt><dd><Timer size={14} aria-hidden="true" />~{hours(t.estimateMinutes)}</dd></> : null}
            {t.inDomain ? <><dt>Domain</dt><dd><Compass size={14} aria-hidden="true" />{t.inDomain.title}</dd></> : null}
            {t.poolScope && !t.assigneeId ? <><dt>Pool</dt><dd><Inbox size={14} aria-hidden="true" />{t.poolScope === "company" ? "Company" : t.poolRef}</dd></> : null}
            {cp.data?.repeat ? <><dt>Repeats</dt><dd><Repeat size={14} aria-hidden="true" />Every {cp.data.repeat}</dd></> : null}
            {waitingPeople.length ? <><dt>Waiting on it</dt><dd><AvatarStack people={waitingPeople} /></dd></> : null}
          </dl>
          {/* What it waits on can still be recorded while nothing blocks it (the section beside appears once it does). */}
          {d.can.edit && !client && open && !d.blockedBy.length && t.status !== "blocked" ? <div className={tp.sideBlock}><p className={tp.sideHead}>Waiting on</p>
            <p className={tp.quiet}>Nothing: this can move now.</p><BlockerForm taskId={t.id} people={options?.people ?? []} /></div> : null}
          {!client && !closed && (target || canSet) ? <div className={tp.sideBlock}><p className={tp.sideHead}>Where it is done</p>
            <GoThere taskId={t.id} target={target ? { id: target.dest.id, button: target.button, source: target.source, via: target.via } : null} status={t.status} doer={doer}
              canSet={canSet} stored={companion?.target ?? null} role={role} modulesOff={modulesOff} /></div> : null}
          {client ? null : <DoneWhen taskId={t.id} proposal={proposal} state={companion} canSet={canSet} finished={closed} />}
          {client ? null : <ValueCard task={t} suggestion={t.suggestion ?? null} canValue={!!d.can.value}
            why={t.valueNote ? why : unlocks.tasks.length ? `Unlocks ${plural(unlocks.now || unlocks.tasks.length, "task")} for ${plural(Math.max(1, unlocks.people), "person", "people")}` : d.project?.kind === "fulfilment" && d.project.clientName ? `Client: ${d.project.clientName}` : why} />}
          {d.life && !client ? <TimeCard d={d} today={today} /> : null}
          {(d.can.edit && !client) || d.members.length ? <Section title="Everyone on it" icon={<Users size={14} aria-hidden="true" />} count={d.members.length ? plural(d.members.length, "person", "people") : undefined}>
            <MemberList taskId={t.id} members={d.members} me={d.me} canEdit={d.can.edit && !client} />
          </Section> : null}
          {client ? null : <Section title="More details" icon={<ListTree size={14} aria-hidden="true" />}>
            <dl className={css.facts} style={{ padding: 0 }}>
              {t.workOn ? <><dt>Work day</dt><dd>{dayMonthYear(t.workOn)}</dd></> : null}
              {t.projectCategoryLabel ? <><dt>Category</dt><dd>{t.projectCategoryLabel}</dd></> : null}
              {t.type ? <><dt>Type</dt><dd>{t.type}</dd></> : null}
              {t.category ? <><dt>Kind</dt><dd>{t.categoryLabel ?? t.category}</dd></> : null}
              {t.status === "accepted" ? <><dt>Review</dt><dd>{t.reviewKind === "acknowledged" ? "Accepted" : t.reviewKind === "auto" ? "Accepted with its proof" : t.reviewKind === "rated" ? ({ 5: "Great", 4: "Good", 3: "Okay", 2: "Needs work", 1: "Poor" }[t.reviewQuality ?? 0] ?? "Rated") : "Accepted"}</dd></> : null}
              <dt>Time</dt><dd>{minutes ? `${hours(minutes)} captured` : <span className={styles.muted}>None yet</span>}</dd>
              {t.source === "imported" ? <><dt>Source</dt><dd>Team tracker{t.sourcePeriod ? ` · ${t.sourcePeriod}` : ""}{t.trackerOwner ? ` · ${t.trackerOwner}` : ""}</dd></> : null}
            </dl>
          </Section>}
        </aside>
      </div>
      <ProofViewer proofs={d.proof} />
    </Page>
  );
}
