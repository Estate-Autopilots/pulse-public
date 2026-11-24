// PM-UI (dev only): every PM screen and its fixture states as links. Screens are found on disk (screens/*.tsx), so a
// new screen shows here without editing this file; the planned slugs that are not built yet are listed after them.
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PmPage, SectionCard } from "../kit";
import { loadStates, previewEnabled, SLUG } from "./gate";
import css from "./preview.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "PM previews", robots: { index: false, follow: false } };

/** The 19 screens of the design (PICKS.md) and the kit gallery. */
const PLANNED = ["kit", "projects-home", "project-detail", "phase-board", "my-day", "approvals", "client-view", "template-picker", "setup-wizard",
  "team-workload", "step-detail", "clock-move", "client-inputs", "weekly-update", "quote-to-project", "goals", "notifications", "role-map", "timeline", "first-run"];

async function builtScreens(): Promise<string[]> {
  try {
    const dir = path.join(process.cwd(), "app", "projects", "pm", "screens");
    return (await readdir(dir)).filter((f) => f.endsWith(".tsx")).map((f) => f.slice(0, -4)).filter((s) => SLUG.test(s));
  } catch { return []; }
}

export default async function PmPreviewIndex() {
  if (!previewEnabled()) notFound();
  const built = await builtScreens();
  const slugs = [...PLANNED.filter((s) => built.includes(s)), ...built.filter((s) => !PLANNED.includes(s)).sort()];
  const rows = await Promise.all(slugs.map(async (slug) => ({ slug, states: (await loadStates(slug)) ?? [] })));
  const todo = PLANNED.filter((s) => !built.includes(s));
  return <PmPage>
    <h1 className={css.title}>PM screen previews</h1>
    <p className={css.note}>Development only. Each link renders the screen with one fixture state; add <code>?state=</code> to pick another.</p>
    <SectionCard title="Built" aside={`${rows.length} of ${PLANNED.length}`} flush>
      <ul className={css.list}>{rows.map((r) => <li key={r.slug} className={css.row}>
        <Link href={`/projects/pm/preview/${r.slug}`} className={css.slug}>{r.slug}</Link>
        <span className={css.states}>{r.states.length ? r.states.map((k) => <Link key={k} href={`/projects/pm/preview/${r.slug}?state=${encodeURIComponent(k)}`}>{k}</Link>) : <em>no fixtures/{r.slug}.ts states</em>}</span>
      </li>)}</ul>
    </SectionCard>
    {todo.length ? <SectionCard title="Not built yet" aside={String(todo.length)}><p className={css.todo}>{todo.join(" · ")}</p></SectionCard> : null}
  </PmPage>;
}
