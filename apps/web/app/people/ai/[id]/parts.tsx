"use client";
// CHAT-WORK: the parts of an AI employee's profile that change: what it can do here now (from what Pulse recorded of its
// runtime, never guessed), its settings (its manager or an admin), what it knows, and what it has done.
// AI-EMPLOYEES v2: these are the "AI" section of the one profile everyone has (People -> person -> AI).
// UI-UPGRADE (owner, 24 Oct 2026: "ugly and unusable"): the section is a summary (status, what it runs on, its last run,
// today's use, its rules as short rows with the details behind "How these work") over a settings layout with a left
// sub-nav: Behaviour, Model & limits, Role & place, Tools & training, then Knowledge, Groups & projects, Asked first and
// History. One form keeps every setting; a sticky bar says what is unsaved, and saving confirms with a toast. Models
// read as people say them; a run that used a stand-in model says so. Pickers open lists (no native selects).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { AtSign, BookOpen, Brain, BriefcaseBusiness, Check, CircleAlert, CircleCheck, CircleX, Clock3, Cpu, Ear, Hash, History as HistoryIcon, KeyRound, ListChecks,
  LoaderCircle, MessagesSquare, MinusCircle, Plug, Plus, RotateCcw, ShieldCheck, ShieldQuestion, Trash2, UserCheck, UsersRound, Wrench } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { post } from "../../../records";
import { styles } from "../../../ui";
import { Combobox, PersonSelect, SaveBar, Segmented, Select, type Option } from "../../../kit";
import { Disclosure } from "../../../kit/disclosure";
import { MODELS, TOOLS } from "../../add-member";
import css from "./profile.module.css";
import { AUTONOMY, FAMILY_NAME, KINDS, KIND_SHORT, PROVIDER, THINKING, modelFamily, modelName, type Autonomy } from "./model";

export type AiDetail = {
  canManage: boolean; canGiveTasks: boolean;
  settings: { provider: string; model: string; effort: string; lane: string; tools: string[]; speakScope: string; speakChannels: string[]; interject: string;
    dailyTokenBudget: number; runReserve: number; ownerId: string; pod: string | null; department: string | null; title: string;
    /** AI-EMPLOYEES v2. */
    listensTo?: "leaders" | "everyone"; autonomy?: Partial<Record<"direct" | "mention" | "group", Autonomy>>; approverId?: string | null; approverName?: string | null;
    instructions?: string; sopLinks?: string[]; mcpServers?: string[]; paused?: boolean };
  runtime: { state: "unknown" | "ready" | "out_of_quota" | "error"; until: string | null; seenAt: string | null; detail: string | null; keyUsedAt: string | null; keys: number;
    lastRun: { at: string; lane: string; model: string; state: string; errorCode: string | null } | null };
  groups: { id: string; name: string; kind: string }[];
  memory: { id: string; body: string; source: "manager" | "agent"; at: string; by: string; taskId: string | null }[];
  /** UI-UPGRADE (0990): `ask` is the first words of the message it answered (only where the viewer may read it), `channelId`/`channelName` where;
   *  `error` the runtime's reason; `retry` whether the viewer may run it again. */
  runs: { id: string; at: string; state: string; lane: string; model: string; tokens: number | null; seconds: number | null; errorCode: string | null; kind: string; taskId: string | null; taskTitle: string | null;
    ask?: string | null; channelId?: string | null; channelName?: string | null; error?: string | null; retry?: boolean; engine?: string | null; fallbackFrom?: string | null }[];
  tasks: { id: string; title: string; status: string; statusLabel: string; updatedAt: string }[];
  proposals?: { id: string; at: string; state: "pending" | "sent" | "dismissed" | "expired"; body: string; channelId: string; channelName: string | null; approver: string | null; decidedBy: string | null; decidedAt: string | null; via: "button" | "reply" | null; edited: boolean }[];
  projects?: { id: string; title: string; role: string }[];
  /** CONNECT-AI: the AI it uses (one of the organisation's connections, or this server's sign-in) and where it runs. */
  ai?: { access?: "standard" | "operations"; connectionId: string | null; workspaceId: string | null; connectionName: string | null; connectionProvider: string | null; connectionKind: string | null;
    connectionState: string | null; connectionRemoved: boolean; workspaceName: string | null; /** FEATURES-1024 (0987): channel id → whom it asks there. */ groupApprovers?: Record<string, string> } | null;
};
/** CONNECT-AI: what may be chosen (GET /api/v0/ai/choices): never a secret, only names and states. */
type Choices = { paidApiKeys: boolean; canConnect: boolean;
  connections: { id: string; kind: "subscription" | "api"; provider: string; providerName: string; name: string; account: string | null; models: string[]; model: string | null;
    cap: number | null; used: number; state: string; until: string | null; workspaceId: string | null; masked: string | null }[];
  server: { id: string; provider: string; name: string; account: string | null; state: string; until: string | null }[];
  workspaces: { id: string; name: string; state: string }[] };
type Person = { value: string; label: string };
type Usage = { dailyBudget: number; usedToday: number } | null;

const STATE_WORD: Record<string, string> = { connected: "", out_of_quota: "out of quota", expired: "signed out", error: "needs attention" };
const API_ONLY = new Set(["anthropic_api", "openai_api"]);
const PROVIDER_MODELS: Record<string, string[]> = { ...MODELS, anthropic_api: MODELS.claude, openai_api: MODELS.codex, stub: ["stub"] };
const THINKING_HINT: Record<string, string> = { low: "Quick answers, least effort", medium: "A balance of speed and care", high: "Thinks it through", xhigh: "Most careful, slowest" };
const ALL_TOOLS = [...TOOLS,
  { value: "projects", label: "Projects", hint: "Reads the projects it coordinates" },
  { value: "drive", label: "Drive", hint: "Reads the company Drive" },
  { value: "web", label: "Web", hint: "Searches and reads the web" },
  { value: "server", label: "Server access", hint: "Runs commands on the company server" },
  { value: "mcp", label: "MCP servers", hint: "Uses the connected MCP servers named below" }] as const;
/** What the runtime on this server actually gives it today (CHAT-WORK runtime: the model is called with every tool off). */
const LIVE_TOOLS = new Set(["chats", "tasks", "memory", "board"]);
const autonomyOf = (s: AiDetail["settings"]) => ({ direct: s.autonomy?.direct ?? "own", mention: s.autonomy?.mention ?? "own", group: s.autonomy?.group ?? "off" }) as Record<"direct" | "mention" | "group", Autonomy>;
const SUBSCRIPTION: Record<string, string> = { claude: "Claude subscription", codex: "ChatGPT (Codex) subscription" };
const ZONE = "Asia/Kolkata";
const at = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: ZONE });
const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: ZONE });
const dayKey = (t: number) => new Date(t).toLocaleDateString("en-CA", { timeZone: ZONE });
const fmt = (n: number) => Math.round(n).toLocaleString("en-IN");
const trim = (n: number) => (Math.round(n * 10) / 10).toString();
/** 300000 → "3 lakh", 45000 → "45k": the size of a token figure at a glance. */
const size = (n: number) => n >= 100000 ? `${trim(n / 100000)} lakh` : n >= 1000 ? `${trim(n / 1000)}k` : String(n);
const when = (iso: string | null, now: number) => {
  if (!iso) return "never";
  const s = Math.round((now - Date.parse(iso)) / 1000);
  return s < 90 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : at(iso);
};
function dayLabel(key: string, now: number) {
  if (key === dayKey(now)) return "Today";
  if (key === dayKey(now - 86400000)) return "Yesterday";
  return new Date(`${key}T12:00:00+05:30`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: ZONE });
}
/** Why a run stopped, in plain words (the runtime's own reason when it gave one). */
const REASON: Record<string, string> = {
  out_of_quota: "The AI's plan was out of quota, so it stopped. It resets on its own.", model_error: "The AI answered with an error.", timeout: "It took too long and was stopped.",
  budget: "Its daily limit was used up.", budget_exceeded: "Its daily limit was used up.", refused: "Pulse refused what it tried to do.", cancelled: "Someone stopped it.",
  no_runtime: "Its runtime was not running.", runtime_error: "Its runtime hit a problem.", rate_limited: "The AI asked it to slow down; it stopped.",
  no_answer: "It finished without an answer.", stuck: "It got stuck and was stopped.", budget_spent: "Its daily limit was used up.", hourly_limit: "It hit its hourly limit.",
  one_at_a_time: "It was busy with another run.", paused: "It was paused.", expired: "The question waited over a day, so it was not answered late.",
  gave_up: "Its runtime could not start it after five tries.", released: "Its runtime handed it back unstarted.", message_gone: "The message was removed first.",
  not_leader: "The person asking is not someone it listens to.", agent_left: "It had left the conversation.", asker_left: "The person asking had left.", not_chats: "Chats is off in its tools.",
};
/** An engine of the runtime's chain (FEATURES-1024), as people say it. */
const engineName = (e: string) => { const [k, v] = e.split(":"); return k === "server" ? `${v === "codex" ? "ChatGPT" : "Claude"} (this server)` : k === "env" ? `${v === "openai" ? "OpenAI" : v === "openrouter" ? "OpenRouter" : "Claude"} API`
  : k === "local" ? "a local model" : k === "connection" ? "a connected AI" : e; };
const reasonOf = (r: { errorCode: string | null; error?: string | null }) => r.error?.trim() || (r.errorCode ? REASON[r.errorCode] ?? `It stopped (${r.errorCode.replaceAll("_", " ")}).` : "It stopped without saying why.");

/** What the AI employee is doing now, from its runtime's last report (never guessed). */
function headOf(d: AiDetail, status: "on" | "paused" | "off", now: number) {
  const r = d.runtime, s = d.settings;
  const live = !!r.keyUsedAt && now - Date.parse(r.keyUsedAt) < 3 * 60000;
  const quota = r.state === "out_of_quota" && (!r.until || Date.parse(r.until) > now);
  type Head = { ok: "yes" | "no" | "wait" | "idle"; word: string; text: string };
  const h: Head = status !== "on" ? { ok: "no", word: status === "paused" ? "Paused" : "Switched off", text: status === "paused" ? "An admin switches it back on." : "It does nothing until it is switched on." }
    : d.ai?.connectionId && d.ai.connectionRemoved ? { ok: "no", word: "No AI", text: `Its AI (${d.ai.connectionName}) was disconnected. Choose another in Model & limits.` }
    : d.ai?.connectionId && d.ai.connectionState === "expired" ? { ok: "no", word: "Signed out", text: `${d.ai.connectionName} is signed out or its key was refused. An admin reconnects it in Settings → AI.` }
    : API_ONLY.has(s.provider) ? { ok: "no", word: "Not connected", text: "Connect an AI in Settings → AI, then choose it in Model & limits. The setting is kept." }
    : !r.keys ? { ok: "no", word: "Not connected", text: "The operator connects its runtime on this server (one command, see the handoff notes)." }
    // EA-AI: this server's subscription is waiting for its quota (the runtime knows the plan's own reset time): say so plainly.
    : quota ? { ok: "wait", word: "Waiting for quota", text: `The ${SUBSCRIPTION[s.provider] ?? `${PROVIDER[s.provider] ?? s.provider} plan`} is out of quota${r.until ? ` until ${at(r.until)}` : ""}. What it is given waits and starts then.` }
    : r.state === "error" ? { ok: "no", word: "Needs attention", text: `Its runtime reported a problem${r.detail ? `: ${r.detail}` : ""} (${when(r.seenAt, now)}).` }
    : live ? { ok: "yes", word: "Working", text: `Its runtime checked in ${when(r.keyUsedAt, now)}.` }
    : { ok: "idle", word: "Not running", text: `Its runtime last checked in ${when(r.keyUsedAt, now)}.` };
  return { ...h, quota };
}
/** A run that used another maker's model than its settings: a stand-in (say, ChatGPT while Claude's quota is out). */
function standIn(model: string | null | undefined, configured: string, quota: boolean) {
  const ran = modelFamily(model), want = modelFamily(configured);
  if (!model || ran === "other" || want === "other" || ran === want) return null;
  return `stand-in while ${FAMILY_NAME[want]} ${quota ? "is out of quota" : "was unavailable"}`;
}
const StateIcon = ({ ok, size: px = 15 }: { ok: string; size?: number }) => ok === "yes" ? <CircleCheck size={px} aria-hidden="true" /> : ok === "wait" ? <Clock3 size={px} aria-hidden="true" />
  : ok === "idle" ? <MinusCircle size={px} aria-hidden="true" /> : <CircleAlert size={px} aria-hidden="true" />;

// ------------------------------------------------------------------------------------------------------------ summary
/** The top of the AI section: status, what it runs on, its last run, today's use, and its rules as short rows. */
function AiSummary({ d, status, usage }: { d: AiDetail; status: "on" | "paused" | "off"; usage: Usage }) {
  const s = d.settings, r = d.runtime;
  const [now] = useState(() => Date.now());
  const head = headOf(d, status, now);
  const has = (t: string) => s.tools.includes(t);
  const a = autonomyOf(s);
  const runtimeName = d.ai?.connectionName ?? PROVIDER[s.provider] ?? s.provider;
  const last = r.lastRun, lastStand = last ? standIn(last.model, s.model, head.quota) : null;
  const lastWord = !last ? "" : last.state === "error" ? (last.errorCode === "out_of_quota" ? "out of quota" : "failed") : last.state === "done" ? "done" : last.state === "uncertain" ? "stuck" : "running";
  const recent = d.runs.length, failed = d.runs.filter((x) => x.state === "error").length;
  const used = usage?.usedToday ?? 0, budget = usage?.dailyBudget || s.dailyTokenBudget, pct = budget ? Math.min(100, Math.round((used / budget) * 100)) : 0;
  const blocked = s.tools.filter((t) => !LIVE_TOOLS.has(t) && t !== "chats").map((t) => ALL_TOOLS.find((x) => x.value === t)?.label ?? t);
  const who = s.listensTo === "everyone" ? "anyone in its conversations (clients too)" : "leaders";
  const approver = s.approverName ?? "the person it reports to";
  const rules: { key: string; icon: ReactNode; label: string; value: string; ok: "yes" | "no" | "wait" }[] = [
    ...KINDS.map((k) => ({ key: k.key, icon: k.key === "direct" ? <MessagesSquare size={15} aria-hidden="true" /> : k.key === "mention" ? <AtSign size={15} aria-hidden="true" /> : <Hash size={15} aria-hidden="true" />,
      label: KIND_SHORT[k.key], value: has("chats") ? AUTONOMY[a[k.key]] : "Off", ok: (!has("chats") || a[k.key] === "off" ? "no" : a[k.key] === "approve" ? "wait" : "yes") as "yes" | "no" | "wait" })),
    { key: "listens", icon: <Ear size={15} aria-hidden="true" />, label: "Listens to", value: s.listensTo === "everyone" ? "Everyone, clients too" : "Leaders only", ok: "yes" },
    { key: "approver", icon: <UserCheck size={15} aria-hidden="true" />, label: "Approves for it", value: s.approverName ?? "Who it reports to", ok: "yes" },
    ...(d.ai?.access === "operations" ? [{ key: "ops", icon: <ShieldCheck size={15} aria-hidden="true" />, label: "Operations access", value: "Always asks first", ok: "wait" as const }] : []),
    { key: "tasks", icon: <ListChecks size={15} aria-hidden="true" />, label: "Tasks", value: has("tasks") ? "Takes tasks" : "Off", ok: has("tasks") ? "yes" : "no" },
    { key: "memory", icon: <Brain size={15} aria-hidden="true" />, label: "Memory", value: has("memory") ? "Keeps notes" : "Off", ok: has("memory") ? "yes" : "no" },
    ...(blocked.length ? [{ key: "blocked", icon: <Plug size={15} aria-hidden="true" />, label: blocked.join(", "), value: "Allowed, not connected", ok: "no" as const }] : []),
  ];
  return <section className={css.summary} aria-label="What it can do here" data-runtime={r.state}>
    <div className={css.sumHead}>
      <span className={css.state} data-ok={head.ok}><StateIcon ok={head.ok} size={14} />{head.word}</span>
      <h3 className={css.sumTitle}><Cpu size={16} aria-hidden="true" />{modelName(s.model)}<span>· {THINKING[s.effort] ?? s.effort} thinking</span></h3>
      <p className={css.sumSub}>Runs on {runtimeName}{d.ai?.workspaceName ? ` · ${d.ai.workspaceName}` : ""}. {head.text}</p>
    </div>
    <dl className={css.stats}>
      <div><dt>Last run</dt>
        <dd>{last ? <><b>{when(last.at, now)}</b> · {lastWord}</> : <b>None yet</b>}</dd>
        {last ? <small>{lastStand ? <>Ran on <b>{modelName(last.model)}</b> ({lastStand})</> : <>Ran on {modelName(last.model || s.model)}</>}</small> : <small>It has not been asked anything yet.</small>}</div>
      <div><dt>Today</dt>
        <dd><b>{fmt(used)}</b> of {size(budget)} tokens</dd>
        <span className={css.meter} role="progressbar" aria-label="Daily budget" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} data-high={pct >= 85 ? "" : undefined}><span style={{ width: `${pct}%` }} /></span></div>
      <div><dt>Recent runs</dt>
        <dd><b>{recent - failed}</b> done{failed ? <> · <span className={css.bad}>{failed} failed</span></> : null}</dd>
        <small>Its last {recent || "few"} runs, in History.</small></div>
    </dl>
    <ul className={css.rules} aria-label="Its rules">{rules.map((x) => <li key={x.key} data-ok={x.ok}><span className={css.ruleIcon}>{x.icon}</span><span className={css.ruleLabel}>{x.label}</span><b>{x.value}</b></li>)}</ul>
    <Disclosure summary="How these work" className={css.more}>
      <ul className={css.explain}>
        {KINDS.map((k) => <li key={k.key}><b>{k.label}.</b> {!has("chats") ? "Chats is off in its tools." : a[k.key] === "off" ? "It does not act on these." : a[k.key] === "approve"
          ? `From ${who}: it sends ${approver} a direct message with what it would post; it posts in the conversation only after Send it.`
          : `From ${who}: it answers in the conversation itself${k.key === "group" ? ", only when it can help" : ""}.`}</li>)}
        {d.ai?.access === "operations" ? <li><b>Operations access.</b> Sees the whole company and proposes work for anyone; it always asks first. Pulse refuses it any delete, money, access or security change, and any message to a client a person has not approved.</li> : null}
        <li><b>Tasks.</b> {has("tasks") ? "A task given to it (by a leader or its manager) starts its runtime; it reports in the task’s chat and sends finished work to its manager’s review." : "Off: tasks cannot be given to it."}</li>
        <li><b>Memory.</b> {has("memory") ? "Every run is given its notes; after a task it may add what it learned." : "Off: its notes are kept but it adds none."}</li>
        {blocked.length ? <li><b>{blocked.join(", ")}.</b> {s.tools.includes("mcp") && s.mcpServers?.length ? `${s.mcpServers.join(", ")}: ` : ""}Allowed on its profile, but this server’s runtime runs the model with every tool off, so it does not use these yet.</li> : null}
      </ul>
    </Disclosure>
  </section>;
}

// ------------------------------------------------------------------------------------------------------------ the tab
type Section = "behaviour" | "model" | "role" | "tools" | "knowledge" | "places" | "asked" | "history";
const SECTIONS: { key: Section; label: string; icon: ReactNode; group: "Settings" | "Activity" }[] = [
  { key: "behaviour", label: "Behaviour", icon: <MessagesSquare size={16} aria-hidden="true" />, group: "Settings" },
  { key: "model", label: "Model & limits", icon: <Cpu size={16} aria-hidden="true" />, group: "Settings" },
  { key: "role", label: "Role & place", icon: <BriefcaseBusiness size={16} aria-hidden="true" />, group: "Settings" },
  { key: "tools", label: "Tools & training", icon: <Wrench size={16} aria-hidden="true" />, group: "Settings" },
  { key: "knowledge", label: "Knowledge", icon: <BookOpen size={16} aria-hidden="true" />, group: "Activity" },
  { key: "places", label: "Groups & projects", icon: <UsersRound size={16} aria-hidden="true" />, group: "Activity" },
  { key: "asked", label: "Asked first", icon: <ShieldQuestion size={16} aria-hidden="true" />, group: "Activity" },
  { key: "history", label: "History", icon: <HistoryIcon size={16} aria-hidden="true" />, group: "Activity" },
];
const isSection = (x: unknown): x is Section => SECTIONS.some((s) => s.key === x);

type Form = { title: string; pod: string; department: string; ownerId: string; aiChoice: string; model: string; aiWorkspaceId: string; effort: string; lane: string;
  listensTo: "leaders" | "everyone"; autonomy: Record<"direct" | "mention" | "group", Autonomy>; approverId: string; speakScope: string; speakChannels: string[];
  tools: string[]; mcpServers: string; instructions: string; sopLinks: string; dailyTokenBudget: number };
const formOf = (d: AiDetail): Form => {
  const s = d.settings;
  return { title: s.title, pod: s.pod ?? "", department: s.department ?? "", ownerId: s.ownerId, aiChoice: d.ai?.connectionId ?? (["claude", "codex", "stub"].includes(s.provider) ? s.provider : ""),
    model: s.model ?? "", aiWorkspaceId: d.ai?.workspaceId ?? "cloud", effort: s.effort, lane: s.lane, listensTo: s.listensTo ?? "leaders", autonomy: autonomyOf(s), approverId: s.approverId ?? "",
    speakScope: s.speakScope, speakChannels: s.speakChannels, tools: s.tools, mcpServers: (s.mcpServers ?? []).join("\n"), instructions: s.instructions ?? "", sopLinks: (s.sopLinks ?? []).join("\n"),
    dailyTokenBudget: s.dailyTokenBudget };
};
/** Which section each setting lives in (the sub-nav marks a section with unsaved changes). */
const FIELD_SECTION: Record<keyof Form, Section> = { title: "role", pod: "role", department: "role", ownerId: "role", aiChoice: "model", model: "model", aiWorkspaceId: "model", effort: "model", lane: "model",
  dailyTokenBudget: "model", listensTo: "behaviour", autonomy: "behaviour", approverId: "behaviour", speakScope: "behaviour", speakChannels: "behaviour", tools: "tools", mcpServers: "tools", instructions: "tools", sopLinks: "tools" };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The AI section: summary, then its settings and activity behind a left sub-nav (a row of chips on a phone). */
export function AiTab({ id, detail: d, status, usage, people = [], initial }: { id: string; detail: AiDetail; status: "on" | "paused" | "off"; usage: Usage; people?: Person[]; initial?: string }) {
  const router = useRouter();
  const [section, setSection] = useState<Section>(isSection(initial) ? initial : "behaviour");
  const [form, setForm] = useState<Form>(() => formOf(d)), [base, setBase] = useState<Form>(() => formOf(d));
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [choices, setChoices] = useState<Choices | null>(null), [denied, setDenied] = useState(false);
  // A refreshed profile (after a save, a note or a group change) becomes the new baseline; unsaved edits are kept.
  const [from, setFrom] = useState(d);
  if (from !== d) { setFrom(d); const f = formOf(d); setBase(f); if (same(form, base)) setForm(f); }
  useEffect(() => {
    let live = true;
    void fetch("/api/v0/ai/choices", { cache: "no-store" }).then(async (r) => { if (!live) return; if (!r.ok) { setDenied(true); return; } setChoices(await r.json() as Choices); }).catch(() => { if (live) setDenied(true); });
    return () => { live = false; };
  }, []);
  const ro = !d.canManage;
  const changed = (Object.keys(form) as (keyof Form)[]).filter((k) => !same(form[k], base[k]));
  const dirty = changed.length > 0, dirtySections = new Set(changed.map((k) => FIELD_SECTION[k]));
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const go = (s: Section) => {
    setSection(s);
    try { const u = new URL(window.location.href); u.searchParams.set("s", s); window.history.replaceState(window.history.state, "", u); } catch { /* old browser */ }
  };
  const navKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = e.key === "ArrowDown" || e.key === "ArrowRight" ? (i + 1) % SECTIONS.length : e.key === "ArrowUp" || e.key === "ArrowLeft" ? (i - 1 + SECTIONS.length) % SECTIONS.length : e.key === "Home" ? 0 : e.key === "End" ? SECTIONS.length - 1 : -1;
    if (n < 0) return;
    e.preventDefault(); go(SECTIONS[n].key); document.getElementById(`ai-tab-${SECTIONS[n].key}`)?.focus();
  };
  const conn = choices?.connections.find((c) => c.id === form.aiChoice);
  async function save(e?: FormEvent) {
    e?.preventDefault(); if (ro || busy) return;
    const lines = (v: string) => v.split(/\n+/).map((x) => x.trim()).filter(Boolean);
    const pick = !!choices && !denied;
    // CONNECT-AI: an AI employee needs an AI to think with; without one, say where to connect it.
    if (pick && !form.aiChoice) { setError("Connect an AI first (Settings → AI), then choose it in Model & limits."); go("model"); return; }
    if (!form.title.trim()) { setError("Give it a role (Role & place)."); go("role"); return; }
    setBusy(true); setError("");
    try {
      await post(`agents/${id}/settings`, { title: form.title.trim(), ownerId: form.ownerId || undefined, pod: form.pod, department: form.department, model: form.model, effort: form.effort, lane: form.lane,
        ...(pick ? { aiChoice: form.aiChoice, aiWorkspaceId: conn?.kind === "api" || form.aiChoice === "stub" ? "cloud" : form.aiWorkspaceId || "cloud" } : {}),
        dailyTokenBudget: form.dailyTokenBudget, tools: form.tools, speakScope: form.speakScope, speakChannels: form.speakChannels, interject: form.autonomy.group === "off" ? "when_asked" : "when_relevant",
        listensTo: form.listensTo, autonomy: form.autonomy, approverId: form.approverId, instructions: form.instructions, sopLinks: lines(form.sopLinks), mcpServers: lines(form.mcpServers) });
      setBase(form);
      notify({ id: "ai-settings", tone: "success", title: "Saved", message: `${changed.length === 1 ? "1 change" : `${changed.length} changes`} to its settings`, timeout: 2600 });
      router.refresh();
    } catch (err) {
      const m = (err as Error).message; setError(m);
      notify({ id: "ai-settings", tone: "error", title: "Not saved", message: m });
    } finally { setBusy(false); }
  }
  const counts: Partial<Record<Section, number>> = { knowledge: d.memory.length, places: d.groups.length + (d.projects?.length ?? 0), asked: (d.proposals ?? []).filter((p) => p.state === "pending").length || undefined, history: d.runs.length };
  return <div className={css.aiTab}>
    <AiSummary d={d} status={status} usage={usage} />
    <div className={css.layout}>
      <nav className={css.subnav} aria-label="AI sections">
        {(["Settings", "Activity"] as const).map((g) => { const items = SECTIONS.filter((s) => s.group === g), here = items.some((s) => s.key === section);
          return <div key={g} className={css.navSet}><p className={css.navGroup} id={`ai-nav-${g}`}>{g}</p>
            <div role="tablist" aria-orientation="vertical" aria-labelledby={`ai-nav-${g}`}>{items.map((s, k) => { const i = SECTIONS.indexOf(s);
              return <button key={s.key} id={`ai-tab-${s.key}`} type="button" role="tab" aria-selected={section === s.key} aria-controls={`ai-pane-${s.key}`} tabIndex={section === s.key || (!here && k === 0) ? 0 : -1}
                className={css.navItem} onClick={() => go(s.key)} onKeyDown={(e) => navKey(e, i)}>
                {s.icon}<span>{s.label}</span>{dirtySections.has(s.key) ? <i className={css.navDirty} aria-label="unsaved changes" /> : counts[s.key] ? <small>{counts[s.key]}</small> : null}
              </button>; })}</div></div>; })}
      </nav>
      <div className={css.panes}>
        {ro ? <p className={css.roNote}><CircleAlert size={15} aria-hidden="true" />Admins, HR, leadership or the person it reports to change these settings.</p> : null}
        <form className={css.settings} onSubmit={(e) => void save(e)} aria-label="AI employee settings" hidden={!["behaviour", "model", "role", "tools"].includes(section)}>
          <fieldset disabled={ro || busy}>
            <Pane id="behaviour" active={section} title="Behaviour" sub="When it answers on its own, when it asks first, and who it listens to.">
              <Group title="Who it listens to">
                <Segmented label="Who it listens to" value={form.listensTo} onChange={(v) => set("listensTo", v)} options={[{ value: "leaders", label: "Leaders only" }, { value: "everyone", label: "Everyone, clients too" }]} />
              </Group>
              <Group title="How it acts" help={form.tools.includes("chats") ? undefined : "Chats is off in its tools, so it acts on no messages."}>
                <div className={css.kinds}>{KINDS.map((k) => <div key={k.key} className={css.kind}>
                  <span><b>{KIND_SHORT[k.key]}</b><small>{k.hint}</small></span>
                  <Segmented size="sm" label={k.label} value={form.autonomy[k.key]} onChange={(v) => set("autonomy", { ...form.autonomy, [k.key]: v })}
                    options={(Object.keys(AUTONOMY) as Autonomy[]).map((v) => ({ value: v, label: v === "own" ? "On its own" : AUTONOMY[v] }))} />
                </div>)}</div>
              </Group>
              <Group title="Who approves" help="When it asks first, this person gets what it would post, and it posts only after they press Send it.">
                <PersonSelect label="Who approves" people={people.map((p) => ({ id: p.value, name: p.label }))} value={form.approverId || null} noneLabel="The person it reports to" placeholder="The person it reports to"
                  onChange={(p) => set("approverId", p?.id ?? "")} />
              </Group>
              <Group title="Where it may speak">
                <Select label="Where it may speak" value={form.speakScope} onChange={(v) => set("speakScope", v ?? "its_groups")}
                  options={[{ value: "its_groups", label: "Any group it is in" }, { value: "listed", label: "Only the groups I tick" }, { value: "direct_only", label: "Direct messages only" }]} />
                {form.speakScope === "listed" ? <div className={css.checks} role="group" aria-label="Groups it may speak in">{d.groups.length ? d.groups.map((g) => <label key={g.id}>
                  <input type="checkbox" checked={form.speakChannels.includes(g.id)} onChange={(e) => set("speakChannels", e.target.checked ? [...form.speakChannels, g.id] : form.speakChannels.filter((y) => y !== g.id))} />{g.name}</label>)
                  : <small className={styles.muted}>It is in no group yet (Groups & projects).</small>}</div> : null}
              </Group>
            </Pane>
            <Pane id="model" active={section} title="Model & limits" sub="The AI it thinks with, how hard it thinks, and how much it may use a day.">
              <AiPick d={d} form={form} set={set} choices={choices} denied={denied} />
              <Group title="Thinking">
                <Segmented label="Thinking" value={form.effort} onChange={(v) => set("effort", v)} options={Object.entries(THINKING).map(([value, label]) => ({ value, label, hint: THINKING_HINT[value] }))} />
              </Group>
              <Group title="Answers" help="Quick answers short questions at once; Thinking takes longer and checks its work.">
                <Segmented label="Answers" value={form.lane} onChange={(v) => set("lane", v)} options={[{ value: "quick", label: "Quick" }, { value: "thinking", label: "Thinking" }]} />
              </Group>
              <Budget value={form.dailyTokenBudget} onChange={(v) => set("dailyTokenBudget", v)} runs={d.runs} />
            </Pane>
            <Pane id="role" active={section} title="Role & place" sub="Its job title, where it sits and who it reports to.">
              <label className={css.field}><span>Role</span><input value={form.title} onChange={(e) => set("title", e.target.value)} maxLength={120} required /></label>
              <div className={css.pair}>
                <label className={css.field}><span>Pod</span><input value={form.pod} onChange={(e) => set("pod", e.target.value)} maxLength={80} placeholder="e.g. Leadership" /><small>It joins the pod’s group.</small></label>
                <label className={css.field}><span>Team</span><input value={form.department} onChange={(e) => set("department", e.target.value)} maxLength={80} placeholder="e.g. Operations" /><small>It joins the team’s group.</small></label>
              </div>
              {people.length ? <Group title="Reports to" help="This person manages it and, unless someone else is chosen, approves what it asks first.">
                <PersonSelect label="Reports to" people={people.map((p) => ({ id: p.value, name: p.label }))} value={form.ownerId || null} onChange={(p) => set("ownerId", p?.id ?? form.ownerId)} />
              </Group> : null}
            </Pane>
            <Pane id="tools" active={section} title="Tools & training" sub="What it may use, and how it should work here.">
              <Group title="Tools it may use">
                <ul className={css.toolList}>{ALL_TOOLS.map((t) => { const on = form.tools.includes(t.value); return <li key={t.value}>
                  <label><span><b>{t.label}</b><small>{t.hint}</small></span>
                    {LIVE_TOOLS.has(t.value) ? null : <em className={css.tag}>Not connected yet</em>}
                    <input type="checkbox" role="switch" className={css.switch} checked={on} onChange={(e) => set("tools", e.target.checked ? [...form.tools, t.value] : form.tools.filter((y) => y !== t.value))} /></label></li>; })}</ul>
                <small className={css.help}>“Not connected yet”: allowed on its profile, but this server’s runtime runs the model with every tool off.</small>
              </Group>
              {form.tools.includes("mcp") ? <label className={css.field}><span>MCP servers</span><textarea rows={2} value={form.mcpServers} onChange={(e) => set("mcpServers", e.target.value)} placeholder="One per line, e.g. drive" /></label> : null}
              <label className={css.field}><span>Instructions</span><textarea rows={6} maxLength={8000} value={form.instructions} onChange={(e) => set("instructions", e.target.value)} placeholder="How it works here: tone, what it never promises, when to hand over to a person" />
                <small>Its standing brief, given to every run. {form.instructions.length ? `${fmt(form.instructions.length)} of 8,000 characters.` : ""}</small></label>
              <label className={css.field}><span>SOP links</span><textarea rows={2} value={form.sopLinks} onChange={(e) => set("sopLinks", e.target.value)} placeholder="One per line: https://… or /flow/…" /><small>Procedures it should follow.</small></label>
            </Pane>
          </fieldset>
        </form>
        {section === "knowledge" ? <AiMemory id={id} detail={d} /> : null}
        {section === "places" ? <AiPlaces id={id} detail={d} lead={!!d.canManage} people={people} /> : null}
        {section === "asked" ? <AiProposals detail={d} /> : null}
        {section === "history" ? <AiHistory id={id} detail={d} /> : null}
      </div>
    </div>
    {ro ? null : <SaveBar changes={changed.length} busy={busy} error={dirty ? error : ""} onSave={() => void save()} onDiscard={() => { setForm(base); setError(""); }} />}
  </div>;
}

function Pane({ id, active, title, sub, children }: { id: Section; active: Section; title: string; sub?: string; children: ReactNode }) {
  return <section className={css.pane} role="tabpanel" id={`ai-pane-${id}`} aria-labelledby={`ai-tab-${id}`} hidden={active !== id}>
    <header className={css.paneHead}><div><h3>{title}</h3>{sub ? <p>{sub}</p> : null}</div></header>
    <div className={css.paneBody}>{children}</div>
  </section>;
}
function Group({ title, help, children, aside }: { title: string; help?: string; children: ReactNode; aside?: ReactNode }) {
  return <div className={css.fieldGroup}><div className={css.groupHead}><span>{title}</span>{aside}</div>{children}{help ? <small className={css.help}>{help}</small> : null}</div>;
}
/** A panel of the Activity half: the same card as the settings panes. */
function ActivityPane({ id, title, sub, tools, children }: { id?: Section; title: string; sub?: string; tools?: ReactNode; children: ReactNode }) {
  return <section className={css.pane} role={id ? "tabpanel" : undefined} id={id ? `ai-pane-${id}` : undefined} aria-labelledby={id ? `ai-tab-${id}` : undefined} aria-label={id ? undefined : title}>
    <header className={css.paneHead}><div><h3>{title}</h3>{sub ? <p>{sub}</p> : null}</div>{tools ? <div className={css.paneTools}>{tools}</div> : null}</header>
    <div className={css.paneBody}>{children}</div>
  </section>;
}

/** Daily limit: a slider and a typed figure (with thousands separators), and what that means in runs. */
function Budget({ value, onChange, runs }: { value: number; onChange: (v: number) => void; runs: AiDetail["runs"] }) {
  const [text, setText] = useState<string | null>(null);
  const known = runs.filter((r) => r.tokens && r.tokens > 0), avg = known.length ? known.reduce((s, r) => s + (r.tokens ?? 0), 0) / known.length : 0;
  const commit = (raw: string) => { const n = Number(raw.replace(/[^\d]/g, "")); if (Number.isFinite(n) && n > 0) onChange(Math.max(1000, Math.min(2000000, Math.round(n / 1000) * 1000))); setText(null); };
  return <Group title="Daily limit" help={`${avg ? `About ${fmt(Math.max(1, Math.floor(value / avg)))} runs a day at its recent ${fmt(avg)} tokens a run. ` : ""}It stops for the day when this is used; a subscription's own limits still apply.`}>
    <div className={css.budget}>
      <input type="range" min={10000} max={2000000} step={10000} value={Math.min(2000000, Math.max(10000, value))} onChange={(e) => onChange(Number(e.target.value))} aria-label="Daily limit in tokens" />
      <label className={css.budgetBox}><input inputMode="numeric" aria-label="Daily limit (tokens)" value={text ?? fmt(value)} onChange={(e) => setText(e.target.value)} onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(e.currentTarget.value); } }} /><span>tokens</span></label>
    </div>
    <div className={css.presets} role="group" aria-label="Quick picks">{[50000, 100000, 300000, 500000, 1000000].map((n) => <button key={n} type="button" aria-pressed={value === n} onClick={() => onChange(n)}>{size(n)}</button>)}</div>
  </Group>;
}

/** CONNECT-AI: which AI it thinks with (a connection from Settings → AI, this server's subscription sign-in, or the test
 *  runtime), its model and where it runs, with what that costs. Nothing connected: "Connect an AI first". */
function AiPick({ d, form, set, choices, denied }: { d: AiDetail; form: Form; set: <K extends keyof Form>(k: K, v: Form[K]) => void; choices: Choices | null; denied: boolean }) {
  const s = d.settings;
  const conn = choices?.connections.find((c) => c.id === form.aiChoice), server = choices?.server.find((x) => x.provider === form.aiChoice);
  const known = conn ? conn.models : form.aiChoice === "stub" ? ["stub"] : PROVIDER_MODELS[form.aiChoice] ?? PROVIDER_MODELS[s.provider] ?? [];
  const models = form.model && !known.includes(form.model) ? [form.model, ...known] : known;
  const modelOptions: Option[] = models.map((m) => ({ value: m, label: modelName(m), detail: m === "stub" ? undefined : m }));
  const word = (st: string, until: string | null) => STATE_WORD[st] ? ` · ${STATE_WORD[st]}${st === "out_of_quota" && until ? ` until ${at(until)}` : ""}` : "";
  const modelField = <Group title="Model"><Select label="Model" value={form.model || null} placeholder="Its runtime’s default" options={modelOptions} onChange={(v) => set("model", v ?? "")} /></Group>;
  if (denied) return <><p className={css.note}>Its AI: <b>{d.ai?.connectionName ?? PROVIDER[s.provider] ?? s.provider}</b>{d.ai?.workspaceName ? ` on ${d.ai.workspaceName}` : ""}. Admins, HR and leadership change which AI it uses.</p>{modelField}</>;
  if (!choices) return <p className={css.note}><LoaderCircle size={14} className={css.spin} aria-hidden="true" />Loading the connected AI…</p>;
  const none = !choices.connections.length && !choices.server.length;
  const options: Option[] = [
    ...choices.server.map((x) => ({ value: x.provider, label: x.name, detail: `${x.account ?? "This server"}${word(x.state, x.until)}`, group: "Signed in on this server" })),
    ...choices.connections.map((c) => ({ value: c.id, label: c.name, detail: `${c.kind === "api" ? `${c.providerName} key ${c.masked ?? ""}` : c.account ?? c.providerName}${word(c.state, c.until)}`, group: "Your connected AI" })),
    { value: "stub", label: "Test runtime", detail: "Canned answers, no AI", group: "For trying things out" }];
  const choose = (v: string | null) => {
    const c = choices.connections.find((x) => x.id === v), list = c ? c.models : v === "stub" ? ["stub"] : PROVIDER_MODELS[v ?? ""] ?? [];
    set("aiChoice", v ?? "");
    if (!list.includes(form.model)) set("model", c?.model ?? list[0] ?? "");
  };
  return <>
    {none ? <div className={css.connectFirst} role="alert"><Plug size={16} aria-hidden="true" /><span><b>Connect an AI first</b><small>Your organisation has no AI connected yet. Sign in with a Claude or ChatGPT subscription, or add an API key; then choose it here.</small></span>
      {choices.canConnect ? <Link className={`${styles.btn} ${styles.btnPrimary}`} href="/settings?tab=ai">Connect an AI</Link> : <small>Ask an admin or leadership (Settings → AI).</small>}</div> : null}
    <Group title="AI it uses">
      <Select label="AI it uses" value={form.aiChoice || null} placeholder={none ? "Nothing connected yet" : "Choose a connected AI"} options={options} onChange={choose} />
    </Group>
    <div className={css.pair}>
      {modelField}
      <Group title="Runs on"><Select label="Runs on" value={conn?.kind === "api" ? "cloud" : form.aiWorkspaceId} disabled={conn?.kind === "api" || form.aiChoice === "stub"}
        options={choices.workspaces.map((w) => ({ value: w.id, label: w.name, detail: w.state !== "ok" ? "Not checked" : undefined }))} onChange={(v) => set("aiWorkspaceId", v ?? "cloud")} /></Group>
    </div>
    <p className={css.cost}>{conn?.kind === "api" ? <><KeyRound size={14} aria-hidden="true" />Billed by {conn.providerName} per token, called from Pulse. This month {fmt(conn.used)} tokens{conn.cap ? ` of its ${fmt(conn.cap)} limit` : " (no monthly limit)"}.</>
      : conn || server ? <><Check size={14} aria-hidden="true" />Runs on the {conn?.name ?? server?.name} subscription: no per-token cost. When the plan runs out, work waits until it resets.</>
      : form.aiChoice === "stub" ? <><MinusCircle size={14} aria-hidden="true" />Test runtime: canned answers for trying things out; nothing is billed and no AI is used.</>
      : <><CircleAlert size={14} aria-hidden="true" />Choose the AI it thinks with.</>}</p>
  </>;
}

// ------------------------------------------------------------------------------------------------------------ activity
/** What it asked first, and who decided: every proposal, with who approved it and how. */
function AiProposals({ detail: d }: { detail: AiDetail }) {
  const rows = d.proposals ?? [];
  const label = { pending: "Waiting", sent: "Sent", dismissed: "Not sent", expired: "Expired" } as const;
  return <ActivityPane id="asked" title="Asked first" sub="What it proposed to post, and who decided.">
    {rows.length ? <ul className={css.list}>{rows.map((p) => <li key={p.id} className={css.item}>
      <em className={css.pill} data-status={p.state === "sent" ? "done" : p.state === "pending" ? "wait" : "muted"}>{label[p.state]}</em>
      <span className={css.itemMain}><span className={css.clamp} title={p.body}>{p.channelName ? <b>{p.channelName}: </b> : null}{p.body}</span>
        <small>{p.decidedBy ? `${p.state === "sent" ? "Approved" : "Declined"} by ${p.decidedBy}${p.via === "reply" ? " (by reply)" : ""}${p.edited ? ", edited" : ""} · ${at(p.decidedAt!)}` : `Asked ${p.approver ?? "its approver"} · ${at(p.at)}`}</small></span></li>)}</ul>
      : <EmptyNote icon={<ShieldQuestion size={18} aria-hidden="true" />} title="Nothing asked yet">When it is set to ask first, what it would post goes to its approver; every decision is listed here.</EmptyNote>}
  </ActivityPane>;
}

function EmptyNote({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return <div className={css.empty}>{icon}<b>{title}</b>{children ? <p>{children}</p> : null}</div>;
}

/** Its groups and the projects it coordinates; leaders add it to a group or make it a project’s (co-)coordinator. */
function AiPlaces({ id, detail: d, lead, people = [] }: { id: string; detail: AiDetail; lead: boolean; people?: Person[] }) {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  // The groups the viewer runs and the projects are read here, after the profile shows (they are long lists); a change
  // shows at once and the profile catches up on its own refresh.
  const [groups, setGroups] = useState<{ id: string; name: string }[] | null>(null), [projects, setProjects] = useState<{ id: string; title: string }[] | null>(null);
  const [mine, setMine] = useState(d.groups), [coord, setCoord] = useState(d.projects ?? []);
  const [pending, setPending] = useState<{ id: string; title: string } | null>(null), [role, setRole] = useState<"co_coordinator" | "coordinator">("co_coordinator");
  // A refreshed profile replaces what was shown at once (state reset on new props, not in an effect).
  const [from, setFrom] = useState(d);
  if (from !== d) { setFrom(d); setMine(d.groups); setCoord(d.projects ?? []); }
  useEffect(() => {
    if (!lead) return; let live = true;
    void fetch("/api/v0/chats", { cache: "no-store" }).then((r) => r.json()).then((x: { channels?: { id: string; name: string; kind: string; myRole?: string | null }[] }) => {
      if (live) setGroups((x.channels ?? []).filter((c) => c.kind === "custom" && c.myRole === "admin").map((c) => ({ id: c.id, name: c.name }))); }).catch(() => { if (live) setGroups([]); });
    void fetch("/api/v0/projects?scope=all", { cache: "no-store" }).then((r) => r.json()).then((x: { projects?: { projectId: string; title: string }[] }) => {
      if (live) setProjects((x.projects ?? []).slice(0, 300).map((p) => ({ id: p.projectId, title: p.title }))); }).catch(() => { if (live) setProjects([]); });
    return () => { live = false; };
  }, [lead]);
  const run = async (f: () => Promise<unknown>, after: () => void, done?: string) => {
    setBusy(true);
    try { await f(); after(); if (done) notify({ id: "ai-places", tone: "success", title: done, timeout: 2400 }); router.refresh(); }
    catch (e) { notify({ id: "ai-places", tone: "error", title: "Not changed", message: (e as Error).message }); } finally { setBusy(false); }
  };
  const inGroups = new Set(mine.map((g) => g.id)), addable = (groups ?? []).filter((g) => !inGroups.has(g.id));
  const onProject = new Set(coord.map((p) => p.id)), pickable = (projects ?? []).filter((p) => !onProject.has(p.id));
  const ROLE: Record<string, string> = { coordinator: "Coordinator", co_coordinator: "Co-coordinator", member: "Member", watcher: "Watcher" };
  const KIND: Record<string, string> = { custom: "Group", pod: "Pod group", team: "Team group" };
  const addGroup = lead && groups !== null && !addable.length ? <small className={css.muted}>{groups.length ? "It is in every group you run" : "You run no group to add it to"}</small> : lead ? <Combobox label="Add it to a group you run" placeholder={groups === null ? "Loading groups…" : "Add to a group"} icon={<Plus size={15} aria-hidden="true" />}
    className={css.pickBtn} size="sm" value={null} disabled={busy || groups === null} searchPlaceholder="Search your groups" emptyText="No group matches"
    options={addable.map((g) => ({ value: g.id, label: g.name }))} onChange={(v) => { const g = addable.find((x) => x.id === v); if (g) void run(() => post(`chats/${g.id}/agents`, { agentId: id, add: true }), () => setMine((x) => [...x, { ...g, kind: "custom" }]), `Added to ${g.name}`); }} /> : null;
  const addProject = lead ? <Combobox label="Make it a coordinator of a project" placeholder={projects === null ? "Loading projects…" : "Coordinate a project"} icon={<Plus size={15} aria-hidden="true" />}
    className={css.pickBtn} size="sm" value={null} disabled={busy || projects === null} searchable searchPlaceholder="Search projects" emptyText="No project matches"
    options={pickable.map((p) => ({ value: p.id, label: p.title }))} onChange={(v) => { const p = pickable.find((x) => x.id === v); if (p) { setPending(p); setRole("co_coordinator"); } }} /> : null;
  return <div className={css.stack} role="tabpanel" id="ai-pane-places" aria-labelledby="ai-tab-places">
    <ActivityPane title="Groups" sub="The conversations it is in, like anyone on the team." tools={addGroup}>
      {mine.length ? <ul className={css.list}>{mine.map((g) => <li key={g.id} className={css.item}>
        <span className={css.itemIcon}><Hash size={15} aria-hidden="true" /></span>
        <span className={css.itemMain}><Link href={`/chats?channel=${g.id}`}><b>{g.name}</b></Link><small>{KIND[g.kind] ?? g.kind}</small></span>
        <GroupApprover id={id} group={g} d={d} lead={lead} people={people} busy={busy} run={run} />
        {lead && g.kind === "custom" ? <button type="button" className={css.iconBtn} aria-label={`Remove from ${g.name}`} title="Remove from this group" disabled={busy}
          onClick={() => void run(() => post(`chats/${g.id}/agents`, { agentId: id, add: false }), () => setMine((x) => x.filter((y) => y.id !== g.id)), `Removed from ${g.name}`)}><Trash2 size={15} aria-hidden="true" /></button> : null}</li>)}</ul>
        : <EmptyNote icon={<Hash size={18} aria-hidden="true" />} title="In no group yet">{lead ? "Add it to a group you run, or set its pod or team in Role & place." : "A leader adds it to groups."}</EmptyNote>}
    </ActivityPane>
    <ActivityPane title="Projects" sub="Projects it coordinates or helps on." tools={addProject}>
      {pending ? <div className={css.confirm} role="group" aria-label="Make it a coordinator">
        <span>Make it the</span>
        <Segmented size="sm" label="Its part" value={role} onChange={setRole} options={[{ value: "co_coordinator", label: "Co-coordinator" }, { value: "coordinator", label: "Coordinator" }]} />
        <span>of <b>{pending.title}</b></span>
        <span className={css.confirmActions}><button type="button" className={`${styles.btn} ${styles.btnGhost} ${styles.btnSmall}`} onClick={() => setPending(null)} disabled={busy}>Cancel</button>
          <button type="button" className={`${styles.btn} ${styles.btnPrimary} ${styles.btnSmall}`} disabled={busy} onClick={() => { const p = pending, r = role; void run(() => post(`projects/${p.id}/coordinators`, { personId: id, role: r }),
            () => { setCoord((x) => [...x.filter((y) => y.id !== p.id), { id: p.id, title: p.title, role: r }]); setPending(null); }, `${ROLE[r]} of ${p.title}`); }}>Confirm</button></span>
      </div> : null}
      {coord.length ? <ul className={css.list}>{coord.map((p) => <li key={p.id} className={css.item}>
        <span className={css.itemIcon}><BriefcaseBusiness size={15} aria-hidden="true" /></span>
        <span className={css.itemMain}><Link href={`/projects/${p.id}`}><b>{p.title}</b></Link><small>{ROLE[p.role] ?? p.role}</small></span>
        {lead && ["coordinator", "co_coordinator"].includes(p.role) ? <button type="button" className={css.iconBtn} aria-label={`Remove as ${ROLE[p.role]} of ${p.title}`} title="Remove from this project" disabled={busy}
          onClick={() => void run(() => post(`projects/${p.id}/coordinators`, { personId: id, role: null }), () => setCoord((x) => x.filter((y) => y.id !== p.id)), `No longer on ${p.title}`)}><Trash2 size={15} aria-hidden="true" /></button> : null}</li>)}</ul>
        : pending ? null : <EmptyNote icon={<BriefcaseBusiness size={18} aria-hidden="true" />} title="Not on a project yet">{lead ? "Use Coordinate a project to give it one." : "A leader makes it a project’s coordinator."}</EmptyNote>}
    </ActivityPane>
  </div>;
}

/** FEATURES-1024 (0987): whom it asks before it posts in this group; by default its approver (or who it reports to). */
function GroupApprover({ id, group, d, lead, people, busy, run }: { id: string; group: { id: string; name: string }; d: AiDetail; lead: boolean; people: Person[];
  busy: boolean; run: (f: () => Promise<unknown>, after: () => void, done?: string) => Promise<void> }) {
  const chosen = d.ai?.groupApprovers?.[group.id] ?? "";
  const usual = d.settings.approverName ?? "its approver";
  if (!lead) return chosen ? <small className={css.asks}>Asks {people.find((p) => p.value === chosen)?.label ?? "someone else"} here</small> : null;
  return <span className={css.asks}><PersonSelect size="sm" variant="ghost" label={`Who it asks in ${group.name}`} people={people.map((p) => ({ id: p.value, name: p.label }))} value={chosen || null}
    noneLabel={`${usual} (usual)`} placeholder={`Asks ${usual}`} onChange={(p) => { if (busy) return; void run(() => post(`agents/${id}/group-approver`, { channelId: group.id, personId: p?.id ?? null }), () => {}, "Approver changed"); }} /></span>;
}

/** What it knows: notes from its manager and from its own runs, newest first; given to every run. */
function AiMemory({ id, detail: d }: { id: string; detail: AiDetail }) {
  const router = useRouter(); const [text, setText] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function add(e: FormEvent) {
    e.preventDefault(); if (!text.trim()) { setError("Write the note first."); return; }
    setBusy(true); setError("");
    try { await post(`agents/${id}/memory`, { body: text.trim() }); setText(""); notify({ id: "ai-memory", tone: "success", title: "Noted", message: "It reads this on every run.", timeout: 2400 }); router.refresh(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  async function remove(mid: string) { setBusy(true); try { await post(`agents/memory/${mid}/retire`, {}); notify({ id: "ai-memory", tone: "success", title: "Note removed", timeout: 2000 }); router.refresh(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } }
  return <ActivityPane id="knowledge" title="Knowledge" sub={`What it knows: ${d.memory.length ? `${d.memory.length} note${d.memory.length === 1 ? "" : "s"}` : "no notes yet"}, given to every run.`}>
    {d.canManage ? <form className={css.teach} onSubmit={(e) => void add(e)}>
      <input value={text} onChange={(e) => { setText(e.target.value); if (error) setError(""); }} maxLength={1000} placeholder="Teach it something: a rule, a client’s taste, where files live" aria-label="A note for it" />
      <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}><Plus size={15} aria-hidden="true" />Add note</button></form> : null}
    {error ? <p role="alert" className={css.error}>{error}</p> : null}
    {d.memory.length ? <ul className={css.list}>{d.memory.map((m) => <li key={m.id} className={css.item} data-source={m.source}>
      <span className={css.itemIcon}>{m.source === "agent" ? <Brain size={15} aria-hidden="true" /> : <BookOpen size={15} aria-hidden="true" />}</span>
      <span className={css.itemMain}><span className={css.wrap}>{m.body}</span>
        <small>{m.source === "agent" ? "Learned on a task" : `From ${m.by}`} · {at(m.at)}{m.taskId ? <> · <Link href={`/tasks/${m.taskId}`}>the task</Link></> : null}</small></span>
      {d.canManage ? <button type="button" className={css.iconBtn} aria-label="Remove this note" title="Remove this note" onClick={() => void remove(m.id)} disabled={busy}><Trash2 size={15} aria-hidden="true" /></button> : null}</li>)}</ul>
      : <EmptyNote icon={<BookOpen size={18} aria-hidden="true" />} title="Nothing yet">Its manager’s notes and what it learns on tasks appear here.</EmptyNote>}
  </ActivityPane>;
}

const PAGE = 10;
/** What it has done: every run (what was asked, grouped by day, failures with their reason and a retry) and its tasks. */
function AiHistory({ id, detail: d }: { id: string; detail: AiDetail }) {
  const router = useRouter();
  const [view, setView] = useState<"runs" | "failed" | "tasks">("runs"), [shown, setShown] = useState(PAGE), [busy, setBusy] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  // 0990: the runs a page at a time with what was asked; the profile's latest 25 show until the first page arrives.
  const [runs, setRuns] = useState(d.runs), [more, setMore] = useState(d.runs.length >= 25), [loading, setLoading] = useState(false);
  const [from, setFrom] = useState(d);
  if (from !== d) { setFrom(d); setRuns((x) => x.length > d.runs.length ? x : d.runs); }
  useEffect(() => {
    let live = true;
    void fetch(`/api/v0/agents/${encodeURIComponent(id)}/runs?limit=25`, { cache: "no-store" }).then(async (r) => { if (!r.ok || !live) return; const x = await r.json() as { runs: AiDetail["runs"]; more: boolean }; if (!live) return; setRuns(x.runs); setMore(x.more); }).catch(() => {});
    return () => { live = false; };
  }, [id, d]);
  async function older() {
    const last = runs.at(-1); if (!last) return;
    setLoading(true);
    try { const r = await fetch(`/api/v0/agents/${encodeURIComponent(id)}/runs?limit=25&before=${encodeURIComponent(last.at)}`, { cache: "no-store" }); if (r.ok) { const x = await r.json() as { runs: AiDetail["runs"]; more: boolean }; setRuns((y) => [...y, ...x.runs.filter((n) => !y.some((o) => o.id === n.id))]); setMore(x.more); } else setMore(false); }
    catch { setMore(false); } finally { setLoading(false); }
  }
  const quota = d.runtime.state === "out_of_quota" && (!d.runtime.until || Date.parse(d.runtime.until) > now);
  const failed = runs.filter((r) => r.state === "error");
  const rows = view === "failed" ? failed : runs;
  const days: { key: string; runs: AiDetail["runs"] }[] = [];
  for (const r of rows.slice(0, shown)) { const k = dayKey(Date.parse(r.at)); const last = days.at(-1); if (last?.key === k) last.runs.push(r); else days.push({ key: k, runs: [r] }); }
  async function retry(runId: string) {
    setBusy(runId);
    try { await post(`agents/${id}/runs/${runId}/retry`, {}); notify({ id: "ai-retry", tone: "success", title: "Asked again", message: "It runs as soon as its AI is free.", timeout: 2600 }); router.refresh(); }
    catch (e) { notify({ id: "ai-retry", tone: "error", title: "Not retried", message: (e as Error).message }); } finally { setBusy(null); }
  }
  const title = (r: AiDetail["runs"][number]) => r.taskTitle ? <Link href={`/tasks/${r.taskId}`}>{r.taskTitle}</Link>
    : r.ask ? <span className={css.ask}>“{r.ask}”</span> : <span className={css.muted}>{r.kind.startsWith("task") ? "A task" : "A question"}{r.channelName ? "" : " in a chat"}</span>;
  return <ActivityPane id="history" title="History" sub="What it was asked and how each run went, newest first."
    tools={<Segmented size="sm" label="Show" value={view} onChange={(v) => { setView(v); setShown(PAGE); }}
      options={[{ value: "runs", label: "Runs", count: runs.length }, { value: "failed", label: "Failed", count: failed.length }, { value: "tasks", label: "Tasks", count: d.tasks.length }]} />}>
    {view === "tasks" ? (d.tasks.length ? <ul className={css.list}>{d.tasks.map((t) => <li key={t.id} className={css.item}>
      <em className={css.pill} data-status={t.status === "done" || t.status === "accepted" ? "done" : t.status === "blocked" ? "bad" : "wait"}>{t.statusLabel}</em>
      <span className={css.itemMain}><Link href={`/tasks/${t.id}`}><b>{t.title}</b></Link><small>Updated {at(t.updatedAt)}</small></span></li>)}</ul>
      : <EmptyNote icon={<ListChecks size={18} aria-hidden="true" />} title="No tasks yet">{d.canGiveTasks ? "Give it one in a chat (@its name … by Friday) or in Tasks." : null}</EmptyNote>)
    : rows.length ? <>
      {days.map((g) => <div key={g.key} className={css.day}>
        <h4>{dayLabel(g.key, now)}</h4>
        <ul className={css.list}>{g.runs.map((r) => {
          const state = r.errorCode === "out_of_quota" ? "wait" : r.state === "done" ? "done" : r.state === "error" ? "bad" : "run";
          const stand = r.fallbackFrom ? `fell back from ${engineName(r.fallbackFrom.split(/[\s,;]+/)[0])}` : standIn(r.model, d.settings.model, quota);
          return <li key={r.id} className={css.run} data-state={state}>
            <span className={css.runIcon} aria-label={state === "done" ? "Done" : state === "bad" ? "Failed" : state === "wait" ? "Out of quota" : r.state === "uncertain" ? "Stuck" : "Running"}>
              {state === "done" ? <CircleCheck size={16} aria-hidden="true" /> : state === "bad" ? <CircleX size={16} aria-hidden="true" /> : state === "wait" ? <Clock3 size={16} aria-hidden="true" /> : <LoaderCircle size={16} aria-hidden="true" />}</span>
            <span className={css.itemMain}>
              <span className={css.runTitle}>{title(r)}{r.channelName ? <span className={css.where}> in {r.channelId ? <Link href={`/chats?channel=${r.channelId}`}>{r.channelName}</Link> : r.channelName}</span> : null}</span>
              <small>{clock(r.at)} · {modelName(r.model || d.settings.model)}{stand ? ` (${stand})` : ""} · {r.tokens === null ? "—" : `${fmt(r.tokens)} tokens`}{r.seconds ? ` · ${r.seconds < 90 ? `${r.seconds} s` : `${Math.round(r.seconds / 60)} min`}` : ""}</small>
              {r.state === "error" ? <span className={css.reason}><CircleAlert size={13} aria-hidden="true" />{reasonOf(r)}</span> : null}
            </span>
            {r.state === "error" && r.retry ? <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy === r.id} onClick={() => void retry(r.id)}><RotateCcw size={14} aria-hidden="true" />{busy === r.id ? "Retrying…" : "Retry"}</button> : null}
          </li>;
        })}</ul>
      </div>)}
      <div className={css.pager}><small>Showing {Math.min(shown, rows.length)} of {rows.length}{more ? "+" : ""}</small>
        {shown < rows.length ? <button type="button" className={`${styles.btn} ${styles.btnGhost} ${styles.btnSmall}`} onClick={() => setShown((n) => n + PAGE)}>Show {Math.min(PAGE, rows.length - shown)} more</button>
          : more ? <button type="button" className={`${styles.btn} ${styles.btnGhost} ${styles.btnSmall}`} disabled={loading} onClick={() => void older().then(() => setShown((n) => n + PAGE))}>{loading ? "Loading…" : "Load older runs"}</button> : null}</div>
    </> : <EmptyNote icon={<HistoryIcon size={18} aria-hidden="true" />} title={view === "failed" ? "No failed runs" : "No runs yet"}>{view === "failed" ? "Every recent run finished." : "Runs appear here when it is asked something or given a task."}</EmptyNote>}
  </ActivityPane>;
}
