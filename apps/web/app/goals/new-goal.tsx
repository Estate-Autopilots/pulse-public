"use client";
// FOUNDATIONS: set a goal: yours, a team's (its heads, leadership and admins) or the company's (leadership and admins).
// A measurable target is optional; without one, progress is the work put under the goal.
// UX-POLISH (owner, 6 Nov 2026: the form floated top-right and pushed the page down): the form opens in the kit's
// Drawer (a right-side panel on a computer, a sheet on a phone), so the page under it never moves. The kit's select,
// date field and switch replace the browser's own controls.
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { Plus, Target } from "lucide-react";
import { post } from "../orgs/client";
import { useWords } from "../org-code";
import { say } from "../lib/words.mjs";
import { DateField, Drawer, DrawerFooter, DrawerSection, Segmented, SelectField, Switch } from "../kit";
import { styles } from "../ui";
import type { Goal } from "./parts";
import css from "./goals.module.css";

type Team = { id: string; name: string; canEdit: boolean };
type Level = "person" | "team" | "company";

export function NewGoal({ canCompany, teams, parentId, label = "New goal", onMade, quiet }: { canCompany: boolean; teams: Team[]; parentId?: string; label?: string; onMade?: (g: Goal) => void;
  /** A secondary button (an empty state's call to action under the page's one primary "New goal"). */ quiet?: boolean }) {
  const words = useWords();
  const router = useRouter();
  const formId = useId();
  const mine = teams.filter((t) => t.canEdit);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState<Level>("person");
  const [measured, setMeasured] = useState(false);
  const levels: { value: Level; label: string }[] = [{ value: "person", label: "Mine" },
    ...(mine.length ? [{ value: "team" as const, label: say("A {team}'s", words) }] : []), ...(canCompany ? [{ value: "company" as const, label: "The company's" }] : [])];

  function close() { setOpen(false); setError(null); }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (k: string) => String(f.get(k) ?? "").trim();
    const body: Record<string, unknown> = { level, title: text("title"), why: text("why") || null, targetOn: text("targetOn") || null, ...(parentId ? { parentId } : {}) };
    if (level === "team") body.teamId = text("teamId");
    if (measured) Object.assign(body, { measureLabel: text("measureLabel"), startValue: Number(text("startValue") || 0), targetValue: Number(text("targetValue")), currentValue: Number(text("startValue") || 0) });
    setBusy(true); setError(null);
    try {
      const r = await post<{ goal: Goal }>("goals", body);
      setOpen(false); setMeasured(false);
      if (onMade) onMade(r.goal); else router.push(`/goals/${r.goal.id}`);
      router.refresh();
    } catch (err) { setError(err instanceof Error ? err.message : "That did not work. Try again."); }
    finally { setBusy(false); }
  }

  const primary = !parentId && !quiet;
  return <>
    <button type="button" className={`${styles.btn}${primary ? ` ${styles.btnPrimary}` : ""}`} onClick={() => setOpen(true)} aria-haspopup="dialog"><Plus size={16} aria-hidden="true" />{label}</button>
    {open ? <Drawer title={parentId ? "Add a goal under this one" : "Set a goal"} icon={<Target size={16} aria-hidden="true" />} onClose={close} size="md"
      help="A goal holds the projects and tasks that get you somewhere bigger. Its progress is the share of that work that is done, or the number you track."
      footer={<DrawerFooter status={error} primary={<button type="submit" form={formId} className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>{busy ? "Saving…" : "Set goal"}</button>}>
        <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={close}>Cancel</button>
      </DrawerFooter>}>
      <form id={formId} className={css.form} onSubmit={submit} aria-label={label}>
        <DrawerSection>
          <label className={styles.field}>What do you want to achieve?
            <input name="title" required maxLength={160} data-autofocus placeholder="For example: Sign 12 new clients this year" />
          </label>
          {levels.length > 1 ? <div className={styles.field}><span aria-hidden="true">Whose goal</span>
            <Segmented label="Whose goal" value={level} onChange={setLevel} options={levels} />
          </div> : null}
          {level === "team" ? <label className={styles.field}>{say("{Team}", words)}
            <SelectField name="teamId" required>{mine.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</SelectField>
          </label> : null}
          <label className={styles.field}>Target date <span className={css.hint}>Optional</span>
            <DateField name="targetOn" aria-label="Target date" />
          </label>
          <label className={styles.field}>Why it matters <span className={css.hint}>Optional. One or two sentences people will see on the goal.</span>
            <textarea name="why" maxLength={2000} rows={3} />
          </label>
        </DrawerSection>
        <DrawerSection title="Progress">
          <Switch inline label="It has a number to reach" hint={measured ? undefined : "Without a number, progress is the share of the work under the goal that is done."}
            checked={measured} onChange={setMeasured} />
          {measured ? <div className={css.row}>
            <label className={styles.field}>What it counts<input name="measureLabel" required maxLength={60} placeholder="clients signed" /></label>
            <label className={styles.field}>Starts at<input name="startValue" type="number" step="any" defaultValue={0} inputMode="decimal" /></label>
            <label className={styles.field}>Target<input name="targetValue" type="number" step="any" required inputMode="decimal" /></label>
          </div> : null}
        </DrawerSection>
      </form>
    </Drawer> : null}
  </>;
}
