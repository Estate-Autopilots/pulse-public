"use client";
// EST-1542: match WhatsApp sender names, most-used first. One tap per name: a suggested colleague, another colleague,
// "Not staff" or "Skip". Each answer saves at once (one save at a time, in order); the newest answer wins.
import { useRef, useState } from "react";
import { notify } from "@pulse/ui-shell";
import { PersonSelect, Segmented } from "../../kit";
import { post } from "../../records";
import { Badge, Empty, Page, PageHeader, Panel, styles } from "../../ui";
import { CheckCircle2 } from "lucide-react";
import { reconcileRows } from "../../lib/chat-names.mjs";
import { Loader } from "./loader";
import css from "./names.module.css";

type Person = { id: string; name: string };
type Row = { id: string; label: string; messages: number; groups: number; suggestions: Person[]; decision: "colleague" | "not_staff" | "skip" | null;
  person: Person | null; decidedBy: string | null; decidedAt: string | null };
export type NamesData = { source: string; importantGroups: number; rows: Row[]; people: Person[];
  progress: { total: number; done: number; important: number; importantDone: number; messages: number; messagesDone: number };
  /** EST-1542 B (0680): this person may load names from their own WhatsApp exports. */
  canLoad?: boolean };
type View = "todo" | "done" | "all";
const ANSWER = { not_staff: "Not staff", skip: "Skipped" } as const;

function Bar({ label, done, total }: { label: string; done: number; total: number }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return <div className={css.bar}><div className={css.barHead}><span>{label}</span><b>{done} of {total} done</b></div>
    <div className={css.track} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}><i style={{ width: `${pct}%` }} /></div></div>;
}

export function Matcher({ initial }: { initial: NamesData }) {
  const [rows, setRows] = useState(initial.rows), [view, setView] = useState<View>("todo"), [picking, setPicking] = useState<string | null>(null);
  // EST-1913: answers still being saved, by row; a reload (after a load or a refresh) takes the server's rows and keeps these.
  const [saving, setSaving] = useState<Record<string, number>>({}), [seen, setSeen] = useState(initial);
  if (seen !== initial) { setSeen(initial); setRows(reconcileRows(initial.rows, rows, new Set(Object.keys(saving)))); }
  const queue = useRef(Promise.resolve());
  const track = (id: string, step: 1 | -1) => setSaving((s) => { const n = (s[id] ?? 0) + step; const next = { ...s }; if (n > 0) next[id] = n; else delete next[id]; return next; });
  const important = (r: Row) => r.groups >= initial.importantGroups;
  const counts = { done: rows.filter((r) => r.decision).length, important: rows.filter(important).length,
    importantDone: rows.filter((r) => important(r) && r.decision).length };
  const shown = rows.filter((r) => view === "all" || (view === "done" ? !!r.decision : !r.decision));
  function answer(row: Row, decision: Row["decision"], person: Person | null = null) {
    const before = row; setPicking(null);
    setRows((rs) => rs.map((r) => r.id === row.id ? { ...r, decision, person, decidedBy: "you" } : r));
    track(row.id, 1);
    queue.current = queue.current.then(async () => {
      try { await post(`chat-names/${row.id}`, { decision, personId: person?.id ?? null }); }
      catch (e) { setRows((rs) => rs.map((r) => r.id === row.id ? before : r)); notify({ id: "names", tone: "error", title: `${row.label}: not saved`, message: e instanceof Error ? e.message : "Try again" }); }
      finally { track(row.id, -1); }
    });
  }
  return (
    <Page>
      <PageHeader title="WhatsApp names" back={{ href: "/review-data", label: "Review data" }} context={["Private · leadership and HR"]} />
      <div className={css.stack}>
        {initial.canLoad ? <Loader source={initial.source} empty={!rows.length} /> : null}
        <Panel title="Who is who" sub="Decide once per name, before the group history comes into Pulse">
          <div className={css.bars}>
            <Bar label={`Most important (in ${initial.importantGroups}+ groups)`} done={counts.importantDone} total={counts.important} />
            <Bar label="All names" done={counts.done} total={rows.length} />
          </div>
          <p className={css.note}>A colleague&apos;s messages appear under their Pulse name and they join the group. Anyone else keeps the WhatsApp name as written. Phone numbers are never stored.</p>
        </Panel>
        <Panel title="Names" sub={`${shown.length} shown · most messages first`} tools={<Segmented label="Show" size="sm" value={view} onChange={setView}
          options={[{ value: "todo", label: "To do", count: rows.length - counts.done }, { value: "done", label: "Done", count: counts.done }, { value: "all", label: "All" }]} />}>
          {shown.length ? <ul className={css.rows}>{shown.map((r) => <li key={r.id} className={css.row} data-done={r.decision ? "" : undefined}>
            <div className={css.name}><b>{r.label}</b><small>{r.messages.toLocaleString("en-IN")} messages · {r.groups} group{r.groups === 1 ? "" : "s"}{important(r) ? " · important" : ""}</small></div>
            {r.decision ? <div className={css.answer}>
              <CheckCircle2 size={16} aria-hidden="true" /><span>{r.decision === "colleague" ? `Colleague: ${r.person?.name ?? ""}` : ANSWER[r.decision]}{r.decidedBy ? <small> · by {r.decidedBy}</small> : null}</span>
              <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => answer(r, null)}>Change</button>
            </div> : <div className={css.actions}>
              {r.suggestions.map((p) => <button key={p.id} type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => answer(r, "colleague", p)} title="Colleague">{p.name}</button>)}
              {picking === r.id ? <PersonSelect label={`${r.label}: which colleague`} size="sm" autoOpen people={initial.people} value={null} onChange={(p) => p ? answer(r, "colleague", p) : setPicking(null)} />
                : <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => setPicking(r.id)}>{r.suggestions.length ? "Another colleague…" : "Colleague…"}</button>}
              <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => answer(r, "not_staff")}>Not staff</button>
              <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => answer(r, "skip")}>Skip</button>
            </div>}
          </li>)}</ul> : !rows.length ? <Empty icon={CheckCircle2} title="No names loaded yet" text={initial.canLoad ? "Load them from the WhatsApp exports above." : "Leadership or HR loads them from the WhatsApp exports."} />
            : <Empty icon={CheckCircle2} title={view === "todo" ? "Every name is decided" : "Nothing here yet"} text={view === "todo" ? "Thank you. The import can go ahead once it is approved." : "Answers appear here as you go."} />}
          {counts.importantDone === counts.important && counts.important > 0 && view === "todo" && shown.length ? <p className={css.note}><Badge tone="success">The {counts.important} most important names are done</Badge> The rest can wait.</p> : null}
        </Panel>
      </div>
    </Page>
  );
}
