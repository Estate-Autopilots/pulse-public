"use client";
// PM-BUILD-4 (2522): leadership sets one person's load benchmark (healthy range and "review above", in units). Clearing
// all three goes back to the template's range; every change is logged.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { notify } from "@pulse/ui-shell";
import { post } from "../records";
import { styles } from "../ui";
import { Drawer, DrawerFooter } from "../kit";

export function BenchmarkEdit({ person, name, current, fallback }: { person: string; name: string; current: { healthy: [number, number]; reviewAbove: number } | null; fallback: { healthy: [number, number]; max: number } }) {
  const router = useRouter();
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const [lo, setLo] = useState(String(current?.healthy[0] ?? fallback.healthy[0])), [hi, setHi] = useState(String(current?.healthy[1] ?? fallback.healthy[1]));
  const [rev, setRev] = useState(String(current?.reviewAbove ?? fallback.max));
  const save = async (clear = false) => {
    setBusy(true);
    try {
      await post(`projects/load-benchmark/${person}`, clear ? { low: null, high: null, reviewAbove: null } : { low: lo, high: hi, reviewAbove: rev });
      notify({ id: "bench", tone: "success", title: clear ? `${name}: back to the template's range` : `${name}: benchmark saved`, timeout: 2500 }); setOpen(false); router.refresh();
    } catch (e) { notify({ id: "bench", tone: "error", title: "Not saved", message: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(false); }
  };
  return <>
    <button type="button" className={`${styles.btn} ${styles.btnSmall}`} style={{ marginLeft: "auto" }} onClick={() => setOpen(true)} aria-label={`Set ${name}'s benchmark`}>Benchmark</button>
    {open ? <Drawer title={`${name}'s load benchmark`} onClose={() => setOpen(false)} size="md"
      footer={<DrawerFooter primary={<button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => void save()} disabled={busy}>{busy ? "Saving…" : "Save"}</button>}>
        {current ? <button type="button" className={styles.btn} onClick={() => void save(true)} disabled={busy}>Use the usual range</button> : <button type="button" className={styles.btn} onClick={() => setOpen(false)}>Cancel</button>}
      </DrawerFooter>}>
      <p>How much project work suits {name} at once. Projects count by size: a big project counts as 1. Only leadership changes this, and every change is saved.</p>
      <label className={styles.field}>Healthy load from<input className={styles.input} inputMode="decimal" value={lo} onChange={(e) => setLo(e.target.value)} /></label>
      <label className={styles.field}>Healthy load up to<input className={styles.input} inputMode="decimal" value={hi} onChange={(e) => setHi(e.target.value)} /></label>
      <label className={styles.field}>Too much above<input className={styles.input} inputMode="decimal" value={rev} onChange={(e) => setRev(e.target.value)} /></label>
    </Drawer> : null}
  </>;
}
