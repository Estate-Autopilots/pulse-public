"use client";
// "+ Create", everywhere: the + New button in the top bar, the C key (choose), the N key (a task at once), and
// `pulse:create` events from pages ("Add task" on a project opens it with the project chosen). TASKS-4A: it is the one
// way to create work. The task's title understands what the old quick-add line did: @someone becomes a chip and sets
// Who, #project and !priority and a day at the end fill their fields as you type (each shows "from the title" until
// you change it by hand). The rules (who you may assign, who may create projects) come from the database; when you may
// not assign someone, the same button asks them instead. One position (centred, a little above the middle; a sheet on
// a phone) and one motion for the chooser and both forms.
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, Check, CircleCheck, FolderKanban, Inbox, LayoutTemplate, Link2, Paperclip, Plus, Sparkles, UserPlus, X } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { post } from "./records";
import { Avatar } from "./ui";
import { Combobox, DatePicker, HelpHint, KeyHint, Keycap, MentionInput, PeopleInput, PersonSelect, Segmented, Select, Tooltip, addDays, dayLabel, nextWeekday, timeLabel,
  type DateTime, type MentionHandle, type Option, type Segment } from "./kit";
import { KindChip, kindOf, type WorkKind } from "./work-kind";
import { NameHints } from "./tasks/categories";
import { PriorityPicker, urgencyFrom } from "./tasks/priority";
import { CategoryIcon } from "./tasks/kinds";
import { parseLine } from "./lib/quick-parse.mjs";
import { zoneTime } from "./lib/zone.mjs";
import { useOrgZone } from "./org-code";
import css from "./create.module.css";

/** `org`/`connectionId`: a connected organisation's contact (CONNECT 2): given tasks like anyone, never a project's owner or member. */
export type Person = { id: string; name: string; pod?: string | null; role?: string | null; photoAt?: string | null; canAssign?: boolean; username?: string | null; hasDomains?: boolean; org?: string | null; connectionId?: string | null };
export type Project = { id: string; name: string; kind: string; clientName: string | null; recent?: boolean; mine?: boolean };
type ClientProject = { id: string; name: string; clientName: string | null; setUp: boolean; registryNo: number | null };
type Template = { key: string; name: string; for: "fulfilment" | "internal"; steps: string[] };
export type Labels = { model: "agency" | "product" | "internal"; section: string | null; clients: string | null; client: string; clientProjects: string | null; clientProject: string;
  packageChip: string; fulfilmentChip: string; fulfilmentHint: string };
export type Options = { me: string; today: string; people: Person[]; projects: Project[]; clientProjects: ClientProject[]; templates: Template[]; role: string; roleLabel: string;
  scopes: Record<string, string>; canCreateProject: boolean; pods: string[]; myPods: string[]; headPods: string[];
  /** UX-TASKS-2: kinds of work, where the viewer may pool, the business model's words. */
  categories?: { key: string; label: string }[]; pools?: { scope: "company" | "department" | "pod"; ref: string | null }[]; labels?: Labels; aiAutoAcceptMax?: number | null;
  /** TASKS-4A: recent task titles the viewer can see (nothing private), for the title's rotating examples. */ examples?: string[] };
export type Suggestion = { importance: "low" | "normal" | "high" | "urgent"; valuePoints: number; effortMinutes: number; reason: string; confidence: "low" | "medium" | "high"; basis: string[] };
type Mode = { mode: "self" | "direct" | "request" | "none" | null; why?: string; domainTitle?: string; basis?: string };
type Fit = { id: string; name: string; why: string; photoAt: string | null };
type Preview = { key: string; category: string | null; categoryLabel: string | null; mode: Mode | null; suggestion: Suggestion | null; fit?: Fit[] };
export type CreateRequest = { kind?: "task" | "project"; projectId?: string; title?: string; assigneeId?: string; parentId?: string; clientProjectId?: string;
  /** CHATS-2: made from a chat message or an e-mail. The task links back; from a chat, its card goes into the conversation. */
  notes?: string; source?: { label: string; quote?: string }; chat?: { channelId: string; messageId?: string } };

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
const first = (name: string) => name.replace(/^(mr|mrs|ms|dr|miss)\.?\s+/i, "").split(" ")[0];
const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
/** READY (Datup, 21 Oct): what comes with a new task (the brief, a reference, a screenshot). Never proof. */
type Attachment = { key: string; file?: File; url?: string; name: string };
const MAX_FILE = 5 * 1024 * 1024;
const readBase64 = (f: File) => new Promise<string>((done, fail) => { const r = new FileReader(); r.onload = () => done(String(r.result).split(",")[1] ?? ""); r.onerror = () => fail(new Error("Could not read the file")); r.readAsDataURL(f); });
/** Files and links go onto the task once it exists; what fails is named, the task stays. */
export async function attachAll(taskId: string, items: Attachment[]) {
  const failed: string[] = [];
  for (const a of items) {
    try { await post(`tasks/${taskId}/attachments`, a.file ? { name: a.name, mime: a.file.type || "application/octet-stream", bytes: await readBase64(a.file), label: a.name } : { url: a.url, label: "" }); }
    catch { failed.push(a.name); }
  }
  return failed;
}
function AttachRow({ items, onChange }: { items: Attachment[]; onChange: (next: Attachment[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [linking, setLinking] = useState(false), [url, setUrl] = useState(""), [problem, setProblem] = useState("");
  const addFiles = (files: File[]) => {
    const big = files.filter((f) => f.size > MAX_FILE), ok = files.filter((f) => f.size <= MAX_FILE);
    setProblem(big.length ? `${big.map((f) => f.name).join(", ")}: over 5 MB. Link a Drive file instead.` : "");
    if (ok.length) onChange([...items, ...ok.map((f, i) => ({ key: `${Date.now()}-${i}-${f.name}`, file: f, name: f.name || "Pasted image" }))].slice(0, 10));
  };
  const addLink = () => { const u = url.trim(); if (!/^https?:\/\/\S+$/.test(u)) { setProblem("Paste a full link starting with https://"); return; } onChange([...items, { key: `${Date.now()}-link`, url: u, name: u.replace(/^https?:\/\/(www\.)?/, "").slice(0, 60) }].slice(0, 10)); setUrl(""); setLinking(false); setProblem(""); };
  return <div className={css.row}>
    <span className={css.rowLabel}>Attach</span>
    <div className={css.attach} onPaste={(e) => { const files = Array.from(e.clipboardData.files ?? []); if (files.length) { e.preventDefault(); addFiles(files); } }}>
      <div className={css.chips}>
        {items.map((a) => <span key={a.key} className={css.attachChip}>{a.file ? <Paperclip size={13} aria-hidden="true" /> : <Link2 size={13} aria-hidden="true" />}<span>{a.name}</span>
          <button type="button" aria-label={`Remove ${a.name}`} onClick={() => onChange(items.filter((x) => x.key !== a.key))}><X size={12} aria-hidden="true" /></button></span>)}
        <input ref={input} type="file" multiple hidden accept="application/pdf,image/*,.csv,.txt,.zip,.docx,.xlsx,.pptx" onChange={(e) => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
        <button type="button" className={css.chip} onClick={() => input.current?.click()}><Paperclip size={13} aria-hidden="true" />File</button>
        {linking ? <span className={css.attachLink}><input type="url" value={url} autoFocus placeholder="https://drive.google.com/…" aria-label="Link to attach" onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); addLink(); } if (e.key === "Escape") { e.stopPropagation(); setLinking(false); } }} />
          <button type="button" className={css.chip} onClick={addLink}>Add</button></span>
          : <button type="button" className={css.chip} onClick={() => setLinking(true)}><Link2 size={13} aria-hidden="true" />Link</button>}
      </div>
      {problem ? <p className={css.attachProblem} role="alert">{problem}</p> : !items.length ? <p className={css.attachNote}>The brief or a reference, up to 5 MB each; paste a screenshot here. Not proof of the work.</p> : null}
    </div>
  </div>;
}

/** Open the Create dialog from anywhere: `openCreate({ kind: "task", projectId })`. */
export function openCreate(request: CreateRequest = {}) { window.dispatchEvent(new CustomEvent<CreateRequest>("pulse:create", { detail: request })); }

/** "+ New": the small control at the start of the top bar's right-hand group (LAYOUT-SWEEP: no big rail button). */
export function CreateButton() {
  return <Tooltip content="Create a task or a project · N for a task" shortcut="C" side="bottom">
    <button type="button" className={css.createBtn} onClick={() => openCreate()} aria-keyshortcuts="c n" aria-haspopup="dialog" aria-label="Create a task or a project">
      <Plus size={16} strokeWidth={2.4} aria-hidden="true" /><span>New</span><kbd aria-hidden="true">C</kbd>
    </button>
  </Tooltip>;
}

/** Mounted once: owns the dialog, the C and N shortcuts and the `pulse:create` event. */
export function CreateHost() {
  // Each opening has its own number, so a dialog still sinking away never closes the next one.
  const [open, setOpen] = useState<{ n: number; request: CreateRequest } | null>(null);
  useEffect(() => {
    let n = 0;
    const show = (request: CreateRequest) => setOpen({ n: ++n, request });
    const onKey = (e: globalThis.KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if ((k !== "c" && k !== "n") || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || typing(e.target) || document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault(); show(k === "n" ? { kind: "task" } : {});
    };
    const onCreate = (e: Event) => show((e as CustomEvent<CreateRequest>).detail ?? {});
    document.addEventListener("keydown", onKey); window.addEventListener("pulse:create", onCreate);
    return () => { document.removeEventListener("keydown", onKey); window.removeEventListener("pulse:create", onCreate); };
  }, []);
  return open ? <CreateDialog key={open.n} request={open.request} onClose={() => setOpen((o) => o?.n === open.n ? null : o)} /> : null;
}

let cached: { at: number; data: Options } | null = null;
/** Forget the cached choices (after a project or person changed). */
export function forgetWorkOptions() { cached = null; }
function useOptions(enabled = true) {
  const [data, setData] = useState<Options | null>(() => cached && Date.now() - cached.at < 60000 ? cached.data : null), [error, setError] = useState("");
  useEffect(() => {
    if (data || !enabled) return;
    fetch("/api/v0/work/options").then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error ?? "Could not load"); cached = { at: Date.now(), data: d }; setData(d); }).catch((e) => setError(msg(e)));
  }, [data, enabled]);
  return { data, error };
}
/** Everyone (with who the viewer assigns directly), projects, kinds of work and pools: read once a minute. */
export const useWorkOptions = useOptions;

function CreateDialog({ request, onClose }: { request: CreateRequest; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  // Owner workbench (21 Oct 2026): C opens the task form at once (a task is what people create most); the Task / Project
  // switch at its top makes a project instead. The chooser step is gone.
  const [kind, setKind] = useState<"task" | "project" | null>(request.kind ?? "task");
  const [leaving, setLeaving] = useState(false);
  const { data, error } = useOptions();
  const router = useRouter();
  // READY (Datup: "How to add new team member?"): HR and leadership add a team member from the same New button.
  const canAddMember = !!data && (data.role === "leadership" || data.role === "hr");
  const close = useCallback(() => { setLeaving(true); setTimeout(onClose, reduced() ? 0 : 150); }, [onClose]);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); close(); return; }
      if (e.key === "Tab") {
        const all = Array.from(box.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [contenteditable="true"], [tabindex="0"]') ?? []).filter((el) => el.getClientRects().length);
        const a = all[0], z = all.at(-1);
        if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z?.focus(); } else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a?.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); before?.focus?.(); };
  }, [close]);
  // T and P pick from the two choices.
  const onChoiceKey = (e: KeyboardEvent) => { const k = e.key.toLowerCase(); if (k === "t") { e.preventDefault(); setKind("task"); } if (k === "p" && data?.canCreateProject !== false) { e.preventDefault(); setKind("project"); } };
  const title = kind === "task" ? "New task" : kind === "project" ? "New project" : "Create";
  // Switching between a task and a project keeps the dialog: no step back to the chooser (the owner lost a task that way).
  const switcher = kind && !request.kind && !request.projectId && !request.parentId && !request.clientProjectId;
  if (typeof document === "undefined") return null;
  return createPortal(<div className={css.backdrop} data-leaving={leaving ? "" : undefined} onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
    <div ref={box} className={css.dialog} role="dialog" aria-modal={leaving ? undefined : "true"} aria-label={title} data-kind={kind ?? "choose"} onKeyDown={kind ? undefined : onChoiceKey}>
      <header className={css.head}>
        {switcher ? <><h2 className={css.srOnly}>{title}</h2><Segmented label="What to create" size="sm" value={kind as "task" | "project" | "member"} onChange={(k) => { if (k === "member") { close(); router.push("/people?add=member"); } else setKind(k); }}
          options={[{ value: "task", label: "Task", icon: CircleCheck }, { value: "project", label: "Project", icon: FolderKanban, disabled: !!data && !data.canCreateProject },
            ...(canAddMember ? [{ value: "member" as const, label: "Team member", icon: UserPlus }] : [])]} /></>
          : <h2>{title}</h2>}
        <Tooltip content="Close" shortcut="Escape" side="bottom"><button type="button" className={css.iconBtn} onClick={close} aria-label="Close"><X size={16} aria-hidden="true" /></button></Tooltip>
      </header>
      {error ? <p className={css.error} role="alert">{error}</p> : null}
      <div className={css.body} key={kind ?? "choose"}>
        {!kind ? <div className={css.choices}>
          <Tooltip content="Give someone something to do, or note one for yourself. They are told at once." side="bottom">
            <button type="button" className={css.choice} onClick={() => setKind("task")} autoFocus>
              <span className={css.choiceIcon} data-kind="task"><CircleCheck size={22} aria-hidden="true" /></span><b>Task</b><Keycap keys="T" hideOnTouch className={css.choiceKey} />
            </button>
          </Tooltip>
          <Tooltip content={data && !data.canCreateProject ? "Your role does not create projects. Ask your pod head or leadership." : "Internal work, or the fulfilment of a client package, with an owner, people and dates."} side="bottom">
            <button type="button" className={css.choice} onClick={() => setKind("project")} aria-disabled={!!data && !data.canCreateProject} disabled={!!data && !data.canCreateProject}>
              <span className={css.choiceIcon} data-kind="project"><FolderKanban size={22} aria-hidden="true" /></span><b>Project</b><Keycap keys="P" hideOnTouch className={css.choiceKey} />
            </button>
          </Tooltip>
          <p className={css.foot}><a href="/settings?tab=work-rules">Who can do what</a>{data ? <> · You are in <b>{data.roleLabel}</b></> : null}</p>
        </div> : !data ? <div className={css.loading} aria-busy="true"><span /><span /><span /></div>
          : kind === "task" ? <TaskForm options={data} request={request} onDone={close} />
          : data.canCreateProject ? <ProjectForm options={data} request={request} onDone={close} />
          : <p className={css.note}>Your role ({data.roleLabel.toLowerCase()}) does not create projects. Ask your pod head or leadership, or see <a href="/settings?tab=work-rules">who can do what</a>.</p>}
      </div>
    </div>
  </div>, document.body);
}

// ------------------------------------------------------------------------------------------------ the task form
export const hours = (m: number) => m < 60 ? `${m} min` : `${Math.round(m / 6) / 10} h`.replace(".0 h", " h");
/** "Company", "Creative department", "Pod 1" (a pod; other pod names get the word "pod"). Departments are not teams:
 *  pods are (TASKS-4A). */
const poolName = (p: { scope: string; ref: string | null }) => p.scope === "company" ? "Company" : p.scope === "department" ? `${p.ref} department` : /^pod\b/i.test(p.ref ?? "") ? p.ref ?? "Pod" : `${p.ref} pod`;
const poolKey = (p: { scope: string; ref: string | null }) => `${p.scope}:${p.ref ?? ""}`;
/** A few short examples for the title: the company's recent work and some fun ones, never the same order twice in a row. */
const FUN = ["Book the drone for Saturday…", "Find a sunset spot for the shoot…", "Draft three hooks for the reel…", "Send the client the first cut…", "Write the caption for Friday’s post…"];
function examplesFrom(titles: string[] | undefined) {
  const real = [...new Set((titles ?? []).map((t) => t.replace(/\s+[(–—].*$|:\s.*$/, "").trim()).filter((t) => t.length >= 12))].map((t) => { const w = t.split(/\s+/); return `${w.slice(0, 6).join(" ")}…`; });
  const out: string[] = []; const a = real.slice(0, 12), b = [...FUN];
  while (a.length || b.length) { if (a.length) out.push(a.shift()!); if (a.length) out.push(a.shift()!); if (b.length) out.push(b.shift()!); }
  return out.length ? out : ["What needs doing?"];
}
/** The title as words: a person chip at either end (before only #project, !priority or a day) is who does it and is
 *  left out; one in the middle stays as their first name ("Ask Rifob for the files"). */
function titleText(segs: Segment[], today: string) {
  const blank = (s?: Segment) => !s || (s.kind === "text" && !s.text.trim());
  const tail = (rest: Segment[]) => {
    const words = rest.map((x) => x.kind === "text" ? x.text : "").join(" ").replace(/[#!]\S+/g, " ").replace(/\u00a0/g, " ").trim();
    if (!words) return true;
    const p = parseLine(`x ${words}`, { today }); return !!p.dueOn && p.title === "x";
  };
  return segs.map((s, i) => s.kind === "text" ? s.text : segs.slice(0, i).every(blank) || (segs.slice(i + 1).every((x) => x.kind === "text") && tail(segs.slice(i + 1))) ? " " : first(s.name))
    .join("").replace(/\u00a0/g, " ").replace(/\s{2,}/g, " ");
}
type Touched = { who?: boolean; project?: boolean; priority?: boolean; due?: boolean };

function TaskForm({ options, request, onDone }: { options: Options; request: CreateRequest; onDone: () => void }) {
  const router = useRouter();
  const me = options.people.find((p) => p.id === options.me) ?? null;
  const box = useRef<MentionHandle>(null);
  const [segs, setSegs] = useState<Segment[]>(() => request.title ? [{ kind: "text", text: request.title }] : []);
  const [who, setWho] = useState<Person | null>(options.people.find((p) => p.id === request.assigneeId) ?? me);
  const [pool, setPool] = useState<{ scope: "company" | "department" | "pod"; ref: string | null } | null>(null);
  const [due, setDue] = useState<DateTime>({ date: null, time: null });
  const [project, setProject] = useState<string | null>(request.projectId ?? null);
  const [priority, setPriority] = useState("normal"), [busy, setBusy] = useState(false), [error, setError] = useState(""), [nudge, setNudge] = useState(false);
  const [category, setCategory] = useState<string | null>(null);
  // CHAT-WORK: a task made in a chat posts its updates there unless its maker turns that off.
  const [follow, setFollow] = useState(true);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [touched, setTouched] = useState<Touched>({});
  const touch = (k: keyof Touched) => setTouched((t) => ({ ...t, [k]: true }));
  const zone = useOrgZone();
  // Pip: what the task looks like while it is typed (kind of work, direct or a request, importance and effort; never a
  // value: INTEGRITY, owner 22 Oct 2026).
  const [preview, setPreview] = useState<Preview | null>(null), [useIt, setUseIt] = useState(false);
  const examples = useMemo(() => examplesFrom(options.examples), [options.examples]);
  const text = useMemo(() => titleText(segs, options.today), [segs, options.today]);
  const parsed = useMemo(() => parseLine(text, { today: options.today, people: options.people, projects: options.projects, me }), [text, options, me]);
  const chips = segs.flatMap((s) => s.kind === "person" ? [s.id] : []);
  // What the title says fills a field until that field is set by hand.
  const fromTitle = { who: !touched.who && !chips.length && !!parsed.assignee, project: !touched.project && !!parsed.project, priority: !touched.priority && parsed.priority !== "normal", due: !touched.due && !!parsed.dueOn };
  const whoNow = fromTitle.who ? options.people.find((p) => p.id === parsed.assignee!.id) ?? who : who;
  const projectNow = fromTitle.project ? parsed.project!.id : project;
  const priorityNow = fromTitle.priority ? parsed.priority : priority;
  const dueNow: DateTime = fromTitle.due ? { date: parsed.dueOn, time: null } : due;
  const title = parsed.title.trim();
  const key = JSON.stringify([title, pool ? null : whoNow?.id, projectNow, dueNow.date, priorityNow, category]);
  useEffect(() => {
    if (title.length < 4) return;
    const h = setTimeout(async () => {
      const r = await fetch("/api/v0/work/tasks/preview", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, assigneeId: pool ? null : whoNow?.id ?? null, projectId: projectNow, dueOn: dueNow.date, priority: priorityNow, category }) }).catch(() => null);
      if (r?.ok) setPreview({ key, ...(await r.json()) });
    }, 320);
    return () => clearTimeout(h);
    // `key` carries every input the preview reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const fresh = preview?.key === key ? preview : null;
  const suggestion = title.length >= 4 ? (fresh ?? preview)?.suggestion ?? null : null;
  // Today, Tomorrow and the coming Friday (on a Thursday that is tomorrow; on a Friday, the next one).
  const days: [string, string][] = [["Today", options.today], ["Tomorrow", addDays(options.today, 1)], ["Friday", nextWeekday(options.today, 5)]];
  const other = !pool && !!whoNow && whoNow.id !== options.me;
  const mode = other && fresh?.mode?.mode ? fresh.mode : null;
  const asking = other && (mode ? mode.mode === "request" || mode.mode === "none" : whoNow!.canAssign === false);
  const label = pool ? "Put in the pool" : !whoNow || whoNow.id === options.me ? "Create task" : asking ? `Ask ${first(whoNow.name)} to take it` : `Assign to ${first(whoNow.name)}`;
  // Whoever creates a task for someone else (or for the pool) may take Pip's importance and estimate.
  const canValue = pool || other;
  const pools = options.pools ?? [];
  const projectOptions = useMemo<Option[]>(() => options.projects.map((p) => ({ value: p.id, label: p.name, detail: p.clientName ?? undefined, keywords: p.clientName ?? "",
    icon: <KindChip kind={kindOf(p.kind)} short />, group: p.recent ? "Recent" : p.mine ? "Yours" : "All projects" })), [options.projects]);
  const kinds = useMemo<Option[]>(() => (options.categories ?? []).map((c) => ({ value: c.key, label: c.label, icon: <span className={css.kindIcon}><CategoryIcon category={c.key} /></span> })), [options.categories]);
  const dueText = dueNow.date && !days.some(([, d]) => d === dueNow.date) ? `${dayLabel(dueNow.date, options.today)}${dueNow.time ? ` · ${timeLabel(dueNow.time)}` : ""}` : dueNow.time ? `at ${timeLabel(dueNow.time)}` : null;
  async function submit(e?: FormEvent) {
    e?.preventDefault(); if (busy) return;
    if (!title) { box.current?.focus(); return; }
    if (parsed.problems.length) { setNudge(true); box.current?.focus(); return; }
    setBusy(true); setError("");
    try {
      const r = await post<{ id: string; assigned: boolean; asked: { id: string; to: string } | null; assigneeName: string | null; pooled: { scope: string; ref: string | null } | null; applied: boolean }>("work/tasks",
        { title, assigneeId: pool ? null : whoNow?.id ?? null, pool, projectId: projectNow, priority: priorityNow, urgency: urgencyFrom(priorityNow, dueNow.date, options.today),
          // R51: a typed due time is that time on the company's clock.
          ...(dueNow.date && dueNow.time ? { dueAt: zoneTime(dueNow.date, zone, dueNow.time).toISOString() } : { dueOn: dueNow.date }),
          ...(category ? { category } : {}), ...(parsed.tags.length ? { tags: parsed.tags } : {}),
          ...(canValue && useIt ? { useSuggestion: true } : {}),
          ...(pool && useIt && suggestion ? { estimateMinutes: suggestion.effortMinutes } : {}),
          ...(request.parentId ? { parentId: request.parentId } : {}), ...(request.notes ? { notes: request.notes } : {}),
          ...(request.chat ? { chatChannelId: request.chat.channelId, chatMessageId: request.chat.messageId ?? null, chatFollow: follow } : {}) });
      const failed = attachments.length ? await attachAll(r.id, attachments) : [];
      if (failed.length) notify({ id: "work-create-files", tone: "error", href: `/tasks/${r.id}`, title: "The task is saved; some attachments are not", message: `Not attached: ${failed.join(", ")}. Open the task to add them again.` });
      notify({ id: "work-create", tone: "success", href: `/tasks/${r.id}`, timeout: 4200,
        title: r.pooled ? (r.pooled.scope === "company" ? "In the Company pool" : `In the pool for ${poolName(r.pooled)}`) : r.asked ? `Asked ${first(r.asked.to)}` : r.assigned ? `Assigned to ${first(r.assigneeName ?? "them")}` : "Added",
        message: r.pooled ? "Anyone there can claim it; the first claim wins." : r.asked ? "It stays yours until they accept. You will hear their answer." : r.assigned ? `${first(r.assigneeName ?? "They")} is told in Pulse, on the phone and on the desktop.` : title });
      cached = null; onDone(); router.refresh();
    } catch (err) { setError(msg(err)); } finally { setBusy(false); }
  }
  const fromTag = <span className={css.fromTitle}><Sparkles size={11} aria-hidden="true" />from the title</span>;
  return <form className={css.form} onSubmit={submit} aria-busy={busy || undefined}>
    {request.source ? <p className={css.source}><span>{request.source.label}</span>{request.source.quote ? <q>{request.source.quote}</q> : null}</p> : null}
    <div className={css.titleField}>
      <MentionInput ref={box} label="What needs doing" people={options.people} me={options.me} placeholder={examples} singleLine wrap autoFocus initial={request.title} maxLength={300} enterKeyHint="send"
        onChange={() => { setSegs(box.current?.segments() ?? []); setNudge(false); }} onSubmit={() => submit()}
        onMention={(p) => { const person = options.people.find((x) => x.id === p.id) ?? null; setWho(person); setPool(null); touch("who"); }}
        onUnmention={(id) => { if (who?.id === id) setWho(me); }} />
      <span className={css.titleHelp}><HelpHint label="What the title understands" title="Type it all in one line">@name gives it to someone · #project · !high or !urgent · a day at the end (fri, tomorrow, 12 oct) sets When.</HelpHint></span>
    </div>
    {parsed.tokens.some((t) => t.kind !== "person") && title ? <p className={css.savesAs}>Saves as “{title}”</p> : null}
    {parsed.problems.length ? <p className={css.soft} data-nudge={nudge ? "" : undefined}><AlertCircle size={14} aria-hidden="true" />{parsed.problems[0].text}</p> : null}
    <div className={css.row}>
      <span className={css.rowLabel}>Who</span>
      <div className={css.whoRow}>
        {pool ? <Select label="Which pool" value={poolKey(pool)} onChange={(v) => { const p = pools.find((x) => poolKey(x) === v); if (p) setPool(p); }}
          options={pools.map((p) => ({ value: poolKey(p), label: p.scope === "company" ? "Company pool" : poolName(p), icon: <Inbox size={15} aria-hidden="true" />, group: p.scope === "company" ? undefined : p.scope === "pod" ? "Pods" : "Departments" }))} />
          : <PersonSelect label="Who does it" people={options.people} value={whoNow?.id ?? null} me={options.me} askTag={<span className={css.askTag}>Ask</span>}
            onChange={(p) => { setWho(p ? options.people.find((x) => x.id === p.id) ?? null : me); touch("who"); }} />}
        {pools.length ? <span className={css.poolWrap}>
          <button type="button" className={css.poolBtn} aria-pressed={!!pool} onClick={() => setPool(pool ? null : pools[0])}><Inbox size={14} aria-hidden="true" />Pool</button>
          <HelpHint label="What is the pool?" title="The pool">Nobody has it yet. Anyone eligible can claim it; the first claim wins.</HelpHint>
        </span> : null}
      </div>
    </div>
    {pool ? <p className={css.hint}><Inbox size={13} aria-hidden="true" />Anyone in {pool.scope === "company" ? "the company" : poolName(pool)} can claim it.</p>
      : mode?.mode === "direct" && (mode.why === "in_domain" || mode.why === "head_domain") ? <p className={css.hint}><span className={css.domainTag}>In {first(whoNow!.name)}’s domain</span>{mode.domainTitle}: assigned at once.</p>
      : asking && mode?.why === "outside_domains" ? <p className={css.hint}>Outside {first(whoNow!.name)}’s domains: {first(whoNow!.name)} accepts or declines.<HelpHint label="Why a request?" title="Domains">{first(whoNow!.name)} has agreed areas of responsibility; work outside them arrives as a request.</HelpHint></p>
      : asking ? <p className={css.hint}>{first(whoNow!.name)} accepts or declines: outside who your role assigns.<HelpHint label="Why a request?" title="Who can do what">{options.roleLabel} assign within the rules in Settings → Who can do what. Anyone else gets a request.</HelpHint></p>
      : fromTitle.who ? <p className={css.hint}>{fromTag}</p> : null}
    {!pool && title.length >= 4 && (fresh ?? preview)?.fit?.length ? <div className={css.fitRow} aria-label="Best fit">
      <span>Best fit</span>{(fresh ?? preview)!.fit!.map((f) => { const p = options.people.find((x) => x.id === f.id); return p ? <Tooltip key={f.id} content={f.why}><button type="button" className={css.fitChip} aria-pressed={whoNow?.id === f.id}
        onClick={() => { setWho(p); touch("who"); }}><Avatar name={f.name} id={f.id} photoAt={f.photoAt} size={20} /><b>{first(f.name)}</b></button></Tooltip> : null; })}</div> : null}
    <div className={css.row}>
      <span className={css.rowLabel}>When</span>
      <div className={css.chips} role="group" aria-label="Due">
        {days.map(([l, d]) => <button key={l} type="button" className={css.chip} aria-pressed={dueNow.date === d} onClick={() => { setDue(dueNow.date === d ? { date: null, time: null } : { date: d, time: dueNow.time }); touch("due"); }}>{l}</button>)}
        <DatePicker label="Due date" value={dueNow} onChange={(v) => { setDue(v); touch("due"); }} today={options.today} min={options.today} withTime variant="chip" placeholder="Pick a date" renderValue={() => dueText ?? "Pick a date"} highlight={!!dueText} />
        {fromTitle.due ? fromTag : null}
      </div>
    </div>
    <div className={css.row}>
      <span className={css.rowLabel}>Project</span>
      <div className={css.fieldWith}>
        <Combobox label="Project" options={projectOptions} value={projectNow} onChange={(v) => { setProject(v); touch("project"); }} noneLabel="No project" placeholder="No project" searchable searchPlaceholder="Search projects"
          renderValue={(o) => <>{o.icon}<span>{o.label}</span></>} />
        {fromTitle.project ? fromTag : null}
      </div>
    </div>
    <div className={css.row}>
      <span className={css.rowLabel}>Priority</span>
      <div className={css.fieldWith}><PriorityPicker value={priorityNow} onChange={(p) => { setPriority(p); touch("priority"); }} suggested={suggestion?.importance} />{fromTitle.priority ? fromTag : null}</div>
    </div>
    {kinds.length ? <div className={css.row}>
      <span className={css.rowLabel}>Kind</span>
      <Combobox label="Kind of work" options={kinds} value={category} onChange={setCategory} noneLabel="Read from the title" searchable searchPlaceholder="Search kinds of work"
        placeholder={fresh?.categoryLabel ? `${fresh.categoryLabel}, read from the title` : "Read from the title"}
        hint={fresh?.category ? <><Sparkles size={14} aria-hidden="true" /><b>{fresh.categoryLabel}</b>read from the title</> : "Read from the title"} />
    </div> : null}
    {suggestion ? <div className={css.pip} data-used={useIt ? "" : undefined} aria-live="polite">
      <Sparkles size={15} aria-hidden="true" />
      <span className={css.pipMain}><b>Pip suggests about {hours(suggestion.effortMinutes)}{suggestion.importance !== "normal" ? ` · ${suggestion.importance} priority` : ""}</b>
        <small>{suggestion.reason}{suggestion.confidence === "low" ? " A rough first guess." : ""}</small></span>
      {canValue ? <span className={css.pipActions}>
        <button type="button" className={css.chip} aria-pressed={useIt} onClick={() => { if (useIt) setUseIt(false); else { setUseIt(true); if (suggestion.importance !== "normal" && priorityNow === "normal") { setPriority(suggestion.importance); touch("priority"); } } }}>{useIt ? <><Check size={13} aria-hidden="true" />Using it</> : "Use"}</button>
      </span> : null}
    </div> : null}
    <AttachRow items={attachments} onChange={setAttachments} />
    {request.chat ? <label className={css.follow}><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /><span>Post this task’s updates in the chat<small>Status, assignee and due date changes appear there as one line each.</small></span></label> : null}
    {error ? <p className={css.error} role="alert">{error}</p> : null}
    <footer className={css.actions}><KeyHint keys="Enter">to {label.charAt(0).toLowerCase()}{label.slice(1)}</KeyHint>
      <button className={css.primary} disabled={busy || !title}>{busy ? "Saving…" : label}</button></footer>
  </form>;
}

// ------------------------------------------------------------------------------------------------ the project form
function ProjectForm({ options, request, onDone }: { options: Options; request: CreateRequest; onDone: () => void }) {
  const router = useRouter();
  const [type, setType] = useState<"internal" | "fulfilment">(request.clientProjectId ? "fulfilment" : "internal");
  const [name, setName] = useState(""), [client, setClient] = useState<string | null>(request.clientProjectId ?? null);
  const [owner, setOwner] = useState<string | null>(options.me), [members, setMembers] = useState<string[]>([]);
  const [starts, setStarts] = useState<DateTime>({ date: options.today, time: null }), [dueOn, setDueOn] = useState<DateTime>({ date: null, time: null });
  const [template, setTemplate] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [under, setUnder] = useState<string | null>(null);
  const L = options.labels;
  const types = (["internal", "fulfilment"] as const).filter((t) => t === "internal" || L?.model !== "internal");
  const chosen = options.clientProjects.find((p) => p.id === client) ?? null;
  const templates = options.templates.filter((t) => t.for === type);
  const ok = type === "internal" ? name.trim().length >= 2 : !!chosen && !chosen.setUp;
  const clientOptions = useMemo<Option[]>(() => options.clientProjects.map((p) => ({ value: p.id, label: p.name, icon: <KindChip kind="client" short />, keywords: `${p.clientName ?? ""} ${p.registryNo ?? ""}`,
    detail: [p.clientName, p.setUp ? "already set up" : null].filter(Boolean).join(" · ") || undefined })), [options.clientProjects]);
  const staffOnly = useMemo(() => options.people.filter((p) => !p.connectionId), [options.people]);
  const outside = members.filter((id) => options.people.find((p) => p.id === id)?.canAssign === false).length;
  async function submit(e: FormEvent) {
    e.preventDefault(); if (!ok || busy) return;
    setBusy(true); setError("");
    try {
      const r = await post<{ id: string; added: number; invited: number; steps: number }>("work/projects", { type, name: type === "internal" ? name : undefined, clientProjectId: type === "fulfilment" ? client : undefined,
        ownerId: owner, memberIds: members, startsOn: starts.date, dueOn: dueOn.date, templateKey: template || null });
      // UX-TASKS-2: an internal project can be placed under the client project it helps deliver.
      if (type === "internal" && under) await post("work/links", { clientProjectId: under, projectId: r.id, on: true }).catch(() => null);
      const placed = type === "internal" && under ? `under ${options.clientProjects.find((p) => p.id === under)?.name ?? "its client project"}` : null;
      const bits = [r.steps ? `${r.steps} steps from the template` : null, r.added ? `${r.added} ${r.added === 1 ? "person" : "people"} added` : null, r.invited ? `${r.invited} invited to join` : null, placed].filter(Boolean);
      notify({ id: "work-create", tone: "success", title: type === "internal" ? "Project created" : "Fulfilment set up", message: bits.join(" · ") || undefined, timeout: 4200 });
      cached = null; onDone(); router.push(`/tasks/projects/${r.id}`);
    } catch (err) { setError(msg(err)); } finally { setBusy(false); }
  }
  return <form className={css.form} onSubmit={submit}>
    {types.length > 1 ? <div className={css.types} role="radiogroup" aria-label="Type">
      {types.map((t) => <Tooltip key={t} content={t === "internal" ? "The company's own work" : L?.fulfilmentHint ?? "Delivers a client package"}>
        <button type="button" role="radio" aria-checked={type === t} className={css.type} onClick={() => { setType(t); setTemplate(""); }}>
          <KindChip kind={t} label={t === "fulfilment" ? L?.fulfilmentChip : undefined} /><small>{t === "internal" ? "The company's own work" : L?.fulfilmentHint ?? "Delivers a client package"}</small></button>
      </Tooltip>)}
    </div> : null}
    {type === "internal" ? <><label className={css.titleField}><span className={css.srOnly}>Project name</span>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Project name" maxLength={200} autoFocus required aria-label="Project name" /></label>
      <NameHints name={name} onUse={setName} /></>
      : <div className={css.row}><span className={css.rowLabel}>For</span><Combobox label="Client project" options={clientOptions} value={client} onChange={setClient} searchable placeholder="Choose the client project" searchPlaceholder="Search client projects" autoOpen={!client} /></div>}
    {chosen?.setUp ? <p className={css.hint}>{chosen.name} already has its fulfilment project. <a href={`/tasks/projects/${chosen.id}`}>Open it</a></p> : null}
    {type === "internal" && options.clientProjects.length && L?.clientProjects ? <div className={css.row}><span className={css.rowLabel}>Part of</span>
      <Combobox label={`Part of a ${L.clientProject}`} options={clientOptions} value={under} onChange={setUnder} searchable noneLabel={`Not part of a ${L.clientProject}`} placeholder={`Part of a ${L.clientProject}? (optional)`} searchPlaceholder={`Search ${L.clientProjects.toLowerCase()}`} /></div> : null}
    <div className={css.row}><span className={css.rowLabel}>Owner</span><PersonSelect label="Owner" people={staffOnly} value={owner} me={options.me} onChange={(p) => setOwner(p?.id ?? null)} /></div>
    <div className={css.row}><span className={css.rowLabel}>People</span><PeopleInput label="People" people={staffOnly} value={members} onChange={setMembers} exclude={owner ? [owner] : []} me={options.me}
      tagFor={(p) => p.canAssign === false ? <span className={css.askTag}>Invite</span> : null} /></div>
    {outside ? <p className={css.hint}>{outside === 1 ? "One person is" : `${outside} people are`} outside your reach: they get an invitation to accept.</p> : null}
    <div className={css.row}><span className={css.rowLabel}>Dates</span>
      <div className={css.chips}><DatePicker label="Starts" value={starts} onChange={setStarts} today={options.today} variant="chip" placeholder="Start" renderValue={(v) => `Starts ${dayLabel(v.date!, options.today)}`} />
        <DatePicker label="Due" value={dueOn} onChange={setDueOn} today={options.today} min={starts.date ?? undefined} variant="chip" placeholder="Due (optional)" renderValue={(v) => `Due ${dayLabel(v.date!, options.today)}`} /></div></div>
    <div className={css.row}><span className={css.rowLabel}>Template</span>
      <div className={css.chips} role="radiogroup" aria-label="Template">
        <button type="button" role="radio" className={css.chip} aria-checked={!template} onClick={() => setTemplate("")}>None</button>
        {templates.map((t) => <Tooltip key={t.key} content={t.steps.join(" → ")}><button type="button" role="radio" className={css.chip} aria-checked={template === t.key} onClick={() => setTemplate(t.key)}><LayoutTemplate size={13} aria-hidden="true" />{t.name}</button></Tooltip>)}
      </div></div>
    {template ? <p className={css.steps}>{templates.find((t) => t.key === template)?.steps.map((s, i) => <span key={s}>{i ? <i aria-hidden="true">→</i> : null}{s}</span>)}</p> : null}
    {error ? <p className={css.error} role="alert">{error}</p> : null}
    <footer className={css.actions}><span className={css.hintQuiet}>{type === "fulfilment" ? "The client package stays under Clients; its work lives here." : "You can add tasks right after."}</span>
      <button className={css.primary} disabled={busy || !ok}>{busy ? "Saving…" : type === "internal" ? "Create project" : "Set up fulfilment"}</button></footer>
  </form>;
}

// ------------------------------------------------------------------------------------------------ pickers (kept for other pages)
/** One person, searchable, with photos (the kit's PersonSelect). `showAsk` marks people the viewer would ask rather than assign. */
export function PersonPicker({ people, value, onChange, me, label, showAsk, autoFocus }: { people: Person[]; value: Person | null; onChange: (p: Person | null) => void; me: string; label: string; showAsk?: boolean; autoFocus?: boolean }) {
  return <PersonSelect label={label} people={people} value={value?.id ?? null} me={me} autoOpen={autoFocus} askTag={showAsk ? <span className={css.askTag} title="You ask; they accept or decline">Ask</span> : undefined}
    onChange={(p) => onChange(p ? people.find((x) => x.id === p.id) ?? null : null)} />;
}
/** A project, searchable, recent first (the kit's Combobox). */
export function ProjectPicker({ projects, value, onChange, label = "Project", autoFocus }: { projects: Project[]; value: string | null; onChange: (id: string | null) => void; label?: string; autoFocus?: boolean }) {
  const items = useMemo<Option[]>(() => projects.map((p) => ({ value: p.id, label: p.name, detail: p.recent ? "Recent" : p.clientName ?? undefined, keywords: p.clientName ?? "", icon: <KindChip kind={kindOf(p.kind)} short /> })), [projects]);
  return <Combobox label={label} options={items} value={value} onChange={onChange} noneLabel="No project" placeholder="No project" searchable searchPlaceholder="Search projects" autoOpen={autoFocus} />;
}
export type { WorkKind };
