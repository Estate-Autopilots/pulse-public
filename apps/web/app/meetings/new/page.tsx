import { FileUp, Megaphone, Mic } from "lucide-react";
import { SegmentedNav } from "../../kit";
import { Page, PageHeader } from "../../ui";
import { Importer } from "../importer";
import { Narrate } from "../narrate";
import { Recorder } from "../recorder";
import css from "../meetings.module.css";

/** KAZUK-REST slice 4 + MEETING-CAPTURE (1946): a new meeting, one engine three ways: paste or upload a transcript (Wispr
 *  Flow, Loom, Otter, .txt, .vtt, .srt), record it in the room (the consent notice first), or narrate a problem (a bug
 *  report or a task, with the page named). `?mode=paste|record|problem`; `?from=<page>` names the page a problem is on. */
export default async function NewMeeting({ searchParams }: { searchParams: Promise<{ project?: string; client?: string; mode?: string; from?: string }> }) {
  const q = await searchParams;
  const mode = q.mode === "record" || q.mode === "problem" ? q.mode : "paste";
  const from = typeof q.from === "string" && /^\/[A-Za-z0-9/_.~%-]{0,200}$/.test(q.from) ? q.from : null;
  const keep = (m: string) => {
    const u = new URLSearchParams({ mode: m });
    if (q.project) u.set("project", q.project);
    if (q.client) u.set("client", q.client);
    if (m === "problem" && from) u.set("from", from);
    return `/meetings/new?${u}`;
  };
  return <Page>
    <PageHeader title={mode === "problem" ? "Narrate a problem" : mode === "record" ? "Start a meeting" : "Add a meeting"} back={{ href: "/meetings", label: "Meetings" }} />
    <div className={css.newWrap}>
      <SegmentedNav label="How to add it" className={css.modes} scroll items={[
        { key: "paste", href: keep("paste"), label: "Paste", icon: <FileUp size={15} aria-hidden="true" />, current: mode === "paste" },
        { key: "record", href: keep("record"), label: "Record", icon: <Mic size={15} aria-hidden="true" />, current: mode === "record" },
        { key: "problem", href: keep("problem"), label: "Narrate a problem", icon: <Megaphone size={15} aria-hidden="true" />, current: mode === "problem" },
      ]} />
      {mode === "paste" ? <Importer project={q.project ?? null} client={q.client ?? null} />
        : mode === "problem" ? <Narrate from={from} />
        : <Recorder project={q.project ?? null} client={q.client ?? null} />}
    </div>
  </Page>;
}
