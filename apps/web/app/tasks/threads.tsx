"use client";
// TASKS-4B: discussion as threads. Replies sit under what they answer (like Reddit), with @mentions as chips; a thread
// can be resolved and reopened (a resolved one folds to a line). "Ask for help" posts a help request to the thread and
// tells the right people (shown before asking: the reviewer, the head, collaborators, people whose domains fit). Once a
// help thread is resolved, whoever asked rates each helper (Helpful / Somewhat / Not helpful): privately; helpers see
// only their totals and helping earns a little credit.
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AtSign, Check, CornerDownRight, HelpCircle, LifeBuoy, MessageSquareReply, RotateCcw, Send, Trash2 } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { Tooltip } from "../kit";
import { post } from "../records";
import { Avatar, styles } from "../ui";
import { Rating } from "./kit";
import { MentionComposer, MentionText, type ComposerHandle } from "./mentions";
import { useStaff, type Comment } from "./work-client";
import { useOrgZone } from "../org-code";
import css from "./threads.module.css";

const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
const first = (name: string | null | undefined) => String(name ?? "Someone").replace(/^(mr|mrs|ms|dr|miss)\.?\s+/i, "").split(" ")[0];
function relative(iso: string, now: number, zone: string) {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return "just now"; if (s < 3600) return `${Math.round(s / 60)} min ago`; if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: zone });
}
type Node = Comment & { children: Node[] };
const HELP_RATING = [{ value: "helpful", label: "Helpful" }, { value: "somewhat", label: "Somewhat" }, { value: "not", label: "Not helpful" }];
const RATED: Record<number, string> = { 2: "helpful", 1: "somewhat", 0: "not" };

/** One composer: a comment, a reply or a request for help. */
function Composer({ taskId, projectId, parentId, help, label, placeholder, onDone, onCancel, autoFocus }: { taskId?: string; projectId?: string; parentId?: string; help?: boolean; label: string; placeholder: string;
  onDone?: () => void; onCancel?: () => void; autoFocus?: boolean }) {
  const router = useRouter();
  const [text, setText] = useState(""), [busy, setBusy] = useState(false), [want, setWant] = useState(!!autoFocus);
  const box = useRef<ComposerHandle>(null); const o = useStaff(want);
  useEffect(() => { if (autoFocus) box.current?.focus(); }, [autoFocus]);
  async function send(e?: FormEvent) {
    e?.preventDefault(); const body = box.current?.text() ?? ""; if (!body.trim() || busy) return;
    const ids = box.current?.mentions() ?? [];
    setBusy(true);
    try {
      await post("work/comments", { taskId, projectId, parentId, kind: help ? "help" : undefined, body, mentions: ids });
      box.current?.clear(); setText(""); onDone?.(); router.refresh();
      if (help) notify({ id: "comment", tone: "success", title: "Asked for help", message: "They can see the task now and answer in this thread.", timeout: 3000 });
      else if (ids.length) notify({ id: "comment", tone: "success", title: `Told ${ids.length === 1 ? first(o?.people.find((p) => p.id === ids[0])?.name) : `${ids.length} people`}`, message: "Mentioned people can now see and follow this.", timeout: 3000 });
    } catch (err) { notify({ id: "comment", tone: "error", title: "Not posted", message: msg(err) }); } finally { setBusy(false); }
  }
  return <form className={css.composer} data-help={help ? "" : undefined} onSubmit={send}>
    <div className={css.composerBox}><MentionComposer ref={box} people={o?.people ?? null} me={o?.me ?? null} label={label} placeholder={placeholder} onWant={() => setWant(true)} onChange={setText} onSubmit={() => void send()} /></div>
    <div className={css.composerFoot}><span className={styles.muted}><AtSign size={12} aria-hidden="true" /> mention · <kbd>Ctrl</kbd>+<kbd>Enter</kbd> send</span>
      <span className={css.footButtons}>{onCancel ? <button type="button" className={styles.btn} onClick={onCancel}>Cancel</button> : null}
        <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !text.trim()}>{help ? <><LifeBuoy size={13} aria-hidden="true" />Ask for help</> : parentId ? <><CornerDownRight size={13} aria-hidden="true" />Reply</> : <><Send size={13} aria-hidden="true" />Comment</>}</button></span></div>
  </form>;
}

/** "Ask for help": who will be told, then the request. */
function AskForHelp({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const [people, setPeople] = useState<{ id: string; name: string; photoAt: string | null; why: string }[] | null>(null);
  useEffect(() => { let live = true; void fetch(`/api/v0/work/tasks/${taskId}/help-people`).then((r) => r.ok ? r.json() : { rows: [] }).then((r) => { if (live) setPeople(r.rows ?? []); }).catch(() => { if (live) setPeople([]); }); return () => { live = false; }; }, [taskId]);
  return <div className={css.askHelp} role="group" aria-label="Ask for help">
    <p className={css.askWho}><LifeBuoy size={15} aria-hidden="true" />
      {people === null ? "Finding who can help…" : people.length ? <>Pulse tells {people.map((p, i) => <span key={p.id} className={css.helper}><Avatar name={p.name} id={p.id} photoAt={p.photoAt} size={20} />{first(p.name)}<small>{p.why}</small>{i < people.length - 1 ? "," : ""}</span>)} and anyone you @mention. They can see this task once asked.</>
        : <>Nobody is on this task yet besides you: @mention who could help.</>}</p>
    <Composer taskId={taskId} help label="What are you stuck on?" placeholder="What are you stuck on? Say what you tried. @ to ask someone by name" onDone={onClose} onCancel={onClose} autoFocus />
  </div>;
}

/** Whoever asked rates each helper once the thread is resolved. */
function RateHelpers({ root }: { root: Node }) {
  const router = useRouter(); const [saved, setSaved] = useState<Record<string, string>>({});
  async function rate(helperId: string, rating: string) {
    setSaved((s) => ({ ...s, [helperId]: rating }));
    try { const r = await post<{ points: number }>(`work/comments/${root.id}/rate`, { helperId, rating }); notify({ id: "rate", tone: "success", title: "Thanks", message: r.points ? `They get ${r.points} point${r.points === 1 ? "" : "s"} for helping.` : "Kept private.", timeout: 2200 }); router.refresh(); }
    catch (e) { notify({ id: "rate", tone: "error", title: "Not saved", message: msg(e) }); }
  }
  if (!root.helpers?.length) return null;
  return <div className={css.rate} role="group" aria-label="How helpful was each person?">
    <p><b>How helpful was each person?</b> <small>Only you see your ratings; each helper sees only their own totals.</small></p>
    <ul>{root.helpers.map((h) => <li key={h.id}><span className={css.helper}><Avatar name={h.name} id={h.id} photoAt={h.photoAt} size={24} />{h.name}</span>
      <Rating label={`How helpful was ${first(h.name)}?`} options={HELP_RATING} value={saved[h.id] ?? (h.rating === null ? null : RATED[h.rating])} onChange={(v) => void rate(h.id, v)} size="sm" hideLabel /></li>)}</ul>
  </div>;
}

export function Threads({ taskId, projectId, comments, canComment, canRemoveAll, canResolve }: { taskId?: string; projectId?: string; comments: Comment[]; canComment: boolean; canRemoveAll?: boolean;
  /** People on the work may resolve any thread; everyone resolves their own. */ canResolve?: boolean }) {
  const zone = useOrgZone();
  const router = useRouter(); const params = useSearchParams(); const focus = params.get("thread");
  const [now] = useState(() => Date.now());
  const [replying, setReplying] = useState<string | null>(null), [helping, setHelping] = useState(false), [open, setOpen] = useState<Set<string>>(() => new Set(focus ? [focus] : []));
  const roots = useMemo(() => {
    const by = new Map<string, Node>(comments.map((c) => [c.id, { ...c, children: [] }]));
    const top: Node[] = [];
    for (const c of by.values()) { const p = c.parentId ? by.get(c.parentId) : undefined; if (p) p.children.push(c); else top.push(c); }
    // Open requests for help first, then threads as they were started.
    return top.sort((a, b) => Number(b.kind === "help" && !b.resolvedAt) - Number(a.kind === "help" && !a.resolvedAt) || a.at.localeCompare(b.at));
  }, [comments]);
  const count = (n: Node): number => n.children.reduce((s, c) => s + 1 + count(c), 0);
  // Opened from a notification (?thread=…): bring that thread into view.
  useEffect(() => { if (focus) document.getElementById(`c-${focus}`)?.scrollIntoView({ block: "center" }); }, [focus]);
  async function remove(id: string) { try { await post(`work/comments/${id}/remove`, {}); router.refresh(); } catch (e) { notify({ id: "comment", tone: "error", title: "Kept", message: msg(e) }); } }
  async function resolve(root: Node, on: boolean) {
    try {
      const r = await post<{ helpers: { id: string; name: string }[] }>(`work/comments/${root.id}/resolve`, { on });
      notify({ id: "thread", tone: "success", title: on ? "Resolved" : "Reopened", message: on && r.helpers?.length && root.mine ? "Say how helpful each person was." : undefined, timeout: 2500 });
      if (on && root.kind === "help" && root.mine) setOpen((s) => new Set(s).add(root.id)); router.refresh();
    } catch (e) { notify({ id: "thread", tone: "error", title: "Not changed", message: msg(e) }); }
  }
  const one = (c: Node, depth: number, root: Node): ReactNode => <li key={c.id} className={css.comment} data-depth={Math.min(depth, 4)} data-help={c.kind === "help" ? "" : undefined} id={`c-${c.id}`}>
    <Avatar name={c.authorName} id={c.authorId} photoAt={c.authorPhotoAt} size={depth ? 24 : 28} />
    <div className={css.commentMain}>
      <p className={css.head}><b>{c.mine ? "You" : c.authorName}</b>{c.kind === "help" ? <span className={css.helpTag}><LifeBuoy size={11} aria-hidden="true" />asks for help</span> : null}
        <time dateTime={c.at}>{relative(c.at, now, zone)}</time></p>
      <p className={css.body}><MentionText body={c.body} people={c.people} /></p>
      <p className={css.actions}>
        {canComment && !root.resolvedAt ? <button type="button" className={css.act} onClick={() => setReplying(replying === c.id ? null : c.id)}><MessageSquareReply size={13} aria-hidden="true" />Reply</button> : null}
        {depth === 0 && (canResolve || c.mine) ? c.resolvedAt ? <button type="button" className={css.act} onClick={() => void resolve(c, false)}><RotateCcw size={13} aria-hidden="true" />Reopen</button>
          : <button type="button" className={css.act} onClick={() => void resolve(c, true)}><Check size={13} aria-hidden="true" />Resolve</button> : null}
        {c.mine || canRemoveAll ? <Tooltip content="Remove this comment"><button type="button" className={css.act} aria-label="Remove this comment" onClick={() => void remove(c.id)}><Trash2 size={12} aria-hidden="true" /></button></Tooltip> : null}
      </p>
      {replying === c.id ? <Composer taskId={taskId} projectId={projectId} parentId={c.id} label={`Reply to ${first(c.authorName)}`} placeholder={`Reply to ${first(c.authorName)}…`} onDone={() => setReplying(null)} onCancel={() => setReplying(null)} autoFocus /> : null}
      {c.children.length ? <ol className={css.replies}>{c.children.map((r) => one(r, depth + 1, root))}</ol> : null}
    </div>
  </li>;
  return <div className={css.threads}>
    {roots.length ? <ol className={css.list}>{roots.map((r) => r.resolvedAt && !open.has(r.id)
      ? <li key={r.id} className={css.folded} data-help={r.kind === "help" ? "" : undefined}>
        <Check size={14} aria-hidden="true" /><span><b>{r.kind === "help" ? `${r.mine ? "Your" : `${first(r.authorName)}’s`} request for help` : `${first(r.authorName)}: “${r.body.slice(0, 60)}${r.body.length > 60 ? "…" : ""}”`}</b> · resolved{r.resolvedBy ? ` by ${first(r.resolvedBy)}` : ""}{count(r) ? ` · ${count(r)} repl${count(r) === 1 ? "y" : "ies"}` : ""}</span>
        <button type="button" className={css.act} onClick={() => setOpen((s) => new Set(s).add(r.id))}>Show</button>
        {r.kind === "help" && r.mine && r.helpers?.some((h) => h.rating === null) ? <RateHelpers root={r} /> : null}
      </li>
      : <li key={r.id} className={css.thread} data-help={r.kind === "help" ? "" : undefined} data-focus={focus === r.id ? "" : undefined}>
        <ol className={css.list}>{one(r, 0, r)}</ol>
        {r.resolvedAt ? <p className={css.resolvedLine}><Check size={13} aria-hidden="true" />Resolved{r.resolvedBy ? ` by ${first(r.resolvedBy)}` : ""}</p> : null}
        {r.kind === "help" && r.resolvedAt && r.mine ? <RateHelpers root={r} /> : null}
      </li>)}</ol>
      : <p className={css.empty}>No comments yet. Type <kbd>@</kbd> to bring someone in: they can see this and get a note.</p>}
    {canComment ? helping && taskId ? <AskForHelp taskId={taskId} onClose={() => setHelping(false)} />
      : <>
        <Composer taskId={taskId} projectId={projectId} label="Write a comment" placeholder="Write a comment. @ to mention someone" />
        {taskId ? <button type="button" className={css.helpBtn} onClick={() => setHelping(true)}><HelpCircle size={14} aria-hidden="true" />Stuck? Ask for help</button> : null}
      </> : <p className={css.empty}>Join to take part in the discussion.</p>}
  </div>;
}
