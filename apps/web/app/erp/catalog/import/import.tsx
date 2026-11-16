"use client";
// GROWTH-LOOP slice 5: "Import a price list" (Codex concept 1: your columns → Vitals fields, the preview under them).
// 1 Upload: a CSV, TSV or Excel file, a Google Sheets link, or a pasted table. 2 Match columns: each column of theirs
// with a guessed field (or Not used), the first rows as they will be imported, and the plan from the server's dry run
// ("42 new · 6 updated · 2 skipped"). 3 Done: what changed, with Undo. Past imports stay listed with their own Undo.
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Check, FileSpreadsheet, Link2, RotateCcw, Upload } from "lucide-react";
import { FIELDS, fromSheet, guessMapping, hasHeader, mapRows, parseTable, planLine, rupees, type FieldKey, type Mapping, type Plan } from "../../../lib/catalog-import.mjs";
import css from "./import.module.css";

export type PastImport = { id: string; fileName: string | null; createdAt: string; created: number; updated: number; unchanged: number; skipped: number; undoneAt: string | null; by: string | null };
type Row = { name: string; unit: string; price: number; gstRate: number; sac: string | null; category: string | null };
type Change = { action: "created" | "updated"; name?: string; before: Row | null; after: Row };
type Result = Plan & { batch?: string; changes: Change[] };

async function call<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api/v0/${path}`, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof data?.error === "string" ? data.error : "That did not work. Try again.");
  return data as T;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const when = (iso: string) => { const d = new Date(Date.parse(iso) + 330 * 60000); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`; };

function Steps({ at }: { at: 1 | 2 | 3 }) {
  return <ol className={css.steps} aria-label="Steps">{["Upload", "Match columns", "Check and import"].map((s, i) =>
    <li key={s} data-on={i + 1 === at ? "" : undefined} data-done={i + 1 < at ? "" : undefined} aria-current={i + 1 === at ? "step" : undefined}><span>{i + 1 < at ? <Check size={14} aria-hidden="true" /> : i + 1}</span>{s}</li>)}</ol>;
}

function Changes({ changes }: { changes: Change[] }) {
  if (!changes.length) return null;
  return <div className={css.tableWrap}><table className={css.table}>
    <thead><tr><th scope="col">What happened</th><th scope="col">Name</th><th scope="col">Unit</th><th scope="col">Rate</th><th scope="col">GST %</th><th scope="col">HSN/SAC</th><th scope="col">Category</th></tr></thead>
    <tbody>{changes.map((c, i) => {
      const was = (show: (r: Row) => string) => c.before && show(c.before) !== show(c.after) ? <><s>{show(c.before) || "–"}</s> {show(c.after) || "–"}</> : show(c.after) || "–";
      return <tr key={i}><td><span className={css.tag} data-kind={c.action}>{c.action === "created" ? "New" : "Changed"}</span></td>
        <td>{was((r) => r.name)}</td><td>{was((r) => r.unit)}</td><td className={css.num}>{was((r) => rupees(r.price))}</td>
        <td className={css.num}>{was((r) => `${r.gstRate}%`)}</td><td>{was((r) => r.sac ?? "")}</td><td>{was((r) => r.category ?? "")}</td></tr>;
    })}</tbody>
  </table></div>;
}

export function ImportPriceList({ past: first }: { past: PastImport[] }) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [fileName, setFileName] = useState<string | null>(null);
  const [table, setTable] = useState<string[][]>([]);
  const [header, setHeader] = useState(true);
  const [map, setMap] = useState<Mapping | null>(null);
  const [paste, setPaste] = useState(""), [sheet, setSheet] = useState("");
  const [plan, setPlan] = useState<Result | null>(null), [done, setDone] = useState<Result | null>(null);
  const [busy, setBusy] = useState<string | null>(null), [problem, setProblem] = useState<string | null>(null);
  const [past, setPast] = useState(first), [undone, setUndone] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const cols = useMemo(() => (header ? table[0] ?? [] : (table[0] ?? []).map((_, i) => `Column ${i + 1}`)), [table, header]);
  const body = useMemo(() => (header ? table.slice(1) : table), [table, header]);
  const rows = useMemo(() => (map ? mapRows(body, map) : []), [body, map]);

  const load = (t: string[][], name: string | null) => {
    if (t.length < 1 || (t.length < 2 && hasHeader(t))) { setProblem("We could not find any rows in that. Check it has one item per row."); return; }
    const h = hasHeader(t);
    setTable(t); setHeader(h); setFileName(name); setMap(guessMapping(h ? t[0] : t[0].map((_, i) => `Column ${i + 1}`), (h ? t.slice(1) : t).slice(0, 20)));
    setPlan(null); setProblem(null); setStep(2);
  };
  const fromFile = async (f: File) => {
    setBusy("file"); setProblem(null);
    try {
      if (/\.(xlsx|xlsm)$/i.test(f.name)) {
        const read = (await import("read-excel-file/browser")).default as unknown as (input: Blob) => Promise<{ data?: unknown[][] }[] | unknown[][]>;
        const out = await read(f);
        const first = Array.isArray(out) && out.length && !Array.isArray(out[0]) ? (out[0] as { data?: unknown[][] }).data ?? [] : out as unknown[][];
        load(fromSheet(first), f.name);
      } else if (/\.(csv|tsv|txt)$/i.test(f.name) || f.type.startsWith("text/")) load(parseTable(await f.text()), f.name);
      else setProblem("Use an Excel (.xlsx), CSV or TSV file. From Google Sheets: paste its link, or File → Download → CSV.");
    } catch { setProblem("We could not read that file. Save it as .xlsx or CSV and try again."); }
    finally { setBusy(null); }
  };
  const fromSheetLink = async () => {
    setBusy("sheet"); setProblem(null);
    try { const r = await call<{ csv: string }>("erp/catalog/sheet", { url: sheet.trim() }); load(parseTable(r.csv), "Google Sheet"); }
    catch (e) { setProblem((e as Error).message); } finally { setBusy(null); }
  };

  // Each change of the matching asks the server what would happen (nothing is written on a dry run).
  useEffect(() => {
    if (step !== 2 || !map || map.name < 0 || map.rate < 0) return;
    let live = true;
    const t = setTimeout(() => {
      void call<Result>("erp/catalog/import", { rows, dryRun: true, fileName }).then((p) => { if (live) setPlan(p); }).catch((e) => { if (live) setProblem((e as Error).message); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [step, map, rows, fileName]);

  const run = async () => {
    setBusy("import"); setProblem(null);
    try {
      const r = await call<Result>("erp/catalog/import", { rows, fileName });
      setDone(r); setStep(3);
      const list = await call<{ imports: PastImport[] }>("erp/catalog/imports"); setPast(list.imports);
    } catch (e) { setProblem((e as Error).message); } finally { setBusy(null); }
  };
  const undo = async (id: string) => {
    setBusy(`undo-${id}`); setProblem(null);
    try {
      const r = await call<{ archived: number; restored: number; left: string[] }>(`erp/catalog/imports/${id}/undo`, {});
      setUndone(`Undone: ${r.archived} new ${r.archived === 1 ? "item" : "items"} archived, ${r.restored} put back as they were.${r.left.length ? ` Left as they are (changed since): ${r.left.slice(0, 5).join(", ")}${r.left.length > 5 ? "…" : ""}.` : ""}`);
      const list = await call<{ imports: PastImport[] }>("erp/catalog/imports"); setPast(list.imports);
    } catch (e) { setProblem((e as Error).message); } finally { setBusy(null); }
  };
  const setField = (col: number, key: FieldKey | "") => setMap((m) => {
    if (!m) return m;
    const next = { ...m };
    for (const f of FIELDS) if (next[f.key] === col) next[f.key] = -1;
    if (key) next[key] = col;
    return next;
  });
  const fieldOf = (col: number) => FIELDS.find((f) => map?.[f.key] === col)?.key ?? "";
  const missing = map ? FIELDS.filter((f) => f.need && map[f.key] < 0) : [];
  const importable = plan ? plan.created + plan.updated : 0;

  return <div className={css.root}>
    <Steps at={step} />
    {problem ? <p className={css.problem} role="alert">{problem}</p> : null}
    {undone ? <p className={css.ok} role="status">{undone}</p> : null}

    {step === 1 ? <>
      <section className={css.card} aria-labelledby="up-title">
        <h2 id="up-title">Bring your price list</h2>
        <p className={css.lead}>One item per row. Columns like name, unit, rate, GST %, HSN/SAC and category. You check everything before it is added.</p>
        <div className={css.ways}>
          <div className={css.way}>
            <FileSpreadsheet size={22} aria-hidden="true" /><b>A file</b><span>Excel (.xlsx), CSV or TSV</span>
            <input ref={fileRef} type="file" accept=".xlsx,.xlsm,.csv,.tsv,.txt,text/csv" className={css.hidden} onChange={(e) => { const f = e.target.files?.[0]; if (f) void fromFile(f); e.target.value = ""; }} />
            <button type="button" className={css.primary} onClick={() => fileRef.current?.click()} disabled={!!busy}><Upload size={16} aria-hidden="true" />{busy === "file" ? "Reading…" : "Choose a file"}</button>
          </div>
          <div className={css.way}>
            <Link2 size={22} aria-hidden="true" /><b>A Google Sheet</b><span>Shared as “Anyone with the link”</span>
            <label className={css.field}><span className={css.sr}>Google Sheets link</span><input value={sheet} onChange={(e) => setSheet(e.target.value)} placeholder="https://docs.google.com/spreadsheets/…" inputMode="url" /></label>
            <button type="button" className={css.secondary} onClick={() => void fromSheetLink()} disabled={!!busy || !sheet.trim()}>{busy === "sheet" ? "Reading…" : "Read the sheet"}</button>
          </div>
        </div>
        <label className={css.paste}><b>Or paste a table</b><span>Copy the rows from a sheet or a doc, with the header row</span>
          <textarea value={paste} onChange={(e) => setPaste(e.target.value)} rows={5} placeholder={"Service\tPer\tPrice\tGST\nReel edit\tper video\t4500\t18%"} /></label>
        <button type="button" className={css.secondary} onClick={() => load(parseTable(paste), "Pasted table")} disabled={!paste.trim()}>Use this table</button>
      </section>
      {past.length ? <section className={css.card} aria-labelledby="past-title">
        <h2 id="past-title">Earlier imports</h2>
        <ul className={css.past}>{past.map((p) => <li key={p.id}>
          <div><b>{p.fileName ?? "Import"}</b><span>{when(p.createdAt)}{p.by ? ` · ${p.by}` : ""} · {p.created} new · {p.updated} changed{p.skipped ? ` · ${p.skipped} skipped` : ""}</span></div>
          {p.undoneAt ? <span className={css.muted}>Undone</span> : <button type="button" className={css.secondary} onClick={() => void undo(p.id)} disabled={!!busy}><RotateCcw size={14} aria-hidden="true" />{busy === `undo-${p.id}` ? "Undoing…" : "Undo"}</button>}
        </li>)}</ul>
      </section> : null}
    </> : null}

    {step === 2 && map ? <>
      <section className={css.card} aria-labelledby="match-title">
        <div className={css.head}><h2 id="match-title">Match your columns</h2><span className={css.muted}>{fileName} · {body.length} {body.length === 1 ? "row" : "rows"}</span></div>
        <label className={css.check}><input type="checkbox" checked={header} onChange={(e) => { setHeader(e.target.checked); }} /> The first row is the column names</label>
        <ul className={css.match}>{cols.map((c, i) => <li key={i}>
          <span className={css.theirs}>{c || `Column ${i + 1}`}{fieldOf(i) ? <em>guessed</em> : null}</span>
          <ArrowRight size={16} aria-hidden="true" className={css.arrow} />
          <label><span className={css.sr}>Field for {c || `column ${i + 1}`}</span>
            <select value={fieldOf(i)} onChange={(e) => setField(i, e.target.value as FieldKey | "")}>
              <option value="">Not used</option>{FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
            </select></label>
        </li>)}</ul>
        {missing.length ? <p className={css.problem}>Pick a column for {missing.map((f) => f.label).join(" and ")}.</p> : null}
      </section>
      <section className={css.card} aria-labelledby="prev-title">
        <h2 id="prev-title">Preview · first 5 rows</h2>
        <div className={css.tableWrap}><table className={css.table}>
          <thead><tr>{FIELDS.map((f) => <th key={f.key} scope="col">{f.label}</th>)}</tr></thead>
          <tbody>{rows.slice(0, 5).map((r, i) => <tr key={i}>{FIELDS.map((f) => <td key={f.key}>{r[f.key] || "–"}</td>)}</tr>)}</tbody>
        </table></div>
        {plan?.skipped.length ? <details className={css.skipped}><summary>{plan.skipped.length} {plan.skipped.length === 1 ? "row is" : "rows are"} skipped. See why</summary>
          <ul>{plan.skipped.slice(0, 50).map((s) => <li key={s.row}>Row {s.row}{s.name ? ` (${s.name})` : ""}: {s.why}</li>)}</ul></details> : null}
      </section>
      <div className={css.bar}>
        <button type="button" className={css.link} onClick={() => setStep(1)}>Back</button>
        <span className={css.plan} role="status">{plan ? planLine(plan) : missing.length ? "" : "Checking…"}</span>
        <button type="button" className={css.primary} onClick={() => void run()} disabled={!!busy || !plan || importable === 0 || missing.length > 0}>
          {busy === "import" ? "Importing…" : importable ? `Import ${importable} ${importable === 1 ? "item" : "items"}` : "Nothing new to import"}</button>
      </div>
    </> : null}

    {step === 3 && done ? <section className={css.card} aria-labelledby="done-title">
      <h2 id="done-title"><Check size={20} aria-hidden="true" className={css.tick} /> Imported</h2>
      <p className={css.lead}>{planLine(done)}. Here is what changed.</p>
      <Changes changes={done.changes} />
      <div className={css.bar}>
        {done.batch ? <button type="button" className={css.secondary} onClick={() => void undo(done.batch!).then(() => setStep(1))} disabled={!!busy}><RotateCcw size={14} aria-hidden="true" />Undo this import</button> : null}
        <Link className={css.primary} href="/erp/catalog">Open the catalogue</Link>
      </div>
    </section> : null}
  </div>;
}
