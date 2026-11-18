import { lower } from "../lib/words.mjs";
import type { Vocabulary } from "../lib/api";
import { day } from "../lib/format";
import { PipelineBoard } from "./pipeline-board";
import css from "./sales-home.module.css";

/** KAZUK-GAPS (A19; Kazuk, 3 Nov meeting 1682): a salesperson's own dashboard: their quotations by stage, follow-ups
 *  due, won and lost this month, and the value still waiting for an answer. Data: GET /api/v0/sales-pipeline (paise). */
export type Pipeline = {
  person: { id: string; name: string; self: boolean }; today: string; month: string;
  stages: { key: "draft" | "approval" | "sent" | "won"; count: number; value: number }[];
  pipeline: { count: number; value: number; oldest: number | null };
  won: { count: number; value: number }; lost: { count: number; value: number };
  followUps: { due: number; week: number; items: { id: string; title: string; dueOn: string | null; overdue: boolean }[] };
};

/** UX-GAMIFY: one line each on a phone. */
const SHORT_STAGE: Record<Pipeline["stages"][number]["key"], string> = { draft: "Drafts", approval: "For approval", sent: "Sent", won: "Won, to invoice" };
const STAGE: Record<Pipeline["stages"][number]["key"], string> = { draft: "Drafts", approval: "Waiting for approval", sent: "Sent, no answer yet", won: "Won, not invoiced" };

export function PipelinePanel({ p, words, more }: { p: Pipeline; words: Vocabulary; more?: boolean }) {
  // UX-GAMIFY: drawn by the game-feel kit (pipeline-board.tsx); the words and the data are the same as before. KAZUK-V2
  // (conflict C1): "Waiting for approval" shows only where something can wait (EA has no approval step). LAND-CAPTAIN-10.
  return <div className={css.wide}><PipelineBoard title={p.person.self ? "My pipeline" : `Pipeline · ${p.person.name}`} more={more} clientWord={lower(words.client)}
    stages={p.stages.filter((s) => s.key !== "approval" || s.count > 0).map((s) => ({ key: s.key, label: SHORT_STAGE[s.key], count: s.count, value: s.value }))} pipeline={p.pipeline} won={p.won} lost={p.lost} tiles={!!more}
    due={p.followUps.due} week={p.followUps.week}
    followUps={p.followUps.items.map((f) => {
      const state = f.overdue ? "overdue" as const : f.dueOn && f.dueOn <= p.today ? "today" as const : "upcoming" as const;
      return { id: f.id, title: f.title, state, when: f.overdue && f.dueOn ? `Follow-up missed ${day(f.dueOn)}` : f.dueOn === p.today ? "Follow-up due today" : f.dueOn ? `Follow-up ${day(f.dueOn)}` : "No day set" };
    })} /></div>;
}
