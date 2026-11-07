"use client";
// TASKUX (owner, 2 Nov 2026): a task's plan in its properties panel: when it starts, a finer state inside its status
// (Waiting for response and On hold are Blocked; Revision required is Doing, so every report keeps counting it as
// before) and how it repeats (every N days, weeks on chosen days, or months; skip weekends; a stop date).
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Repeat } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { DateField, DatePicker, Drawer, DrawerFooter, DrawerSection, Segmented, SelectField, Switch } from "../kit";
import { post } from "../records";
import { dayMonthYear } from "./parts";
import css from "./work3.module.css";
import p from "./plan-edit.module.css";

export const STAGES: { value: "" | "waiting" | "revision" | "on_hold"; label: string }[] = [
  { value: "", label: "As its status" }, { value: "waiting", label: "Waiting for response" }, { value: "revision", label: "Revision required" }, { value: "on_hold", label: "On hold" }];
export type RepeatRule = { every: "day" | "week" | "month" | null; interval?: number; weekdays?: number[]; skipWeekends?: boolean; until?: string | null; nextOn?: string | null };
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";

/** "Every week on Mon, Thu until 31 Dec 2026". */
export function repeatText(r: RepeatRule | null | undefined) {
  if (!r?.every) return null;
  const n = r.interval && r.interval > 1 ? r.interval : 1;
  const unit = n > 1 ? `${n} ${r.every}s` : r.every;
  const days = r.every === "week" && r.weekdays?.length ? ` on ${r.weekdays.map((d) => DAYS[d - 1]).join(", ")}` : "";
  const skip = r.skipWeekends && r.every !== "week" ? ", weekdays only" : "";
  return `Every ${unit}${days}${skip}${r.until ? ` until ${dayMonthYear(r.until)}` : ""}`;
}

async function save(taskId: string, body: Record<string, unknown>) {
  return post<{ startsOn: string | null; stage: string | null; status: string; repeat: RepeatRule }>(`tasks/${taskId}/schedule`, body);
}

/** The start date (a calendar, like the due date beside it). */
export function StartEdit({ taskId, startsOn, dueOn, today, canEdit }: { taskId: string; startsOn: string | null; dueOn: string | null; today: string; canEdit: boolean }) {
  const router = useRouter();
  if (!canEdit) return startsOn ? <span>{dayMonthYear(startsOn)}</span> : <span className={p.muted}>Not set</span>;
  async function change(day: string | null) {
    try { await save(taskId, { startsOn: day }); notify({ id: "start", tone: "success", title: day ? `Starts ${dayMonthYear(day)}` : "No start date", timeout: 2200 }); router.refresh(); }
    catch (e) { notify({ id: "start", tone: "error", title: "Not changed", message: msg(e) }); }
  }
  return <DatePicker value={{ date: startsOn, time: null }} onChange={(v) => void change(v.date)} today={today} label="Start date" placeholder="Not set" variant="ghost" size="sm"
    max={dueOn ?? undefined} highlight={false} className={css.dueTrigger} />;
}

/** Waiting for response / Revision required / On hold. */
export function StageEdit({ taskId, stage, canEdit }: { taskId: string; stage: string | null; canEdit: boolean }) {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  const label = STAGES.find((s) => s.value === (stage ?? ""))?.label ?? "As its status";
  if (!canEdit) return stage ? <span>{label}</span> : <span className={p.muted}>As its status</span>;
  return <SelectField value={stage ?? ""} disabled={busy} aria-label="State" className={p.select} onChange={async (e) => {
    setBusy(true);
    try { const r = await save(taskId, { stage: e.target.value || null }); notify({ id: "stage", tone: "success", title: r.stage ? STAGES.find((s) => s.value === r.stage)?.label ?? "Saved" : "Back to its status", timeout: 2200 }); router.refresh(); }
    catch (err) { notify({ id: "stage", tone: "error", title: "Not changed", message: msg(err) }); } finally { setBusy(false); }
  }}>{STAGES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</SelectField>;
}

/** How the task repeats: one line, and a sheet to change it. */
export function RepeatEdit({ taskId, every, canEdit, today }: { taskId: string; every: string | null; canEdit: boolean; today: string }) {
  const [open, setOpen] = useState(false); const [rule, setRule] = useState<RepeatRule | null>(null);
  useEffect(() => {
    let live = true;
    if (every || open) fetch(`/api/v0/tasks/${taskId}/schedule`, { cache: "no-store" }).then((r) => r.ok ? r.json() : null).then((d) => { if (live && d) setRule(d.repeat); }).catch(() => undefined);
    return () => { live = false; };
  }, [taskId, every, open]);
  const text = repeatText(rule) ?? (every ? `Every ${every}` : null);
  if (!canEdit) return text ? <span className={p.line}><Repeat size={14} aria-hidden="true" />{text}</span> : <span className={p.muted}>Does not repeat</span>;
  return <>
    <button type="button" className={p.trigger} onClick={() => setOpen(true)} aria-haspopup="dialog">
      <Repeat size={14} aria-hidden="true" />{text ?? "Does not repeat"}{rule?.nextOn ? <small>next {dayMonthYear(rule.nextOn)}</small> : null}
    </button>
    {open ? <RepeatSheet taskId={taskId} rule={rule} today={today} onClose={() => setOpen(false)} onSaved={(r) => setRule(r)} /> : null}
  </>;
}

function RepeatSheet({ taskId, rule, today, onClose, onSaved }: { taskId: string; rule: RepeatRule | null; today: string; onClose: () => void; onSaved: (r: RepeatRule) => void }) {
  const router = useRouter();
  const [every, setEvery] = useState<"day" | "week" | "month">(rule?.every ?? "week");
  const [interval, setEveryN] = useState(rule?.interval ?? 1);
  const [days, setDays] = useState<number[]>(rule?.weekdays ?? []);
  const [skip, setSkip] = useState(!!rule?.skipWeekends);
  const [until, setUntil] = useState(rule?.until ?? "");
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  async function apply(stop: boolean) {
    setBusy(true); setError(null);
    try {
      const r = await save(taskId, { repeat: stop ? null : { every, interval, weekdays: every === "week" ? days : [], skipWeekends: every !== "week" && skip, until: until || null } });
      onSaved(r.repeat); notify({ id: "repeat", tone: "success", title: stop ? "It no longer repeats" : repeatText(r.repeat) ?? "Saved", timeout: 2600 }); router.refresh(); onClose();
    } catch (e) { setError(msg(e)); } finally { setBusy(false); }
  }
  const unit = every === "day" ? "days" : every === "week" ? "weeks" : "months";
  return <Drawer title="Repeat" context={repeatText({ every, interval, weekdays: days, skipWeekends: skip, until: until || null })} onClose={onClose} size="sm"
    footer={<DrawerFooter status={error} primary={<button type="button" className={p.primary} disabled={busy} onClick={() => void apply(false)}>Save</button>}>
      {rule?.every ? <button type="button" className={p.secondary} disabled={busy} onClick={() => void apply(true)}>Stop repeating</button> : null}
      <button type="button" className={p.secondary} onClick={onClose}>Cancel</button>
    </DrawerFooter>}>
    <DrawerSection title="How often">
      <Segmented label="Repeat every" value={every} onChange={setEvery} fill options={[{ value: "day", label: "Daily" }, { value: "week", label: "Weekly" }, { value: "month", label: "Monthly" }]} />
      <label className={p.field}><span>Every</span>
        <span className={p.inline}><input type="number" min={1} max={12} inputMode="numeric" value={interval} onChange={(e) => setEveryN(Math.max(1, Math.min(12, Number(e.target.value) || 1)))} aria-label={`Every how many ${unit}`} />{unit}</span>
      </label>
    </DrawerSection>
    {every === "week" ? <DrawerSection title="On these days" help="None chosen: the same weekday as the task's own day.">
      <div className={p.days} role="group" aria-label="Weekdays">{DAYS.map((d, i) => <button key={d} type="button" className={p.day} aria-pressed={days.includes(i + 1)}
        onClick={() => setDays(days.includes(i + 1) ? days.filter((x) => x !== i + 1) : [...days, i + 1].sort())}>{d}</button>)}</div>
    </DrawerSection> : <DrawerSection>
      <Switch label="Skip weekends" hint="A Saturday or Sunday moves to the Monday after." checked={skip} onChange={setSkip} />
    </DrawerSection>}
    <DrawerSection title="Stop on" help="The last day a new one is made. Empty: it keeps repeating until you stop it.">
      <DateField value={until} onChange={(e) => setUntil(e.target.value)} min={today} aria-label="Stop date" placeholder="Never" />
    </DrawerSection>
    <DrawerSection><p className={p.note}>The next one is made when this one is finished, and on its day even if this one is still open (that one stays, overdue).</p></DrawerSection>
  </Drawer>;
}
