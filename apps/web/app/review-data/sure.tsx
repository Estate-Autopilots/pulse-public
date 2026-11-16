"use client";
// SETTINGS-APPLE (owner, 13 Nov 2026, T1.3.3: "the company's Claude should give confidence, so a person only checks the
// doubtful ones"): the sure ones, accepted together. Pressing the button starts a short count-down with Undo; nothing is
// saved until it ends (accepting merges, moves and fills records, so the safe undo is not saving yet). Then the same
// review-data/decide every single Accept uses, 600 at a time, and a small celebration.
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { CheckCheck, ScanSearch, Sparkles, Undo2 } from "lucide-react";
import { post } from "../records";
import { ProgressRing, celebrate, toast } from "../kit/game";
import css from "./review.module.css";

const WAIT = 8;

export function SureCard({ ids, count, percent, checked, total, needYou, canDecide }: { ids: string[]; count: number; percent: number; checked: number; total: number; needYou: number; canDecide: boolean }) {
  const router = useRouter();
  const [left, setLeft] = useState<number | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const button = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  // Leaving the page during the count-down accepts nothing.
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);
  function begin() {
    let n = WAIT; setLeft(n);
    timer.current = setInterval(() => {
      n -= 1;
      if (n > 0) { setLeft(n); return; }
      if (timer.current) clearInterval(timer.current);
      timer.current = null; setLeft(null); void accept();
    }, 1000);
  }
  function undo() { if (timer.current) clearInterval(timer.current); timer.current = null; setLeft(null); toast("Undone. Nothing was accepted."); }
  async function accept() {
    setBusy(true); setError("");
    let done = 0;
    try {
      for (let i = 0; i < ids.length; i += 600) { const r = await post<{ count: number }>("review-data/decide", { ids: ids.slice(i, i + 600), action: "accept" }); done += r.count; }
      celebrate(button.current, { big: done >= 50 });
      toast(`${done.toLocaleString("en-IN")} accepted. Thank you!`);
      router.refresh();
    } catch (e) { setError(`${done ? `${done.toLocaleString("en-IN")} accepted, then: ` : ""}${e instanceof Error ? e.message : "That did not save. Try again."}`); router.refresh(); }
    finally { setBusy(false); }
  }
  // The ring says what the line beside it says (judge: "0% done" beside "Your AI checked 1,240 of 1,284" read as a
  // contradiction): how much the AI has checked once it has started, how much is decided before that.
  const share = checked && total ? Math.round((checked / total) * 100) : percent;
  // The parts add up to the total (judge: "1,102 + 182 = 1,284, yet 1,240 checked"): sure, doubtful, not checked yet.
  const unchecked = Math.max(0, total - checked), doubt = Math.max(0, needYou - unchecked);
  return <section className={css.sure} aria-label="Sure ones">
    {/* Nothing checked or decided yet: a calm icon, not a discouraging "0% done" ring (judge). */}
    {share ? <ProgressRing value={share / 100} size={76} stroke={9} label={checked ? `Your AI checked ${share}%` : `${share}% of suggestions decided`}><span className={css.sureRing}><b>{share}%</b><small>{checked ? "checked" : "done"}</small></span></ProgressRing>
      : <span className={css.sureIcon} aria-hidden="true"><ScanSearch size={30} /></span>}
    <div className={css.sureText}>
      <b>{checked ? `Your AI checked ${checked.toLocaleString("en-IN")} of ${total.toLocaleString("en-IN")}.` : `${total.toLocaleString("en-IN")} suggestions waiting.`}</b>
      {/* Before the AI has checked, "987 waiting. 987 need you." said one thing twice (judge): say only what is next. */}
      <span>{!checked ? "Your company's AI has not checked them yet." : <>{count ? `${count.toLocaleString("en-IN")} look right. ` : ""}{doubt ? `${doubt.toLocaleString("en-IN")} need you.` : "None need you."}
        {unchecked ? ` ${unchecked.toLocaleString("en-IN")} not checked yet.` : ""}</>}</span>
      {error ? <span role="alert" className={css.sureError}>{error}</span> : null}
    </div>
    {canDecide && count ? left !== null ? <div className={css.sureCount} role="status">
      <span>Accepting {ids.length.toLocaleString("en-IN")} in {left}…</span>
      <button type="button" className={css.undo} onClick={undo}><Undo2 size={16} aria-hidden="true" />Undo</button>
    </div> : <button ref={button} type="button" className={css.sureGo} disabled={busy} onClick={begin}>
      {busy ? <><Sparkles size={17} aria-hidden="true" />Accepting…</> : <><CheckCheck size={17} aria-hidden="true" />Accept {ids.length.toLocaleString("en-IN")} sure {ids.length === 1 ? "one" : "ones"}</>}
    </button> : null}
  </section>;
}
