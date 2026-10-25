"use client";
// GROUPS-HUB: the review queue for imported groups, to put the data into Pulse one by one, fast: groups to link to
// their project and client (Pulse's best guess first), senders of the imported history nobody is mapped to, and tasks
// and approvals found in the history (by the history scan or an AI employee). One click accepts; the next one is
// already there.
import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, FolderKanban, ListChecks, Loader2, UserRoundSearch } from "lucide-react";
import { Combobox, Segmented } from "../../kit";
import { get, send } from "../net";
import css from "./hub.module.css";
import { GroupMark } from "./hub";
import { SenderList, SuggestionList, type Suggestion } from "./detail";
import { displayName, monthLabel, type HubData } from "./model";

type Queue = { suggestions: (Suggestion & { channelId: string; group: string })[]; senders: { channelId: string; group: string; label: string; messages: number; firstAt: string; lastAt: string }[]; done: { accepted: number; dismissed: number; today: number } };
type Lane = "link" | "senders" | "work";

export function Review({ data, onOpen, reload, say }: { data: HubData; onOpen: (id: string) => void; reload: () => Promise<void>; say: (t: string, tone?: "error") => void }) {
  const [q, setQ] = useState<Queue | null>(null);
  const [lane, setLane] = useState<Lane>("link");
  const load = useCallback(async () => { try { setQ(await get<Queue>("chats/hub/review")); } catch (e) { say((e as Error).message, "error"); } }, [say]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- the queue loads when the tab opens
  useEffect(() => { void load(); }, [load]);
  const refresh = useCallback(async () => { await Promise.all([load(), reload()]); }, [load, reload]);
  const unlinked = useMemo(() => data.groups.filter((g) => g.kind === "client" && g.status !== "archived" && !g.projectId)
    .sort((a, b) => (b.imported - a.imported) || (b.lastAt ?? "").localeCompare(a.lastAt ?? "")), [data.groups]);
  if (!q) return <p className={css.loading}><Loader2 size={16} className={css.spin} aria-hidden="true" />Loading the queue…</p>;
  const linkSug = q.suggestions.filter((s) => s.kind === "link_project" || s.kind === "link_client");
  const work = q.suggestions.filter((s) => s.kind === "task" || s.kind === "approval");
  const left = unlinked.length + q.senders.length + work.length;
  return <section className={css.reviewTab} aria-label="To review">
    <div className={css.reviewHead}>
      <div><h2>{left ? `${left.toLocaleString("en-IN")} to put in place` : "All reviewed"}</h2>
        <p>Imported groups become proper Pulse work here: link each group to its project, say who each unknown sender is, and turn what clients asked into tasks. {q.done.today ? <b>{q.done.today} done today.</b> : null}</p></div>
      <div className={css.progress} aria-label={`${q.done.accepted} accepted, ${q.done.dismissed} dismissed`}><span style={{ width: `${Math.round((100 * (q.done.accepted + q.done.dismissed)) / Math.max(1, q.done.accepted + q.done.dismissed + left))}%` }} /></div>
    </div>
    <Segmented<Lane> label="What to review" value={lane} onChange={setLane} size="md" className={css.tabs}
      options={[{ value: "link", label: "Link to projects", icon: FolderKanban, count: unlinked.length }, { value: "senders", label: "Who is this?", icon: UserRoundSearch, count: q.senders.length },
        { value: "work", label: "Tasks and approvals", icon: ListChecks, count: work.length }]} />
    {lane === "link" ? (unlinked.length ? <ul className={css.queue}>{unlinked.slice(0, 150).map((g) => {
      const sug = linkSug.filter((s) => s.channelId === g.id);
      return <LinkRow key={g.id} g={g} sug={sug} data={data} onOpen={onOpen} refresh={refresh} say={say} />;
    })}</ul> : <Done text="Every client group is linked to its project." />) : null}
    {lane === "senders" ? (q.senders.length ? <SenderList rows={q.senders} data={data} refresh={refresh} say={say} showGroup /> : <Done text="Every sender of the imported history is someone in Pulse." />) : null}
    {lane === "work" ? (work.length ? <SuggestionList rows={work} data={data} refresh={refresh} say={say} showGroup onOpen={onOpen} />
      : <Done text="No tasks waiting. Open an imported group and use “Look through the history”, or ask its AI employee to find tasks." />) : null}
  </section>;
}

function Done({ text }: { text: string }) {
  return <div className={css.empty}><CheckCircle2 size={28} aria-hidden="true" /><h2>Nothing here</h2><p>{text}</p></div>;
}

function LinkRow({ g, sug, data, onOpen, refresh, say }: { g: HubData["groups"][number]; sug: Suggestion[]; data: HubData; onOpen: (id: string) => void; refresh: () => Promise<void>; say: (t: string, tone?: "error") => void }) {
  const guess = sug.find((s) => s.kind === "link_project");
  const [project, setProject] = useState<string | null>((guess?.detail.projectId as string) ?? null);
  const [busy, setBusy] = useState(false);
  const read = [g.parsed?.project, g.parsed?.client ? `client ${g.parsed.client}` : null, g.area, g.period ? monthLabel(g.period) : null].filter(Boolean).join(" · ");
  const save = async () => {
    setBusy(true);
    try {
      if (guess && guess.detail.projectId === project) await send(`chats/hub/suggestions/${guess.id}/accept`, {});
      else await send("chats/hub/set", { ids: [g.id], fields: { projectId: project, ...(data.projects.find((p) => p.id === project)?.clientId ? { clientId: data.projects.find((p) => p.id === project)!.clientId } : {}) } });
      await refresh(); say(`Linked ${g.name}`);
    } catch (e) { say((e as Error).message, "error"); } finally { setBusy(false); }
  };
  return <li className={css.qItem}>
    <button type="button" className={css.qGroup} onClick={() => onOpen(g.id)} aria-label={`Open ${g.name}`}><GroupMark g={g} size={34} /></button>
    <span className={css.qText}><b title={g.name}>{displayName(g.name)}</b><span className={css.muted}>{read ? `Read: ${read}` : "Nothing readable in the name"}{g.imported ? ` · ${g.imported.toLocaleString("en-IN")} imported messages` : ""}</span>
      {guess ? <span className={css.guess}>Best guess {Math.round(Number(guess.confidence ?? 0) * 100)}%: {String(guess.detail.project)}</span> : null}</span>
    <span className={css.qActions}>
      <Combobox label={`Project for ${g.name}`} value={project} onChange={setProject} size="sm" placeholder="Choose the project"
        options={data.projects.map((p) => ({ value: p.id, label: p.name, detail: p.status !== "active" ? p.status : undefined }))} />
      <button type="button" className={css.primary} disabled={!project || busy} onClick={() => void save()} data-accept="">Link</button>
    </span>
  </li>;
}
