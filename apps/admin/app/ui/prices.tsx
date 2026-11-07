"use client";
// PULSE-ADMIN: the AI price table (rupees per million tokens in and out, per engine; "*" prices any other engine).
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import css from "./console.module.css";
import { kitStyles } from "./kit";

export type Price = { engine: string; inPerM: number; outPerM: number; note: string | null; updatedAt: string; updatedBy: string | null };

async function send(body: unknown) {
  const r = await fetch("/api/platform/ai-prices", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error ?? "Not saved");
}

export function PriceTable({ prices, engines }: { prices: Price[]; engines: string[] }) {
  const router = useRouter();
  const [v, setV] = useState({ engine: "", inPerM: "", outPerM: "", note: "" });
  const [busy, setBusy] = useState(""), [error, setError] = useState("");
  const unpriced = engines.filter((e) => !prices.some((p) => p.engine === e));
  async function save(e: FormEvent) {
    e.preventDefault(); setBusy("save"); setError("");
    try { await send(v); setV({ engine: "", inPerM: "", outPerM: "", note: "" }); router.refresh(); }
    catch (x) { setError(x instanceof Error ? x.message : "Not saved"); } finally { setBusy(""); }
  }
  async function remove(engine: string) {
    setBusy(engine); setError("");
    try { await send({ engine, remove: true }); router.refresh(); }
    catch (x) { setError(x instanceof Error ? x.message : "Not removed"); } finally { setBusy(""); }
  }
  return <div>
    {prices.length ? <div className={kitStyles.tableWrap}><table className={kitStyles.table} aria-label="AI prices">
      <thead><tr><th>Engine</th><th data-num="">₹ per million in</th><th data-num="">₹ per million out</th><th>Note</th><th /></tr></thead>
      <tbody>{prices.map((p) => <tr key={p.engine}>
        <td><code className={css.code}>{p.engine === "*" ? "* (any other)" : p.engine}</code></td>
        <td data-num="">{Number(p.inPerM).toLocaleString("en-IN")}</td><td data-num="">{Number(p.outPerM).toLocaleString("en-IN")}</td>
        <td>{p.note ?? "—"}{p.updatedBy ? <span className={css.sub}>{p.updatedBy}</span> : null}</td>
        <td><button type="button" className={kitStyles.button} data-variant="ghost" disabled={!!busy} onClick={() => void remove(p.engine)}>{busy === p.engine ? "Removing…" : "Remove"}</button></td>
      </tr>)}</tbody></table></div> : <p className={css.note}>No prices yet: AI spend shows tokens only.</p>}
    <form className={css.form} onSubmit={save}>
      <div className={css.grid}>
        <label className={kitStyles.field}>Engine<input list="pulse-engines" value={v.engine} onChange={(e) => setV({ ...v, engine: e.target.value })} required maxLength={80} placeholder="e.g. server:codex, or *" /></label>
        <label className={kitStyles.field}>₹ per million in<input inputMode="decimal" value={v.inPerM} onChange={(e) => setV({ ...v, inPerM: e.target.value })} required /></label>
        <label className={kitStyles.field}>₹ per million out<input inputMode="decimal" value={v.outPerM} onChange={(e) => setV({ ...v, outPerM: e.target.value })} required /></label>
        <label className={kitStyles.field}>Note<input value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} maxLength={200} placeholder="Where the price comes from" /></label>
      </div>
      <datalist id="pulse-engines">{["*", ...engines].map((e) => <option key={e} value={e} />)}</datalist>
      {unpriced.length ? <p className={css.note}>Used but not priced: {unpriced.map((e) => <code key={e} className={css.code}>{e} </code>)}</p> : null}
      <div className={css.row}><button className={kitStyles.button} data-variant="primary" disabled={busy === "save"}>{busy === "save" ? "Saving…" : "Save price"}</button></div>
      {error ? <p role="alert" className={css.error}>{error}</p> : null}
    </form>
  </div>;
}
