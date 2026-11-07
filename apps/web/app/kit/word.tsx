"use client";
// DE-EA: one of the company's words (team, client, project …) inside any screen's text, server-rendered pages too.
// <W k="team" /> → "Pod" for a company that calls its teams pods, "Team" by default; lc gives the mid-sentence form.
// k="function" is what a function (Creative, Sales) is called beside the unit: "Team", or "Department" when the unit is
// itself called "Team" (pod-team.ts functionWord), so the two never share a name.
import { useWords } from "../org-code";
import { lower, say } from "../lib/words.mjs";
import { functionWord } from "../pod-team";
type Key = "team" | "teams" | "client" | "clients" | "project" | "projects" | "function";
export function W({ k, lc }: { k: Key; lc?: boolean }) {
  const words = useWords(); const w = k === "function" ? functionWord(words) : words[k];
  return <>{lc ? lower(w) : w}</>;
}
/** A whole label in the company's words: <Say t="{Teams} side by side" /> (lib/words.mjs say). */
export function Say({ t }: { t: string }) { return <>{say(t, useWords())}</>; }
