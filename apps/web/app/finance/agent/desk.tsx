"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, BookOpen, CheckCircle2, FileQuestion, Files, Hourglass, Sparkles, Upload, Wand2 } from "lucide-react";
import { ActionButton, Chip, EmptyState, GameCard, ListRow, ListRows, ProgressRing, SegmentedTabLinks, StatTile, StatTiles, celebrate, toast } from "../../kit/game";
import { confirmDialog } from "../../kit/dialogs";
import css from "./desk.module.css";

type Flag = "suspicious" | "unclear_category" | "missing_document" | "possible_duplicate";
export type Job = { id: string; kind: string; title: string; status: string; progress: number; line: string | null; rowsIn: number; rowsOut: number; seconds: number; tokens: number; modelCalls: number;
  skillsUsed: Record<string, number>; error: string | null; createdAt: string; agent: string; askedBy: string | null; files: number;
  read?: { bank: string | null; account: string | null; from: string | null; to: string | null; ok: boolean }[]; toCheck?: number };
export type Skill = { id: string; name: string; title: string; kind: string; status: string; version: number; publishedVersion: number | null; uses: number; linesHandled: number; modelCallsSaved: number;
  lastUsedAt: string | null; learnedBy: string | null; testResult: { passed?: number; failed?: number; why?: string } | null; why: string | null; tests: number;
  bank?: string | null; columns?: string[] | null };
export type Overview = { canWrite: boolean; canPublish: boolean; agents: { id: string; name: string; username: string | null; title: string | null }[];
  counts: Record<Flag | "open" | "confirmed" | "set_aside", number>; jobs: Job[]; skills: Skill[]; week: { jobs: number; lines: number; tokens: number; modelCalls: number; seconds: number } };
export type Group = { who: string; direction: "in" | "out"; lines: number; amountMinor: number; category: string | null; from: string; to: string; flags: Flag[] };
export type Item = { id: string; date: string; amountMinor: number; direction: "in" | "out"; narration: string | null; counterparty: string | null; category: string | null; flags: Flag[]; reasons: string[]; bank: string | null; account: string | null };
export type Review = { status: string; total: number; offset: number; groups: Group[]; items: Item[] };

const FLAG: Record<Flag, { label: string; short: string; tone: "warn" | "bad" | "accent" }> = {
  unclear_category: { label: "Not sure what it is", short: "Unclear", tone: "warn" },
  missing_document: { label: "Needs a bill or invoice", short: "No bill", tone: "accent" },
  suspicious: { label: "Looks odd", short: "Odd", tone: "bad" },
  possible_duplicate: { label: "Maybe paid twice", short: "Repeats", tone: "warn" },
};
const CATEGORIES = ["Ad spend", "Software & tools", "Rent & office", "Salaries", "Freelancers", "Travel", "Food & office supplies", "Utilities", "Professional fees", "Equipment", "Taxes & GST", "Bank charges", "Client payment", "Other income", "Refund", "Owner money", "Other"];
const rs = (minor: number) => `₹${Math.round(minor / 100).toLocaleString("en-IN")}`;
const short = (minor: number) => { const r = minor / 100; return r >= 1e7 ? `₹${(r / 1e7).toFixed(1)} Cr` : r >= 1e5 ? `₹${(r / 1e5).toFixed(1)} L` : rs(minor); };
const day = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
const took = (s: number) => s < 60 ? `${Math.max(1, Math.round(s))} s` : `${Math.round(s / 60)} min`;
async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`/api/v0/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error ?? "That did not work"); return d as T;
}

export function AgentDesk({ o, review, view, flag, words }: { o: Overview; review: Review | null; view: string; flag: string; words: string }) {
  const router = useRouter();
  const running = o.jobs.some((j) => j.status === "running" || j.status === "queued" || j.status === "uploading");
  // While a job runs, the page follows it (its progress line, then its result) without a reload.
  useEffect(() => { if (!running) return; const t = setInterval(() => router.refresh(), 3000); return () => clearInterval(t); }, [running, router]);
  const flagged = (Object.keys(FLAG) as Flag[]).reduce((n, f) => n + (o.counts[f] ?? 0), 0);
  const learned = o.skills.filter((s) => s.status === "published");
  const sorted = o.skills.reduce((n, s) => n + (s.status === "published" ? s.linesHandled : 0), 0);
  const tab = (key: string, label: string, count?: number) => ({ key, label, href: `/finance/agent${key === "check" ? "" : `?view=${key}`}`, current: view === key, count: count ? count.toLocaleString("en-IN") : undefined });
  return <div className={css.desk}>
    {view === "check" ? <div className={css.tiles}><StatTiles label="The AI analyst at a glance" pair>
      <StatTile label="Waiting for you" value={o.counts.open ?? 0} unit=" lines" icon={FileQuestion} tone={(o.counts.open ?? 0) ? undefined : "good"} href="/finance/agent" />
      <StatTile label="Settled" value={(o.counts.confirmed ?? 0) + (o.counts.set_aside ?? 0)} unit=" lines" icon={CheckCircle2} />
      <StatTile label="Skills in use" value={learned.length} icon={Sparkles} href="/finance/agent?view=skills" />
      <StatTile label="Read on its own" value={sorted} unit=" lines" icon={Wand2} tone={sorted ? "good" : undefined} />
    </StatTiles></div> : null}
    <SegmentedTabLinks label="AI analyst views" items={[tab("check", "To check", o.counts.open), tab("jobs", "Jobs"), tab("skills", "Skills"), tab("send", "Send files")]} />
    {view === "check" ? <Check o={o} review={review} flag={flag} words={words} flagged={flagged} />
      : view === "jobs" ? <Jobs o={o} />
      : view === "skills" ? <Skills o={o} />
      : <Send o={o} />}
  </div>;
}

/** Who does the reading, in the page header (concept 1): its name and what it read this week. */
export function AgentBadge({ o }: { o: Overview }) {
  const a = o.agents[0]; if (!a) return null;
  return <span className={css.badge}><Sparkles size={18} aria-hidden="true" /><span><b>{a.name}</b><small>{o.week.lines ? `${o.week.lines.toLocaleString("en-IN")} lines read this week` : "Ready to read statements"}</small></span></span>;
}

function Check({ o, review, flag, words, flagged }: { o: Overview; review: Review | null; flag: string; words: string; flagged: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<{ key: string; text: string } | null>(null);
  if (!review) return null;
  if (!o.counts.open && !o.counts.confirmed && !o.jobs.length) return <EmptyState art="connect" title="Nothing to check yet"
    text="Send your bank statements (CSV, Excel or PDF) and the AI analyst reads them, then asks you only about what it is unsure of."
    action={{ label: "Send statements", href: "/finance/agent?view=send", icon: Upload }} />;
  const chips: { key: string; label: string; count?: number }[] = [{ key: "", label: "All" }, ...(Object.keys(FLAG) as Flag[]).filter((f) => o.counts[f] || flag === f).map((f) => ({ key: f, label: FLAG[f].short, count: o.counts[f] }))];
  const decide = async (g: Group, decision: "confirm" | "set_aside", btn?: Element | null) => {
    const k = `${g.who}|${g.direction}`;
    const n = g.lines.toLocaleString("en-IN");
    if (decision === "confirm" && g.lines > 20 && !(await confirmDialog({ title: `Confirm all ${n} lines?`, body: `${g.direction === "in" ? "From" : "To"} ${g.who}, ${short(g.amountMinor)} in all. They go into Finance as ${pick[k] || g.category || "they are"}.`, confirmLabel: "Confirm all" }))) return;
    setBusy(k);
    try {
      // Pulse takes 2,000 lines a time: a bigger group goes in rounds until it is all done.
      let done = 0;
      for (let round = 0; round < 500; round++) {
        const r = await post<{ changed: number }>("finance/agent/review", { who: g.who, direction: g.direction, decision, category: decision === "confirm" ? pick[k] || g.category || undefined : undefined, flag: flag && flag !== "clear" ? flag : undefined });
        done += r.changed;
        if (r.changed < 2000) break;
        setProgress({ key: k, text: `Saving ${done.toLocaleString("en-IN")} of ${n}…` });
      }
      if (decision === "confirm") { celebrate(btn ?? null); toast(`${done.toLocaleString("en-IN")} lines saved in Finance`); } else toast(`${done.toLocaleString("en-IN")} lines set aside`);
      router.refresh();
    } catch (e) { toast(e instanceof Error ? e.message : "That did not work", { tone: "bad" }); } finally { setBusy(null); setProgress(null); }
  };
  const firstUnset = review.groups.findIndex((g) => g.flags.includes("unclear_category") && !g.category);
  return <>
    <nav className={css.flagRow} aria-label="Show lines">
      {chips.map((c) => <a key={c.key || "all"} className={css.flagChip} aria-current={flag === c.key ? "page" : undefined} href={`/finance/agent${c.key ? `?flag=${c.key}` : ""}`}>{c.label}{c.count ? <b>{c.count.toLocaleString("en-IN")}</b> : null}</a>)}
    </nav>
    {review.groups.length === 0 ? <EmptyState art="done" title={flag ? "Nothing like that waiting" : "All checked"} text={flagged ? "Pick another filter to see the rest." : "Every line the AI analyst read is settled. Send more statements when you have them."}
      action={{ label: "Send statements", href: "/finance/agent?view=send", icon: Upload }} /> : <>
      <Settled done={(o.counts.confirmed ?? 0) + (o.counts.set_aside ?? 0)} open={o.counts.open ?? 0} />
      <p className={flag ? css.why1 : css.hint}>{flag && flag in WHY ? <><b>{WHY[flag as Flag].title}.</b> {WHY[flag as Flag].short}</> : <>{review.total.toLocaleString("en-IN")} lines{words ? ` matching “${words}”` : ""}, grouped by who was paid or who paid.</>}</p>
      <ul className={css.groups} aria-label="Groups to check">
        {review.groups.map((g, gi) => { const k = `${g.who}|${g.direction}`; const unclear = g.flags.includes("unclear_category"); return <li key={k} className={css.group} data-dir={g.direction}>
          <div className={css.groupHead}>
            <span className={css.who}><b>{g.who}</b>
              <span className={css.meta}><span className={css.dir} data-dir={g.direction}>{g.direction === "in" ? <ArrowDownLeft size={14} aria-hidden="true" /> : <ArrowUpRight size={14} aria-hidden="true" />}{g.direction === "in" ? "Money in" : "Money out"}</span>
                <span>{g.lines.toLocaleString("en-IN")} {g.lines === 1 ? "line" : "lines"}</span><span>{day(g.from)}{g.to !== g.from ? ` – ${day(g.to)}` : ""}</span></span></span>
            <span className={css.amount}>{short(g.amountMinor)}</span>
          </div>
          <div className={css.groupFoot}>
            <span className={css.flags}>{g.flags.slice(0, 2).map((f) => <Chip key={f} tone={FLAG[f].tone}>{FLAG[f].label}</Chip>)}{!g.flags.length ? <Chip tone="good">Looks fine</Chip> : null}
              {g.flags[0] && !flag ? <small className={css.reason}>{WHY[g.flags[0]].text}</small> : null}</span>
            {o.canWrite ? <span className={css.acts}>
              <label className={css.cat}><span className={css.sr}>Category</span>
                <select value={pick[k] ?? g.category ?? ""} onChange={(e) => setPick({ ...pick, [k]: e.target.value })} data-unset={unclear && !pick[k] ? "" : undefined} data-lead={unclear && !pick[k] && !g.category && gi === firstUnset ? "" : undefined}>
                  {!g.category ? <option value="">Pick a type</option> : null}
                  {[...new Set([...(g.category ? [g.category] : []), ...CATEGORIES])].map((c) => <option key={c}>{c}</option>)}
                </select></label>
              <button type="button" className={css.quiet} disabled={busy === k} onClick={() => decide(g, "set_aside")}>Not company money</button>
              {<button type="button" className={gi === 0 && firstUnset !== 0 ? css.primary : css.secondary} disabled={busy === k || (unclear && !(pick[k] || g.category))} onClick={(e) => decide(g, "confirm", e.currentTarget)}><CheckCircle2 size={16} aria-hidden="true" />{busy === k ? (progress?.key === k ? progress.text : "Saving…") : "Confirm"}</button>}
            </span> : null}
          </div>
        </li>; })}
      </ul>
      <Why groups={review.groups} />
    </>}
  </>;
}

/** How much of what it read is settled: a bar that fills as groups are confirmed or set aside. */
function Settled({ done, open }: { done: number; open: number }) {
  const total = done + open; if (!total) return null;
  const pct = Math.round((done / total) * 100), shown = done && !pct ? "<1%" : `${pct}%`;
  return <div className={css.settled} role="group" aria-label="Lines settled">
    <span><b>{done.toLocaleString("en-IN")}</b> of {total.toLocaleString("en-IN")} lines settled</span>
    <span className={css.bar} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`${pct}% settled`}><i style={{ width: `${Math.max(pct, 2)}%` }} /></span>
    <span className={css.pct}>{shown}</span>
  </div>;
}

const WHY: Record<Flag, { title: string; text: string; short: string }> = {
  unclear_category: { title: "It can't tell what these are", text: "No rule or past choice says what these payments are. Pick once and it learns.", short: "Pick what each one is, once, and it learns." },
  missing_document: { title: "No bill or invoice found", text: "Money moved, but no matching bill or invoice is in Pulse yet.", short: "Add the bill or invoice, or confirm it as it is." },
  suspicious: { title: "Something looks odd", text: "A big cash withdrawal, or a round amount to someone new.", short: "Check these are real company payments." },
  possible_duplicate: { title: "It may be paid twice", text: "The same amount to the same party within three days.", short: "Check none of these were paid twice." },
};
/** Why it asks, in at most three plain reasons (the ones on the groups shown). */
function Why({ groups }: { groups: Group[] }) {
  const flags = (Object.keys(WHY) as Flag[]).filter((f) => groups.some((g) => g.flags.includes(f))).slice(0, 3);
  if (!flags.length) return null;
  return <section className={css.why} aria-label="Why it asks">
    <h3>Why it asks</h3>
    <ol>{flags.map((f) => <li key={f}><b>{WHY[f].title}</b><span>{WHY[f].text}</span></li>)}</ol>
  </section>;
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const span = (from: string | null, to: string | null) => { if (!from || !to) return ""; const a = MON[Number(from.slice(5, 7)) - 1], b = MON[Number(to.slice(5, 7)) - 1], y = to.slice(0, 4);
  return a === b && from.slice(0, 4) === y ? `${a} ${y}` : `${a}–${b} ${y}`; };
/** "HDFC ··1234 · Apr–Jun 2026" (and "+ 2 more"), else the job's own title. */
function jobTitle(j: Job) {
  const read = (j.read ?? []).filter((r) => r.ok);
  if (!read.length) return j.status === "done" ? j.title.replace(/^Reading\b/, "Read") : `Reading ${j.files} ${j.files === 1 ? "statement" : "statements"}`;
  const r = read[0], end = r.account?.match(/(\d{4})$/)?.[1];
  return `${r.bank ?? "Bank"} account${end ? ` ending ${end}` : ""}`;
}

/** The months it read (and how many more statements), else when it started. */
function jobWhen(j: Job) {
  const read = (j.read ?? []).filter((r) => r.ok);
  const at = new Date(j.createdAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
  if (!read.length) return `Sent ${at}`;
  return `${span(read[0].from, read[0].to)}${read.length > 1 ? ` · ${read.length} files` : ""}`;
}

function Jobs({ o }: { o: Overview }) {
  if (!o.jobs.length) return <EmptyState art="nothing" title="No jobs yet" text="A job starts when you send statements here or in a chat with the AI analyst." action={{ label: "Send statements", href: "/finance/agent?view=send", icon: Upload }} />;
  const lines = o.jobs.reduce((n, j) => n + j.rowsIn, 0), check = o.jobs.reduce((n, j) => n + (j.toCheck ?? 0), 0);
  return <><JobsFoot /><p className={css.last}>{lines.toLocaleString("en-IN")} lines read in {o.jobs.length} {o.jobs.length === 1 ? "job" : "jobs"}{check ? `; ${check.toLocaleString("en-IN")} still to check` : "; all checked"}.</p><ListRows label="Jobs">{o.jobs.map((j) => {
    const live = j.status === "running" || j.status === "queued" || j.status === "uploading";
    const used = Object.keys(j.skillsUsed ?? {}).length;
    return <ListRow key={j.id} stripe={j.status === "failed" ? "var(--theme-danger, #c0392b)" : "var(--theme-action)"}
      lead={j.status === "running" ? <ProgressRing value={(j.progress || 2) / 100} size={52} stroke={6} label={`${j.progress}% done`}><span className={css.ringText}>{j.progress}%</span></ProgressRing> : live ? <Hourglass size={22} aria-label="Waiting to start" /> : j.status === "done" ? <CheckCircle2 size={22} color="var(--theme-success, #2e7d32)" /> : <AlertTriangle size={22} />}
      title={jobTitle(j)}
      end={<small className={css.jobEnd}>{new Date(j.createdAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })}</small>}
      sub={<>{j.status === "done" ? "Done" : j.status === "failed" ? "Stopped" : live && j.status !== "running" ? "Waiting" : "Reading"} · {jobWhen(j)}<br />{j.status === "running" ? (j.line ?? "Reading now…") : live ? "Waiting to start" : j.status === "failed" ? (j.error ?? "It stopped") : <>{j.rowsOut ? `${j.rowsOut.toLocaleString("en-IN")} new lines` : "Nothing new"}{j.modelCalls ? ` · ${j.modelCalls} AI calls` : ""}{j.toCheck ? <span className={css.pill}>{j.toCheck.toLocaleString("en-IN")} to check</span> : null}</>}</>}
      href={j.status === "done" ? `/finance/agent?job=${j.id}` : undefined} />;
  })}</ListRows></>;
}
function JobsFoot() { return <a className={css.primaryLink} href="/finance/agent?view=send"><Upload size={16} aria-hidden="true" />Send more statements</a>; }

function Skills({ o }: { o: Overview }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  if (!o.skills.length) return <EmptyState art="nothing" title="No skills yet" text="Each time the AI analyst works out a new bank layout or learns from what you confirm, it offers it here as a skill. Once you publish it, the next file needs no guessing." />;
  const act = async (s: Skill, publish: boolean, btn: Element) => {
    setBusy(s.id);
    try { await post(`finance/agent/skills/${s.id}`, { publish }); if (publish) { celebrate(btn); toast(`“${s.title}” is in use from the next file`); } else toast("Retired"); router.refresh(); }
    catch (e) { toast(e instanceof Error ? e.message : "That did not work", { tone: "bad" }); } finally { setBusy(null); }
  };
  const ready = (s: Skill) => (s.status === "proposed" || (s.publishedVersion ?? 0) < s.version) && (s.testResult?.passed ?? 0) > 0 && (s.testResult?.failed ?? 1) === 0;
  const rank = (s: Skill) => s.status === "retired" ? 3 : ready(s) ? 0 : s.status === "published" ? 1 : 2;
  const list = [...o.skills].sort((a, b) => rank(a) - rank(b));
  const waiting = o.skills.filter(ready);
  const publishAll = async (btn: Element) => {
    setBusy("all");
    try { for (const s of waiting) await post(`finance/agent/skills/${s.id}`, { publish: true }); celebrate(btn); toast(`${waiting.length} skills in use from the next file`); router.refresh(); }
    catch (e) { toast(e instanceof Error ? e.message : "That did not work", { tone: "bad" }); } finally { setBusy(null); }
  };
  return <><div className={css.skillTop}><p className={css.hint}>What it learned. Once in use, it reads files like these on its own, free and instant.</p>
    {o.canPublish && waiting.length ? <button type="button" className={css.primary} disabled={busy === "all"} onClick={(e) => publishAll(e.currentTarget)}>{busy === "all" ? "Saving…" : `Use all ${waiting.length} from now on`}</button> : null}</div>
  <ul className={css.skills} aria-label="Skills">{list.map((s) => {
    const passed = (s.testResult?.passed ?? 0) > 0 && (s.testResult?.failed ?? 1) === 0;
    return <li key={s.id} className={css.skill} data-status={s.status}>
      <div className={css.skillHead}><BookOpen size={18} aria-hidden="true" /><b>{s.kind === "parser" ? (s.bank ? `Read ${s.bank} statements` : "Read a new statement layout") : s.title}</b>
        {s.status === "published" ? <Chip tone="good">In use</Chip> : s.status === "retired" ? <Chip>Not used</Chip> : passed ? null : <Chip tone="bad">Check failed</Chip>}</div>
      <p className={css.skillWhy}>{s.kind === "parser" ? (s.bank ? `The next ${s.bank} statement is read straight away, with no guessing.` : `For statements with the columns ${(s.columns ?? []).slice(0, 4).map((c) => c.replace(/\b\w/g, (m) => m.toUpperCase())).join(", ")}.`) : s.kind === "categoriser" ? "Sorts lines the way you confirmed them before, so it asks you less." : s.why}</p>
      <p className={css.skillMeta}>{passed ? "✓ Passed its test" : s.testResult ? "✗ Its check did not pass. It tries again with the next statement like this" : "Not checked yet"} {` · ${s.uses ? `Used ${s.uses.toLocaleString("en-IN")} ${s.uses === 1 ? "time" : "times"}` : "Not used yet"}`}{s.modelCallsSaved ? ` · saved ${s.modelCallsSaved} AI ${s.modelCallsSaved === 1 ? "call" : "calls"}` : ""}</p>
      {o.canPublish && s.status !== "retired" ? <div className={css.skillActs}>
        {(s.status === "proposed" || (s.publishedVersion ?? 0) < s.version) && passed ? <button type="button" className={css.link} disabled={busy === s.id} onClick={(e) => act(s, true, e.currentTarget)}>{busy === s.id ? "Saving…" : "Use it from now on"}</button> : null}
        <button type="button" className={css.quiet} disabled={busy === s.id} onClick={(e) => act(s, false, e.currentTarget)}>{s.status === "published" ? "Stop using" : "Don't use"}</button>
      </div> : null}
    </li>;
  })}</ul></>;
}

function Send({ o }: { o: Overview }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [agentId, setAgentId] = useState(o.agents[0]?.id ?? "");
  const [sent, setSent] = useState<{ done: number; total: number } | null>(null);
  const PART = 1024 * 1024 * 3;
  if (!o.agents.length) return <EmptyState art="connect" title="No Finance AI employee yet" text="Switch on Finance & billing for an AI employee in People → AI, and it can read statements here." action={{ label: "Open People → AI", href: "/people?tab=ai" }} />;
  if (!o.canWrite) return <EmptyState art="nothing" title="Only leadership and the Finance role send files" text="You can see what the AI analyst found." />;
  const start = async () => {
    const meta = files.map((f) => ({ name: f.name, mime: f.type || "application/octet-stream", size: f.size, parts: Math.max(1, Math.ceil(f.size / PART)) }));
    const total = meta.reduce((n, m) => n + m.parts, 0);
    setSent({ done: 0, total });
    try {
      const { id } = await post<{ id: string }>("finance/agent/jobs", { agentId, title: files.length === 1 ? `Reading ${files[0].name}` : `Reading ${files.length} files`, files: meta });
      let done = 0;
      for (const [fi, f] of files.entries()) for (let p = 0; p < meta[fi].parts; p++) {
        const buf = new Uint8Array(await f.slice(p * PART, (p + 1) * PART).arrayBuffer());
        let bin = ""; for (let i = 0; i < buf.length; i += 32768) bin += String.fromCharCode(...buf.subarray(i, i + 32768));
        await post(`finance/agent/jobs/${id}/parts`, { file: fi, part: p, bytes: btoa(bin) });
        setSent({ done: ++done, total });
      }
      toast("Sent. The AI analyst is reading them now.");
      router.push("/finance/agent?view=jobs");
    } catch (e) { toast(e instanceof Error ? e.message : "That did not work", { tone: "bad" }); setSent(null); }
  };
  const busy = sent !== null;
  const drop = (list: FileList | null) => { if (list?.length) setFiles([...list].slice(0, 20)); };
  return <GameCard title="Send statements" icon={Upload} label="Send statements">
    <ol className={css.steps}>
      <li>Download each account&apos;s statement from net banking. Repeats are fine.</li>
      <li>Choose the files here.</li>
      <li>It reads them and asks you only what it is unsure of.</li>
    </ol>
    <div className={css.sendBody}>
    <div className={css.drop} onClick={(e) => { if (!(e.target as HTMLElement).closest("button")) input.current?.click(); }} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); drop(e.dataTransfer.files); }}>
      <Upload size={28} aria-hidden="true" />
      <b>{files.length ? `${files.length} ${files.length === 1 ? "file" : "files"} ready` : "Choose your statement files"}</b>
      <span>{files.length ? files.map((f) => f.name).join(", ") : "Tap or drag files here · CSV, Excel or PDF · up to 20"}</span>
      <button type="button" className={files.length ? css.ghost : css.primary} onClick={() => input.current?.click()} disabled={busy}><Files size={16} aria-hidden="true" />{files.length ? "Choose other files" : "Choose files"}</button>
    </div>
    </div>
    {o.jobs[0] ? <p className={css.last}>Last sent: {jobTitle(o.jobs[0])}, {new Date(o.jobs[0].createdAt).toLocaleString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" })}. <a href="/finance/agent?view=jobs">See jobs</a></p> : null}
    {o.agents.length > 1 ? <label className={css.field}>Who reads them<select value={agentId} onChange={(e) => setAgentId(e.target.value)}>{o.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label> : null}
    <input ref={input} className={css.sr} type="file" multiple accept=".csv,.xlsx,.xls,.pdf,text/csv,application/pdf" onChange={(e) => drop(e.target.files)} />
    {busy ? <p className={css.hint} role="status">Sending… {Math.round((sent.done / Math.max(1, sent.total)) * 100)}%</p> : null}
    {files.length ? <ActionButton primary action={{ label: busy ? "Sending…" : `Read ${files.length} ${files.length === 1 ? "file" : "files"}`, onClick: start, disabled: busy, busy, icon: Upload }} /> : null}
    <p className={css.last}>Or send them to {o.agents[0].name} in <a href="/chats">Chats</a>.</p>
  </GameCard>;
}
