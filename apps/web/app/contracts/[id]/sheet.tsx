"use client";
// AGREEMENTS round 4 (owner, 15 Nov 2026: "a Schedule / detailed sheet per client"): on a draft agreement, the blanks no
// quotation filled (users, support hours, start and review dates, what the client provides, notice, the court's city …)
// as one short form, each with its name and an example. Save puts the answers into the words (the same route as Change
// the words), so the agreement can be sent; a blank left empty stays visible and still stops sending.
import { useState, type FormEvent } from "react";
import { blankLabel, blanksIn, fillAgreement, SHEET_BLANKS } from "@pulse/invoice-doc/browser";
import { post } from "../../orgs/client";
import { toast } from "../../kit/game";
import css from "../contracts.module.css";

const HINT = new Map(SHEET_BLANKS.map((b) => [b.key, b.hint]));
const say = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";

export function DetailedSheet({ base, title, body, onDone }: { base: string; title: string; body: string; onDone: () => void }) {
  const keys = blanksIn(body);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!keys.length) return null;
  const filled = keys.filter((k) => values[k]?.trim()).length;
  async function save(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    const answers = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
    try {
      await post(`${base}/words`, { title, body: fillAgreement(body, answers) });
      toast(filled === keys.length ? "The detailed sheet is filled in. You can send it now." : `Saved. ${keys.length - filled} still to fill in.`);
      setValues({}); onDone();
    } catch (x) { setError(say(x)); } finally { setBusy(false); }
  }
  return <form className={`${css.panel} ${css.form}`} onSubmit={save} aria-label="Fill the detailed sheet">
    <h2>Fill the detailed sheet</h2>
    <p className={css.hint}>{`${keys.length === 1 ? "One thing" : `${keys.length} things`} the quotation did not say. They go into the agreement's words; it cannot be sent with a gap.`}</p>
    <div className={css.row}>
      {keys.map((k) => <label key={k} className={css.field}>{blankLabel(k)}
        <input value={values[k] ?? ""} onChange={(e) => setValues({ ...values, [k]: e.target.value })} placeholder={HINT.get(k) ?? ""} maxLength={300} />
      </label>)}
    </div>
    {error ? <p className={css.error} role="alert">{error}</p> : null}
    <div className={css.actions}>
      <button type="submit" className={`${css.btn} ${css.primary}`} disabled={busy || !filled}>{busy ? "Saving…" : filled === keys.length ? "Save the sheet" : `Save ${filled} of ${keys.length}`}</button>
    </div>
  </form>;
}
