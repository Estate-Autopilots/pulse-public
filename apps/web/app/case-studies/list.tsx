"use client";
// CASE-STUDIES (owner, 10 Nov 2026): the pipeline. Codex concept 2 ("journey list"), its phone form from concept 3:
// tiles on top, the 8 stages as a strip with a count each (tap one to see only its companies), then one row per company
// with its 8-dot journey, the day of 45 and the next step. One primary action: Add a company.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { BookOpenCheck, CalendarDays, CircleCheck, Plus, Users } from "lucide-react";
import { Drawer, DrawerFooter, DrawerSection } from "../kit";
import { ActionButton, Chip, EmptyState, GameCard, GamePage, ListRow, ListRows, PageHeader, StatTile, StatTiles, toast } from "../kit/game";
import { styles } from "../ui";
import { casePost, SECTORS, type CaseCard, type CaseList } from "./model";
import css from "./case.module.css";

export function Journey({ stage, finished, label }: { stage: number; finished: boolean; label: string }) {
  return <span className={css.dots} role="img" aria-label={label}>
    {Array.from({ length: 8 }, (_, i) => <span key={i} className={css.dot} data-state={finished || i + 1 < stage ? "done" : i + 1 === stage ? "now" : "next"} />)}
  </span>;
}
export const initial = (name: string) => name.trim().charAt(0).toUpperCase() || "?";
export const dayText = (c: Pick<CaseCard, "day" | "of" | "over" | "finished">) => c.finished ? "Journey done" : c.over ? `Day ${c.day} · ${c.over} over` : `Day ${c.day} of ${c.of}`;

export function CaseListError({ text }: { text: string }) {
  const router = useRouter();
  return <EmptyState art="nothing" title="Case studies did not load" text={text} action={{ label: "Try again", onClick: () => router.refresh() }} />;
}

export function CaseListView({ data }: { data: CaseList }) {
  const router = useRouter();
  const [stage, setStage] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const live = data.cases.filter((c) => !c.finished);
  const avgDay = live.length ? Math.round(live.reduce((a, c) => a + Math.min(c.day, c.of), 0) / live.length) : 0;
  const stepsDone = data.cases.reduce((a, c) => a + c.checksDone, 0), stepsAll = data.cases.reduce((a, c) => a + c.checksTotal, 0);
  const shown = stage === null ? data.cases : data.cases.filter((c) => (c.finished ? 9 : c.stage) === stage);
  const add = { label: "Add a company", icon: Plus, onClick: () => setAdding(true) };

  return <GamePage label="Case studies">
    <PageHeader title="Case studies" subtitle="Partner businesses on the 45-day journey, from the first hello to a published story." primary={add} shellTitle />
    {data.cases.length ? <>
      <StatTiles label="Case studies at a glance" pair>
        <StatTile label="In the journey" value={live.length} icon={Users} />
        <StatTile label="Average day" value={live.length ? `${avgDay}` : "–"} unit={live.length ? `of ${data.cases[0].of}` : undefined} icon={CalendarDays} />
        <StatTile label="Steps done" value={`${stepsDone}`} unit={`of ${stepsAll}`} icon={CircleCheck} />
        <StatTile label="Stories published" value={data.cases.filter((c) => c.published).length} icon={BookOpenCheck} />
      </StatTiles>
      <GameCard title="The 8 stages" note={stage === null ? "Tap a stage to see only its companies" : <button type="button" className={css.linkBtn} onClick={() => setStage(null)}>Show all</button>}>
        <div className={css.stripBox}>
          <ol className={css.strip} aria-label="Companies in each stage">
            {data.stages.map((s) => {
              const n = data.cases.filter((c) => !c.finished && c.stage === s.n).length;
              return <li key={s.key}><button type="button" className={css.stageTile} aria-pressed={stage === s.n} data-empty={n ? undefined : ""} title={s.what}
                onClick={() => setStage(stage === s.n ? null : s.n)}>
                <span className={css.stageNo}>{s.n}</span><span className={css.stageName}>{s.label}</span><b className={css.stageCount}>{n}</b>
              </button></li>;
            })}
          </ol>
        </div>
      </GameCard>
      <GameCard title={stage === null ? "Companies" : `In stage ${stage}: ${data.stages[stage - 1]?.label ?? "Done"}`} note={`${shown.length} ${shown.length === 1 ? "company" : "companies"}`}>
        {shown.length ? <ListRows label="Companies on the journey">
          {shown.map((c) => <li key={c.id}><ListRow href={`/case-studies/${c.id}`} label={`${c.name}, ${c.finished ? "journey done" : `stage ${c.stage}, ${c.stageLabel}`}`}
            lead={<span className={css.logo} aria-hidden="true">{initial(c.name)}</span>}
            title={<span className={css.rowTitle}>{c.name}{c.sector ? <Chip>{c.sector}</Chip> : null}{c.published ? <Chip tone="good">Published</Chip> : null}</span>}
            sub={<span className={css.rowSub}>
              <span className={css.rowJourney}><Journey stage={c.stage} finished={c.finished} label={c.finished ? "All 8 stages done" : `Stage ${c.stage} of 8`} />
                <span>{c.finished ? "All 8 stages done" : `${c.stage} · ${c.stageLabel}`}</span></span>
              {c.next ? <span className={css.next}>Next: {c.next}</span> : null}
            </span>}
            end={<Chip tone={c.over && !c.finished ? "warn" : undefined}>{dayText(c)}</Chip>} /></li>)}
        </ListRows> : <div className={css.quietEmpty}><p>No company is in this stage right now.</p><ActionButton action={{ label: "Show all companies", onClick: () => setStage(null) }} /></div>}
      </GameCard>
    </> : <GameCard><EmptyState art="nothing" title="No companies on the journey yet" text="Add the first business you will help. You get its 45-day plan, step by step." action={add} /></GameCard>}
    {adding ? <AddCompany onClose={() => setAdding(false)} onAdded={(id) => { setAdding(false); toast("Added. Day 1 starts today."); router.push(`/case-studies/${id}`); }} /> : null}
  </GamePage>;
}

function AddCompany({ onClose, onAdded }: { onClose: () => void; onAdded: (id: string) => void }) {
  const [name, setName] = useState(""), [sector, setSector] = useState(""), [aim, setAim] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (!name.trim()) { setError("Write the company or owner's name"); return; }
    setBusy(true); setError(null);
    try { const r = await casePost<{ id: string }>("case-studies", { name, sector, aim }); onAdded(r.id); }
    catch (e) { setError(e instanceof Error ? e.message : "Not saved"); setBusy(false); }
  };
  return <Drawer title="Add a company" onClose={onClose} size="sm" footer={<DrawerFooter status={error}
    primary={<button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={save} disabled={busy} aria-busy={busy || undefined}>{busy ? "Adding…" : "Add to the journey"}</button>} />}>
    <DrawerSection>
      <label className={styles.field}>Company or owner<input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="For example: Lotus Interiors" autoFocus /></label>
      <label className={styles.field}>Kind of business<select value={sector} onChange={(e) => setSector(e.target.value)}>
        <option value="">Not sure yet</option>{SECTORS.map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
      <label className={styles.field}>What do they want? (optional)<textarea value={aim} onChange={(e) => setAim(e.target.value)} maxLength={300} placeholder="For example: double the leads in 3 months" /></label>
      <p className={css.help}>Day 1 is today. Every company gets the same 8 stages, with a short list of steps in each.</p>
    </DrawerSection>
  </Drawer>;
}
