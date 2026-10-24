"use client";
// WORKFLOW BUILDER, test mode: run a tab as it is saved now, on a copy of a real project's values (the project itself is
// only read), as the people each block would go to. Nothing is sent and no task is made. The trail follows the work
// through Hand-offs into the next tabs; choose whose seat to sit in and move their blocks on.
import { useEffect, useMemo, useState } from "react";
import { CircleCheck, CircleDashed, CircleDot, CircleSlash, FlaskConical, Play, Square } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { ProjectPicker, useWorkOptions } from "../create";
import { PersonSelect, type PickPerson } from "../kit";
import { post } from "../records";
import { time } from "../lib/format";
import { Avatar, styles } from "../ui";
import { WaitingList } from "./waiting";
import type { BoardDetail, Tab, TestRun, WaitingItem } from "./board-types";
import css from "./blocks.module.css";

const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
const ICON = { done: CircleCheck, active: CircleDot, waiting: CircleDashed, skipped: CircleSlash, cancelled: CircleSlash } as const;

export function TestPanel({ data, tab, dirty, runs, shown, onShow, onChanged }: { data: BoardDetail; tab: Tab; dirty: boolean; runs: TestRun[]; shown: string | null;
  onShow: (id: string | null) => void; onChanged: () => void }) {
  const { data: options } = useWorkOptions();
  const people = useMemo(() => (options?.people ?? []).map((p) => ({ id: p.id, name: p.name, photoAt: p.photoAt ?? null, pod: p.pod ?? null, role: p.role ?? null })) as PickPerson[], [options]);
  const [project, setProject] = useState<string | null>(null), [as, setAs] = useState<string | null>(tab.tabPersonId);
  const [trail, setTrail] = useState<TestRun[]>([]), [items, setItems] = useState<WaitingItem[]>([]), [seat, setSeat] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!shown) return;
    let live = true;
    Promise.all([fetch(`/api/v0/workflows/test-runs/${shown}`).then((r) => r.ok ? r.json() : { runs: [] }),
      fetch(`/api/v0/workflows/waiting?mode=test&run=${shown}${seat ? `&as=${seat}` : ""}`).then((r) => r.ok ? r.json() : { items: [] })])
      .then(([t, w]) => { if (!live) return; const ids = new Set((t.runs as TestRun[]).map((r) => r.id)); setTrail(t.runs); setItems((w.items as WaitingItem[]).filter((i) => ids.has(i.runId))); })
      .catch(() => { if (live) setError("Could not read the test. Try again."); });
    return () => { live = false; };
  }, [shown, seat, data.board.id, tick]);
  const changed = () => { setTick((n) => n + 1); onChanged(); };

  async function start() {
    setBusy(true); setError("");
    try {
      const r = await post<{ id: string }>(`workflows/${tab.id}/test`, { projectId: project, asName: people.find((p) => p.id === as)?.name ?? null });
      onShow(r.id); setSeat(as); onChanged();
      notify({ id: "wf-test", tone: "success", title: "Test started: nothing is sent", timeout: 3000 });
    } catch (e) { setError(msg(e)); } finally { setBusy(false); }
  }
  async function stop() {
    if (!shown) return; setBusy(true);
    try { await post(`workflows/test-runs/${shown}/stop`); changed(); } catch (e) { setError(msg(e)); } finally { setBusy(false); }
  }
  // The people this test is waiting for right now: whose seat to sit in.
  const waitingFor = useMemo(() => { const m = new Map<string, { id: string; name: string; photoAt: string | null; n: number }>();
    for (const r of trail) for (const s of r.steps) if (s.status === "active" && s.personId) { const x = m.get(s.personId) ?? { id: s.personId, name: s.person ?? "", photoAt: s.photoAt, n: 0 }; x.n++; m.set(s.personId, x); }
    return [...m.values()]; }, [trail]);
  // Only the chosen test's trail is shown (an older fetch for another test is ignored).
  const root = shown && trail[0] && trail.some((r) => r.id === shown) ? trail[0] : undefined;

  return <aside className={css.side} aria-label="Test mode">
    <section className={css.panel}>
      <div className={css.panelHead}><h3><FlaskConical size={15} aria-hidden="true" /> Test this tab</h3><span className={css.chip} data-tone="test">No task · nothing sent</span></div>
      <p className={css.note}>Runs “{tab.name}” as saved, on a copy of a project’s values. Each block goes to whoever the rules pick; you move it on as them.</p>
      {options ? <div className={css.field}><span>On the project (read, never changed)</span><ProjectPicker projects={options.projects} value={project} onChange={setProject} label="Project" /></div> : null}
      <div className={css.field}><span>Sit in the seat of</span><PersonSelect label="Play as" people={people} value={as} onChange={(p) => setAs(p?.id ?? null)} noneLabel="Whoever each block goes to" /></div>
      {dirty ? <p className={css.note} data-tone="stub">Save first: a test follows the tab as saved.</p> : null}
      {error ? <p className={css.note} role="alert" style={{ color: "var(--theme-danger)" }}>{error}</p> : null}
      <div className={css.actions}><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || dirty} onClick={() => void start()}><Play size={14} aria-hidden="true" />Start a test</button>
        {runs.length ? <select aria-label="Earlier tests" value={shown ?? ""} onChange={(e) => onShow(e.target.value || null)} className={styles.btn}>
          {runs.map((r) => <option key={r.id} value={r.id}>{r.name} · {time(r.startedAt)} · {r.status === "running" ? "running" : r.status === "done" ? "done" : "stopped"}</option>)}</select> : null}</div>
    </section>
    {root ? <section className={css.panel} aria-label="Where the test stands">
      <div className={css.panelHead}><h3>Where it stands</h3>{trail.some((r) => r.status === "running") ? <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy} onClick={() => void stop()}><Square size={12} aria-hidden="true" />Stop the test</button> : null}</div>
      <ol className={css.trail}>{(root ? trail : []).map((r) => <li key={r.id}><b>{r.workflow}{r.parentRunId ? " · handed over" : ""}{r.status === "done" ? " · done" : r.status === "cancelled" ? " · stopped" : ""}</b>
        <ul className={css.steps}>{r.steps.map((s) => { const I = ICON[s.status]; return <li key={s.id} data-status={s.status}><I size={14} aria-hidden="true" /><span>{s.title}{s.outcome ? ` · ${s.outcome}` : ""}{s.note ? ` · ${s.note}` : ""}</span>
          <span>{s.status === "active" ? s.person ?? "nobody yet" : s.status === "done" ? "" : ""}</span></li>; })}</ul></li>)}</ol>
    </section> : null}
    {root ? <section className={css.panel} aria-label="Waiting">
      <div className={css.panelHead}><h3>Waiting for {seat ? people.find((p) => p.id === seat)?.name.split(" ")[0] ?? "them" : "everyone"}</h3></div>
      <div className={css.people} role="group" aria-label="Whose seat">
        <button type="button" aria-pressed={!seat} onClick={() => setSeat(null)}>Everyone</button>
        {waitingFor.map((p) => <button key={p.id} type="button" aria-pressed={seat === p.id} onClick={() => setSeat(p.id)}><Avatar name={p.name} id={p.id} photoAt={p.photoAt} size={24} />{p.name.split(" ")[0]}<em>{p.n}</em></button>)}
      </div>
      <WaitingList items={root ? items : []} mode="test" empty={root.status === "running" ? (seat ? "Nothing waits for them now: another seat has the next block." : "Nothing waits for a person now.") : "This test has ended."} onChanged={changed} />
    </section> : null}
  </aside>;
}
