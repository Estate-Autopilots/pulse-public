"use client";
// GROUPS-2 (owner: "so much data to be imported, interpreted, analysed and all put in Pulse one by one"): the guided
// review for admins and leadership. It walks the imported groups in order of value (active clients first, the most
// recently active first), one at a time: link the group to its client and project, say who its unknown senders are,
// turn what the history asked for into tasks (WA-IMPORT's classifier finds them), then "Done, next". Progress is kept
// on each group, so the whole WhatsApp history gets in over days; "Later" puts a group off until tomorrow.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, CheckCircle2, Clock3, Compass, Loader2, ScanSearch, Undo2 } from "lucide-react";
import { get, send } from "../net";
import css from "./hub.module.css";
import { GroupMark } from "./hub";
import { SenderList, SuggestionList, type Detail } from "./detail";
import { LinkRow } from "./review";
import { ago, displayName, KIND, monthLabel, type HubData } from "./model";

type Tier = "active" | "client" | "other";
type Row = { id: string; tier: Tier; days: number | null; messages: number; imported: number; reviewedAt: string | null; reviewedBy: string | null; later: boolean;
  left: { link: boolean; senders: number; suggestions: number } };
type Guide = { queue: Row[]; progress: { total: number; done: number; today: number; tiers: Record<Tier, { done: number; total: number }>; messages: { done: number; total: number };
  perDay: Record<string, number>; daysLeft: number | null } };
const TIER: Record<Tier, string> = { active: "Active clients", client: "Other client groups", other: "Pods, teams and others" };
const pct = (a: number, b: number) => `${Math.round((100 * a) / Math.max(1, b))}%`;

export function GuidedReview({ data, onOpen, reload, say }: { data: HubData; onOpen: (id: string) => void; reload: () => Promise<void>; say: (t: string, tone?: "error") => void }) {
  const [guide, setGuide] = useState<Guide | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [d, setD] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false), [scanning, setScanning] = useState(false);
  const scanned = useRef(new Set<string>());
  const load = useCallback(async (keep?: string | null) => {
    try {
      const g = await get<Guide>("chats/hub/guide"); setGuide(g);
      setCurrent((c) => (keep !== undefined ? keep : c) ?? g.queue.find((q) => !q.reviewedAt && !q.later)?.id ?? g.queue.find((q) => !q.reviewedAt)?.id ?? null);
    } catch (e) { say((e as Error).message, "error"); }
  }, [say]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- the queue loads when the lane opens
  useEffect(() => { void load(); }, [load]);
  const loadGroup = useCallback(async (id: string) => {
    try {
      const x = await get<Detail>(`chats/hub/groups/${id}`); setD(x);
      // The history is read for tasks and approvals once, when its group comes up (the classifier's finds, else words).
      if (x.group.imported && !scanned.current.has(id) && !x.suggestions.some((s) => s.kind === "task" || s.kind === "approval")) {
        scanned.current.add(id); setScanning(true);
        try { const r = await send<{ added: number }>(`chats/hub/groups/${id}/scan`); if (r.added) setD(await get<Detail>(`chats/hub/groups/${id}`)); }
        catch { /* not readable for this viewer: the step says so */ } finally { setScanning(false); }
      }
    } catch (e) { say((e as Error).message, "error"); }
  }, [say]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- a new current group loads its detail
  useEffect(() => { setD(null); if (current) void loadGroup(current); }, [current, loadGroup]);
  const refresh = useCallback(async () => { await Promise.all([current ? loadGroup(current) : null, reload(), load(current)]); }, [current, loadGroup, reload, load]);
  const mark = async (state: "reviewed" | "later" | "open", id = current) => {
    if (!id) return;
    setBusy(true);
    try {
      await send(`chats/hub/groups/${id}/review`, { state });
      const g = await get<Guide>("chats/hub/guide"); setGuide(g);
      const next = state === "open" ? id : g.queue.find((q) => !q.reviewedAt && !q.later && q.id !== id)?.id ?? g.queue.find((q) => !q.reviewedAt && q.id !== id)?.id ?? null;
      setCurrent(next);
      say(state === "reviewed" ? "Done. Next group" : state === "later" ? "Put off until tomorrow" : "Opened again");
      void reload();
    } catch (e) { say((e as Error).message, "error"); } finally { setBusy(false); }
  };
  const byId = useMemo(() => new Map(data.groups.map((g) => [g.id, g])), [data.groups]);
  if (!guide) return <p className={css.loading}><Loader2 size={16} className={css.spin} aria-hidden="true" />Putting the groups in order…</p>;
  const p = guide.progress;
  const row = guide.queue.find((q) => q.id === current) ?? null;
  const g = d?.group ?? (current ? byId.get(current) : undefined) ?? null;
  const next = guide.queue.filter((q) => !q.reviewedAt && q.id !== current).slice(0, 6);
  const lastDone = guide.queue.filter((q) => q.reviewedAt).sort((a, b) => String(b.reviewedAt).localeCompare(String(a.reviewedAt)))[0];
  const work = d?.suggestions.filter((s) => s.kind === "task" || s.kind === "approval") ?? [];
  const linkSug = d?.suggestions.filter((s) => s.kind === "link_project" || s.kind === "link_client") ?? [];
  const needsLink = !!g && g.kind === "client" && (!g.clientId || !g.projectId);
  return <section className={css.guide} aria-label="Guided review" data-guide="">
    <div className={css.guideCard}>
      {!g || !row ? <div className={css.empty}><CheckCircle2 size={28} aria-hidden="true" /><h2>Every imported group is reviewed</h2>
        <p>{p.done.toLocaleString("en-IN")} groups and {p.messages.done.toLocaleString("en-IN")} imported messages are in place. New imports join this queue.</p></div> : <>
        <div className={css.guideHead}>
          <GroupMark g={g} size={44} />
          <span><h3 title={g.name}>{displayName(g.name)}</h3>
            <span className={css.why}>{[TIER[row.tier], row.days === null ? null : row.days === 0 ? "active today" : `last message ${ago(g.lastAt).toLowerCase()}`,
              `${row.imported.toLocaleString("en-IN")} imported messages`, g.period ? monthLabel(g.period) : null, row.reviewedAt ? `reviewed by ${row.reviewedBy ?? "someone"}` : null].filter(Boolean).join(" · ")}</span></span>
          <button type="button" className={css.linkBtn} onClick={() => onOpen(g.id)}>Open group</button>
        </div>
        <div className={css.step} data-step="link">
          <h4><span className={css.stepNum} data-done={!needsLink || undefined}>{needsLink ? 1 : <CheckCircle2 size={14} aria-hidden="true" />}</span>Link it</h4>
          {needsLink ? <ul className={css.queue}><LinkRow g={g} sug={linkSug} data={data} onOpen={onOpen} refresh={refresh} say={say} /></ul>
            : <p className={css.small}>{g.kind === "client" ? <>Linked to <b>{g.project}</b>{g.client ? <> · client <b>{g.client}</b></> : null}. Change it under Open group → Brief.</> : <>{KIND[g.kind ?? "other"]} group: no project to link.</>}</p>}
        </div>
        <div className={css.step} data-step="senders">
          <h4><span className={css.stepNum} data-done={(d && !d.unmapped.length) || undefined}>{d && !d.unmapped.length ? <CheckCircle2 size={14} aria-hidden="true" /> : 2}</span>Who is this?</h4>
          {!d ? <p className={css.loading}><Loader2 size={15} className={css.spin} aria-hidden="true" />Loading…</p>
            : d.unmapped.length ? <SenderList rows={d.unmapped.map((u) => ({ ...u, channelId: g.id }))} data={data} refresh={refresh} say={say} disabled={!d.canManage} />
            : <p className={css.small}>Every sender of its history is someone in Pulse.</p>}
        </div>
        <div className={css.step} data-step="work">
          <h4><span className={css.stepNum} data-done={(d && !work.length && !scanning) || undefined}>{d && !work.length && !scanning ? <CheckCircle2 size={14} aria-hidden="true" /> : 3}</span>Tasks and approvals from the history</h4>
          {scanning ? <p className={css.loading}><Loader2 size={15} className={css.spin} aria-hidden="true" />Reading the history for requests and approvals…</p>
            : !d ? null : work.length ? <SuggestionList rows={work} data={data} refresh={refresh} say={say} />
            : <div className={css.laneBar}><span className={css.small}>Nothing open found{g.member || data.canLead ? "" : " (only its members read its history)"}. Make a task or dismiss each one as it comes.</span>
              <button type="button" className={css.ghostBtn} onClick={async () => { setScanning(true); try { const r = await send<{ added: number; note?: string }>(`chats/hub/groups/${g.id}/scan`); say(r.note ?? `${r.added} new`); await refresh(); } catch (e) { say((e as Error).message, "error"); } finally { setScanning(false); } }}>
                <ScanSearch size={15} aria-hidden="true" />Look again</button></div>}
        </div>
        <div className={css.guideFoot}>
          <span className={css.small}>{[needsLink ? "not linked yet" : null, d?.unmapped.length ? `${d.unmapped.length} sender${d.unmapped.length === 1 ? "" : "s"} unknown` : null, work.length ? `${work.length} to decide` : null].filter(Boolean).join(" · ") || "All in place"}</span>
          <span>
            {row.reviewedAt ? <button type="button" className={css.ghostBtn} disabled={busy} onClick={() => void mark("open")}><Undo2 size={15} aria-hidden="true" />Open again</button>
              : <button type="button" className={css.ghostBtn} disabled={busy} onClick={() => void mark("later")} data-later=""><Clock3 size={15} aria-hidden="true" />Later</button>}
            <button type="button" className={css.primary} disabled={busy} onClick={() => void mark("reviewed")} data-done-next="">{busy ? <Loader2 size={15} className={css.spin} aria-hidden="true" /> : null}Done, next<ArrowRight size={15} aria-hidden="true" /></button>
          </span>
        </div>
      </>}
    </div>
    <aside className={css.guideSide} aria-label="Progress">
      <div><h4><Compass size={12} aria-hidden="true" /> Progress</h4>
        <div className={css.tierRow}><b>{p.done.toLocaleString("en-IN")} of {p.total.toLocaleString("en-IN")} groups</b><span className={css.muted}>{pct(p.done, p.total)}</span>
          <div className={css.progress}><span style={{ width: pct(p.done, p.total) }} /></div></div>
        <p className={css.small}>{p.messages.done.toLocaleString("en-IN")} of {p.messages.total.toLocaleString("en-IN")} imported messages · {p.today} today{p.daysLeft !== null ? ` · about ${p.daysLeft} day${p.daysLeft === 1 ? "" : "s"} left at this pace` : ""}</p></div>
      <div>{(["active", "client", "other"] as const).filter((t) => p.tiers[t]?.total).map((t) => <div key={t} className={css.tierRow} data-tier={t}>
        <span>{TIER[t]}</span><span className={css.muted}>{p.tiers[t].done}/{p.tiers[t].total}</span><div className={css.progress}><span style={{ width: pct(p.tiers[t].done, p.tiers[t].total) }} /></div></div>)}</div>
      {next.length ? <div><h4>Next up</h4><ul className={css.nextList}>{next.map((q) => { const x = byId.get(q.id); return <li key={q.id}>
        <button type="button" onClick={() => setCurrent(q.id)}>{x ? <GroupMark g={x} size={24} /> : null}<span>{x ? displayName(x.name) : "Group"}</span>{q.later ? <span className={css.muted}>later</span> : null}</button></li>; })}</ul></div> : null}
      {lastDone && lastDone.id !== current ? <button type="button" className={css.linkBtn} onClick={() => setCurrent(lastDone.id)}><Undo2 size={13} aria-hidden="true" />Back to the last one done</button> : null}
    </aside>
  </section>;
}
