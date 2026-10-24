// TASKS-4B: a person's record, kindly. For the team: finished and on time, sent back, finished with subtasks still open
// (now prevented at Done), the quality their reviewers saw and help given. For leadership and founders, who are not
// graded: outcomes only (work finished, what their work unlocked, on-time rate, blockers cleared; no points: INTEGRITY). Server-safe; the
// numbers come from pulse.person_task_signals() and pulse.help_totals(), readable by the person, their head, HR and
// leadership.
import { CheckCheck, LifeBuoy, ListChecks, Sparkles, Undo2, Unlock, Clock3 } from "lucide-react";
import type { ReactNode } from "react";
import { api } from "../lib/api";
import css from "./life.module.css";

export type Signals = { days: number; finished: number; onTime: number; late: number; withDue: number; openSubtasks: number; sentBack: number; quality: number | null; rated: number; above: number;
  unlocked: number; blockersCleared: number; leader: boolean };
export type Help = { answered: number; helpful: number; somewhat: number; notHelpful: number; asked: number };
const QUALITY = (q: number) => q >= 4.5 ? "mostly Great" : q >= 3.5 ? "mostly Good" : q >= 2.5 ? "mixed" : "often Needs work";

export function TaskSignals({ s, help, self, name }: { s: Signals; help?: Help | null; self: boolean; name: string }) {
  const who = self ? "you" : name.split(" ")[0];
  const pct = s.withDue ? Math.round((100 * s.onTime) / s.withDue) : null;
  const rows: { icon: ReactNode; title: string; text: string; tone?: string }[] = s.leader ? [
    { icon: <CheckCheck size={15} />, title: `${s.finished}`, text: `task${s.finished === 1 ? "" : "s"} finished` },
    { icon: <Unlock size={15} />, title: `${s.unlocked}`, text: `task${s.unlocked === 1 ? "" : "s"} unlocked for others` },
    { icon: <Clock3 size={15} />, title: pct === null ? "No deadlines" : `${pct} %`, text: pct === null ? "nothing finished had a due date" : `on time (${s.onTime} of ${s.withDue})` },
    { icon: <ListChecks size={15} />, title: `${s.blockersCleared}`, text: `blocker${s.blockersCleared === 1 ? "" : "s"} cleared` },
  ] : [
    { icon: <ListChecks size={15} />, title: `${s.finished} finished`, text: pct === null ? "none had a deadline" : `${pct} % on time (${s.onTime} of ${s.withDue} with a deadline)` },
    { icon: <Sparkles size={15} />, title: s.quality === null ? "Not rated yet" : `Quality: ${QUALITY(s.quality)}`, text: s.rated ? `${s.rated} reviewed${s.above ? ` · ${s.above} above and beyond` : ""}` : "Reviews say how good the work was" },
    { icon: <Undo2 size={15} />, title: s.sentBack ? `${s.sentBack} sent back` : "Nothing sent back", text: s.sentBack ? "for more work: normal when work is reviewed; each note shows on the task" : "reviewers accepted what was finished" },
    ...(s.openSubtasks ? [{ icon: <ListChecks size={15} />, title: `${s.openSubtasks} finished with subtasks open`, text: "before Done asked to close them first; it does now", tone: "note" }] : []),
  ];
  if (help && (help.answered || help.asked)) rows.push({ icon: <LifeBuoy size={15} />, title: help.answered ? `Helped ${help.answered} time${help.answered === 1 ? "" : "s"}` : "Asked for help",
    text: help.answered ? `${help.helpful} helpful · ${help.somewhat} somewhat` : `${help.asked} request${help.asked === 1 ? "" : "s"} for help` });
  return <section className={css.signals} aria-label={s.leader ? "Outcomes" : "How work went"}>
    <div className={css.signalsHead}><h2>{s.leader ? "Outcomes" : "How work went"}</h2><small>last {s.days} days{s.leader ? ` · leadership’s work is acknowledged, not graded` : ""}</small></div>
    <ul>{rows.map((r, i) => <li key={`${i}-${r.title}`} data-tone={r.tone}>{r.icon}<span><b>{r.title}</b><small>{r.text}</small></span></li>)}</ul>
    <p className={css.signalsNote}>{self ? "Only you, your head, HR and leadership see this. Nobody is ranked." : `${who} sees the same. Nobody is ranked.`}</p>
  </section>;
}

/** For a person page: reads the signals itself (GET /tasks/signals/:id); nothing shows to someone who may not see them. */
export async function PersonSignals({ personId, name, self }: { personId: string; name: string; self: boolean }) {
  const r = await api<Signals & { help: Help }>(`tasks/signals/${personId}`);
  return r.data ? <TaskSignals s={r.data} help={r.data.help} self={self} name={name} /> : null;
}
