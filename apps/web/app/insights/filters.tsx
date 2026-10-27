"use client";
// INSIGHTS-2 (1082): the filters every Insights tab shares, kept in the URL (period, pod, segment, client), so a refresh
// or a shared link opens the same view and switching tabs keeps them.
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CalendarRange, ChevronDown, Filter, X } from "lucide-react";
import { PERIODS, type Facts } from "./facts";
import s from "./insights2.module.css";

export function FilterBar({ facets, groups }: { facets: Facts["facets"] | null; groups: number | null }) {
  const router = useRouter(), path = usePathname(), sp = useSearchParams();
  const set = (k: string, val: string) => {
    const p = new URLSearchParams(sp.toString());
    if (val && val !== "all") p.set(k, val); else p.delete(k);
    p.delete("offset");
    router.push(`${path}?${p.toString()}`, { scroll: false });
  };
  const cur = (k: string) => sp.get(k) ?? "";
  const active = ["period", "pod", "segment", "client"].filter((k) => cur(k) && cur(k) !== "all");
  const clear = () => { const p = new URLSearchParams(sp.toString()); for (const k of active) p.delete(k); router.push(`${path}?${p.toString()}`, { scroll: false }); };
  const pods = facets?.pods ?? [], segs = facets?.segments ?? [], clients = facets?.clients ?? [];
  return <div className={s.filters} role="group" aria-label="Filters for every tab">
    <label className={s.filter} data-on={cur("period") && cur("period") !== "all" ? "" : undefined}><CalendarRange size={14} aria-hidden="true" />
      <select aria-label="Period" value={cur("period") || "all"} onChange={(e) => set("period", e.target.value)}>{PERIODS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select><ChevronDown size={13} aria-hidden="true" className={s.chev} /></label>
    {pods.length > 1 ? <label className={s.filter} data-on={cur("pod") ? "" : undefined}><Filter size={14} aria-hidden="true" />
      <select aria-label="Pod" value={cur("pod")} onChange={(e) => set("pod", e.target.value)}><option value="">Every pod</option>
        {pods.map((p) => <option key={p.key} value={p.key}>{p.key === "none" ? "No clear pod" : p.key} ({p.n})</option>)}</select><ChevronDown size={13} aria-hidden="true" className={s.chev} /></label> : null}
    {segs.length > 1 ? <label className={s.filter} data-on={cur("segment") ? "" : undefined}>
      <select aria-label="Segment" value={cur("segment")} onChange={(e) => set("segment", e.target.value)}><option value="">Every segment</option>
        {segs.map((p) => <option key={p.key} value={p.key}>{p.key === "none" ? "No segment" : p.key} ({p.n})</option>)}</select><ChevronDown size={13} aria-hidden="true" className={s.chev} /></label> : null}
    {clients.length > 1 ? <label className={s.filter} data-on={cur("client") ? "" : undefined}>
      <select aria-label="Client" value={cur("client")} onChange={(e) => set("client", e.target.value)}><option value="">Every client</option>
        {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select><ChevronDown size={13} aria-hidden="true" className={s.chev} /></label> : null}
    {active.length ? <button type="button" className={s.clear} onClick={clear}><X size={13} aria-hidden="true" />Clear{typeof groups === "number" ? ` · ${groups.toLocaleString("en-IN")} groups shown` : ""}</button> : null}
  </div>;
}
