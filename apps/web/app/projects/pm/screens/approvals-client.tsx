"use client";
// PM-UI: the interactive part of Approvals: tabs, row selection, the phone detail sheet, the "Request changes" comment
// box (closed until tapped; comment required), the locked decision after changes were asked (SPEC §1.8) and "Remind
// client". Works on local state for the preview; pass the callbacks to wire real data (or post to each action's href).
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, ChevronRight, FileText, Inbox, Lock, MessageSquare, Pin, Play, Send, Volume2, X } from "lucide-react";
import type { ApprovalMedia, ApprovalsVM, ClientApproval, PinnedComment, TeamApproval } from "../contract/approvals";
import type { IsoDate, ProjectRef } from "../contract/shared";
import { Chip, LateFlag, PersonLine, PmButton, ProjectTile, firstName, fmtDay, fmtDayShort, hued, nDays } from "../kit";
import css from "./approvals.module.css";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
const PHONE = "(max-width: 599.98px)";

type Props = {
  vm: ApprovalsVM;
  /** Called on Approve (after it the item leaves the list). */ onApprove?: (id: string) => void;
  /** Called on Send request with the required comment. */ onRequestChanges?: (id: string, comment: string) => void;
  /** Called on Remind client. */ onRemind?: (id: string) => void;
};
type Compose = { open: boolean; text: string; error?: string };

/** Late first (most days late), then by due day. */
const sortTeam = (list: TeamApproval[]) => [...list].sort((a, b) => (b.late?.days ?? 0) - (a.late?.days ?? 0) || a.due.localeCompare(b.due));
const dueWords = (due: IsoDate, today: IsoDate) => (due === today ? "Due today" : `Due ${fmtDay(due)}`);
const roundWords = (r: TeamApproval["round"]) => `v${r.version} · ${r.round > r.maxRounds ? "Extra round" : `Round ${r.round} of ${r.maxRounds}`}`;

export default function ApprovalsClient({ vm, onApprove, onRequestChanges, onRemind }: Props) {
  const uid = useId();
  const [tab, setTab] = useState(vm.tab);
  const [team, setTeam] = useState(() => sortTeam(vm.team));
  const client = [...vm.client].sort((a, b) => b.waitingDays - a.waitingDays);
  const [teamSel, setTeamSel] = useState<string | undefined>(() => (vm.tab === "team" && vm.selectedId) || sortTeam(vm.team)[0]?.id);
  const [clientSel, setClientSel] = useState<string | undefined>(() => (vm.tab === "client" && vm.selectedId) || client[0]?.id);
  const [sheetOpen, setSheetOpen] = useState(vm.sheetOpen && vm.tab === "team");
  const [compose, setCompose] = useState<Compose>(vm.compose ?? { open: false, text: "" });
  const [reminded, setReminded] = useState<Record<string, true>>({});
  const [notice, setNotice] = useState("");
  const closeRef = useRef<HTMLButtonElement>(null);

  const item = team.find((t) => t.id === teamSel) ?? team[0];
  const citem = client.find((c) => c.id === clientSel) ?? client[0];

  useEffect(() => {
    if (!sheetOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSheetOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheetOpen]);

  const pick = (id: string) => {
    if (id !== teamSel) setCompose({ open: false, text: "" });
    setTeamSel(id);
    setNotice("");
    if (window.matchMedia(PHONE).matches) { setSheetOpen(true); requestAnimationFrame(() => closeRef.current?.focus()); }
  };

  const approve = (t: TeamApproval) => {
    onApprove?.(t.id);
    const rest = team.filter((x) => x.id !== t.id);
    setTeam(rest);
    setTeamSel(rest[0]?.id);
    setSheetOpen(false);
    setCompose({ open: false, text: "" });
    setNotice(`Approved: ${t.title}. ${firstName(t.requestedBy)} can send it on.`);
  };
  const send = (t: TeamApproval) => {
    const text = compose.text.trim();
    if (!text) { setCompose({ ...compose, error: "Comment is required" }); return; }
    onRequestChanges?.(t.id, text);
    const lock = `Locked until ${firstName(t.requestedBy)} uploads v${t.round.version + 1}`;
    setTeam(team.map((x) => x.id !== t.id ? x : {
      ...x, state: "changes_requested",
      changes: { by: vm.viewer.person, at: vm.today, text, waitingFor: t.requestedBy, nextVersion: t.round.version + 1 },
      actions: { approve: { ...x.actions.approve, disabledReason: lock }, requestChanges: { ...x.actions.requestChanges, disabledReason: lock }, sendRequest: { ...x.actions.sendRequest, disabledReason: lock } },
    }));
    setCompose({ open: false, text: "" });
    setNotice(`Changes asked on ${t.title}. ${firstName(t.requestedBy)} has been told.`);
  };
  const remind = (c: ClientApproval) => { onRemind?.(c.id); setReminded({ ...reminded, [c.id]: true }); };

  const decision = (t: TeamApproval, where: "pane" | "sheet") => <Decision item={t} where={where} idBase={`${uid}-${where}`} compose={compose} setCompose={setCompose} onApprove={() => approve(t)} onSend={() => send(t)} />;

  return <div className={css.screen}>
    <header className={css.head}>
      <h1 className={css.h1}>Approvals</h1>
      <div className={css.tabs} role="tablist" aria-label="Approvals">
        {(["team", "client"] as const).map((k) => {
          const count = k === "team" ? team.length : client.length;
          return <button key={k} type="button" role="tab" id={`${uid}-tab-${k}`} aria-controls={`${uid}-panel`} aria-selected={tab === k} tabIndex={tab === k ? 0 : -1}
            className={css.tab} onClick={() => { setTab(k); setSheetOpen(false); setNotice(""); }}
            onKeyDown={(e) => { if (e.key === "ArrowRight" || e.key === "ArrowLeft") { const n = k === "team" ? "client" : "team"; setTab(n); document.getElementById(`${uid}-tab-${n}`)?.focus(); } }}>
            {vm.tabs[k].label} ({count})
          </button>;
        })}
      </div>
      <p className={css.helper}>{vm.helper}</p>
      <p className={css.notice} role="status" aria-live="polite">{notice}</p>
    </header>

    <div id={`${uid}-panel`} role="tabpanel" aria-labelledby={`${uid}-tab-${tab}`} className={css.panel}>
      {tab === "team" ? (
        !item ? <EmptyCard title="Nothing is waiting for you" sub="New review requests from the team show up here." action={<PmButton variant="outline" size="lg" onClick={() => setTab("client")}>{vm.emptyAction.label}</PmButton>} /> :
        <div className={css.split}>
          <ul className={css.list} aria-label="Waiting for your review">
            {team.map((t) => <li key={t.id} className={css.li}>
              <button type="button" className={css.row} data-kind="team" aria-current={t.id === item.id ? "true" : undefined} onClick={() => pick(t.id)}>
                <span className={css.tileCell}><ProjectTile project={t.project} label /></span>
                <Thumb media={t.media} project={t.project} />
                <span className={css.title}><span className={css.chipFloat}><TeamChip item={t} /></span>{t.title}</span>
                <span className={css.chipCell}><TeamChip item={t} /></span>
                <ProjectPill project={t.project} />
                <span className={css.round}>{roundWords(t.round)}</span>
                <span className={css.mid}>
                  <span className={css.who}>Requested by <b>{firstName(t.requestedBy)}</b></span>
                  <span className={css.due} data-late={t.late ? "" : undefined}>{dueWords(t.due, vm.today)}</span>
                </span>
                <ChevronRight className={css.chev} aria-hidden="true" />
              </button>
            </li>)}
          </ul>
          <section className={css.pane} aria-label={`Selected: ${item.title}`} data-compose={compose.open ? "" : undefined}>
            <TeamDetailHead item={item} today={vm.today} level="pane" />
            <BigMedia media={item.media} project={item.project} />
            <DetailNotes item={item} />
            {decision(item, "pane")}
          </section>
        </div>
      ) : (
        !citem ? <EmptyCard title="Nothing is waiting on clients" sub="Items you send to a client show up here until they decide." /> :
        <div className={css.split}>
          <ul className={css.list} aria-label="Waiting on clients">
            {client.map((c) => <li key={c.id} className={cx(css.li, css.row)} data-kind="client" aria-current={c.id === citem.id ? "true" : undefined}>
              <button type="button" className={css.hit} aria-label={`Show ${c.title}`} aria-pressed={c.id === citem.id} onClick={() => setClientSel(c.id)} />
              <span className={css.tileCell}><ProjectTile project={c.project} label /></span>
              <Thumb media={c.media} project={c.project} />
              <span className={css.title}>{c.title}</span>
              <ProjectPill project={c.project} />
              <span className={css.round}>{roundWords(c.round)}</span>
              <span className={css.who}>Sent to client {fmtDay(c.sentAt)}</span>
              <span className={css.foot}>
                <span className={css.chipCell}><Chip tone="waiting">Waiting on client · {nDays(c.waitingDays)}</Chip></span>
                <RemindButton item={c} sent={!!reminded[c.id]} onClick={() => remind(c)} />
              </span>
            </li>)}
          </ul>
          <section className={css.pane} aria-label={`Selected: ${citem.title}`}>
            <header className={css.dHead}>
              <h2 className={css.dTitle}>{citem.title}</h2>
              <Chip tone="waiting">Waiting on client · {nDays(citem.waitingDays)}</Chip>
            </header>
            <ProjectPill project={citem.project} />
            <p className={css.dMeta}><span>{roundWords(citem.round)}</span> <span>· Sent to client {fmtDay(citem.sentAt)}</span></p>
            <BigMedia media={citem.media} project={citem.project} />
            <p className={css.muted}>The client decides here. You can send a reminder; it goes by WhatsApp and e-mail.</p>
            <div className={css.actions}><RemindButton item={citem} sent={!!reminded[citem.id]} onClick={() => remind(citem)} size="lg" /></div>
          </section>
        </div>
      )}
    </div>

    {/* Phone only (hidden from 600 px): the detail sheet over the dimmed list. */}
    {tab === "team" && item && sheetOpen ? <div className={css.layer} onClick={(e) => { if (e.target === e.currentTarget) setSheetOpen(false); }}>
      <div className={css.sheet} data-compose={compose.open ? "" : undefined} role="dialog" aria-modal="true" aria-labelledby={`${uid}-sheet-title`}>
        <span className={css.grip} aria-hidden="true" />
        <div className={css.sheetScroll}>
          <div className={css.sheetTop}>
            <h2 id={`${uid}-sheet-title`} className={css.dTitle}>{item.title}</h2>
            <button ref={closeRef} type="button" className={css.close} aria-label="Close" onClick={() => setSheetOpen(false)}><X aria-hidden="true" /></button>
          </div>
          <TeamDetailHead item={item} today={vm.today} level="sheet" />
          <BigMedia media={item.media} project={item.project} />
          <DetailNotes item={item} />
        </div>
        <div className={css.sheetFoot}>{decision(item, "sheet")}</div>
      </div>
    </div> : null}
  </div>;
}

/* ---------- Pieces ---------- */

/** One chip per row: Late replaces Your turn; after changes were asked, "Changes asked" (the ball is with the owner). */
function TeamChip({ item }: { item: TeamApproval }) {
  if (item.state === "changes_requested") return <Chip tone="waiting">Changes asked</Chip>;
  if (item.late) return <LateFlag late={item.late} />;
  return item.toReview ? <Chip tone="action">Your turn</Chip> : <Chip tone="waiting">In review</Chip>;
}

/** The project as a small tag in its colour (no icon: the row already has the project tile). */
function ProjectPill({ project }: { project: ProjectRef }) {
  return <span {...hued(project.hue, css.pill)}><span>{project.name}</span></span>;
}

function TeamDetailHead({ item, today, level }: { item: TeamApproval; today: IsoDate; level: "pane" | "sheet" }) {
  // Each "·" starts the next nowrap piece, so a line never ends on a dangling dot.
  const meta = <p className={css.dMeta}><span>{roundWords(item.round)}</span> <span>· Requested by {firstName(item.requestedBy)}</span> <span>· {dueWords(item.due, today)}</span></p>;
  if (level === "sheet") return <div className={css.dHeadSheet}><span className={css.tagRow}><ProjectPill project={item.project} /><TeamChip item={item} /></span>{meta}</div>;
  return <>
    <header className={css.dHead}><h2 className={css.dTitle}>{item.title}</h2><TeamChip item={item} /></header>
    <ProjectPill project={item.project} />
    {meta}
  </>;
}

/** The note after changes were asked, then the pinned comments. */
function DetailNotes({ item }: { item: TeamApproval }) {
  return <>
    {item.state === "changes_requested" && item.changes ? <div className={css.locked}>
      <Lock aria-hidden="true" />
      <div>
        <p className={css.lockedTitle}>Changes asked on {fmtDay(item.changes.at)}</p>
        <p className={css.muted}>Approve and Request changes unlock when {firstName(item.changes.waitingFor)} uploads v{item.changes.nextVersion}.</p>
        <p className={css.quote}>“{item.changes.text}”</p>
      </div>
    </div> : null}
    <Pinned comments={item.pinned} />
  </>;
}

function Pinned({ comments }: { comments: PinnedComment[] }) {
  return <section className={css.pinned} aria-label="Pinned comments">
    <h3 className={css.h3}><Pin aria-hidden="true" />Pinned comments ({comments.length})</h3>
    {comments.length ? <ul className={css.comments}>
      {comments.map((c) => <li key={c.id} className={css.comment}>
        <PersonLine person={c.by} size={28} meta={`${fmtDayShort(c.at)} · Round ${c.round}`} />
        <p>{c.text}</p>
      </li>)}
    </ul> : <p className={css.muted}>No pinned comments yet. This is the first round.</p>}
  </section>;
}

function Decision({ item, where, idBase, compose, setCompose, onApprove, onSend }: { item: TeamApproval; where: "pane" | "sheet"; idBase: string; compose: Compose; setCompose: (c: Compose) => void; onApprove: () => void; onSend: () => void }) {
  const { approve, requestChanges, sendRequest } = item.actions;
  const lockedWhy = item.state === "changes_requested" ? approve.disabledReason ?? "Locked until a new version is uploaded" : undefined;
  if (lockedWhy) return <div className={css.decision} data-where={where}>
    <div className={css.actions}>
      <PmButton variant="outline" size="lg" icon={Check} disabled aria-describedby={`${idBase}-why`}>{approve.label}</PmButton>
      <PmButton variant="outline" size="lg" icon={MessageSquare} disabled aria-describedby={`${idBase}-why`}>{requestChanges.label}</PmButton>
    </div>
    <p id={`${idBase}-why`} className={css.why}><Lock aria-hidden="true" />{lockedWhy}</p>
  </div>;

  if (compose.open) return <div className={css.decision} data-where={where}>
    <label htmlFor={`${idBase}-comment`} className={css.label}>What should change? (required)</label>
    <textarea id={`${idBase}-comment`} className={css.textarea} rows={3} value={compose.text} aria-invalid={compose.error ? true : undefined}
      aria-describedby={compose.error ? `${idBase}-err` : undefined} placeholder="Say what to change, so the next version gets it right"
      onChange={(e) => setCompose({ open: true, text: e.target.value })} />
    {compose.error ? <p id={`${idBase}-err`} className={css.error}>{compose.error}</p> : null}
    <div className={css.actions} data-compose="">
      <PmButton variant="primary" size="lg" icon={Send} onClick={onSend}>{sendRequest.label}</PmButton>
      <button type="button" className={css.cancel} onClick={() => setCompose({ open: false, text: "" })}>Cancel</button>
    </div>
  </div>;

  return <div className={css.decision} data-where={where}>
    <div className={css.actions}>
      <PmButton variant="primary" size="lg" icon={Check} onClick={onApprove}>{approve.label}</PmButton>
      <PmButton variant="outline" size="lg" icon={MessageSquare} onClick={() => setCompose({ open: true, text: "" })}>{requestChanges.label}</PmButton>
    </div>
  </div>;
}

function RemindButton({ item, sent, onClick, size = "md" }: { item: ClientApproval; sent: boolean; onClick: () => void; size?: "md" | "lg" }) {
  return <PmButton variant="outline" size={size} className={css.remind} disabled={sent} onClick={onClick} aria-label={sent ? `Reminder sent for ${item.title}` : `${item.remind.label}: ${item.title}`}>
    {sent ? "Reminder sent" : item.remind.label}
  </PmButton>;
}

function EmptyCard({ title, sub, action }: { title: string; sub: string; action?: ReactNode }) {
  return <section className={css.empty} aria-label={title}>
    <span className={css.emptyIcon} aria-hidden="true"><Inbox /></span>
    <h2 className={css.emptyTitle}>{title}</h2>
    <p className={css.muted}>{sub}</p>
    {action}
  </section>;
}

/* ---------- Media placeholders (CSS art in the project's colour; no images) ---------- */

const mediaLabel = (m: ApprovalMedia) => (m.kind === "video" ? `Video, ${m.length}` : m.kind === "pdf" ? `PDF · ${m.pages} pages` : "Image");

function Thumb({ media, project }: { media: ApprovalMedia; project: ProjectRef }) {
  return <span {...hued(project.hue, css.thumb)} data-kind={media.kind} role="img" aria-label={mediaLabel(media)}>
    {media.kind === "pdf" ? <><span className={css.page} aria-hidden="true"><b>PDF</b></span><span className={css.badge}>{media.pages} pages</span></> :
      <>
        <span className={css.art} aria-hidden="true" />
        {media.kind === "video" ? <span className={css.badge}><Play aria-hidden="true" />{media.length}</span> : null}
      </>}
  </span>;
}

function BigMedia({ media, project }: { media: ApprovalMedia; project: ProjectRef }) {
  if (media.kind === "pdf") return <figure className={css.player} aria-label={`Preview: ${mediaLabel(media)}`}>
    <span {...hued(project.hue, css.stage)} data-kind="pdf"><span className={css.bigPage} aria-hidden="true"><FileText /><b>PDF</b></span></span>
    <figcaption className={css.controls}><FileText aria-hidden="true" /><span>Page 1 of {media.pages}</span><span className={css.spacer} /><span>PDF · {media.pages} pages</span></figcaption>
  </figure>;
  return <figure className={css.player} aria-label={`Preview: ${mediaLabel(media)}`}>
    <span {...hued(project.hue, css.stage)}>
      <span className={css.art} aria-hidden="true" />
      {media.kind === "video" ? <span className={css.bigPlay} aria-hidden="true"><Play /></span> : null}
    </span>
    {media.kind === "video" ? <figcaption className={css.controls}>
      <Play aria-hidden="true" />
      <span className={css.time}>0:00 / {media.length}</span>
      <span className={css.track} aria-hidden="true"><i /></span>
      <Volume2 aria-hidden="true" />
    </figcaption> : null}
  </figure>;
}
