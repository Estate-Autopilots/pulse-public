"use client";
// WORKFLOW BUILDER: a new board (its first tab starts from a lead), and the live "waiting for you" list.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { LayoutGrid } from "lucide-react";
import { Drawer, DrawerFooter, DrawerSection } from "../kit";
import { post } from "../records";
import { styles } from "../ui";
import { WaitingList } from "./waiting";
import type { WaitingItem } from "./board-types";
import css from "./blocks.module.css";

const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";

export function NewBoard() {
  const router = useRouter(); const [open, setOpen] = useState(false);
  const [name, setName] = useState(""), [purpose, setPurpose] = useState(""), [first, setFirst] = useState("Sales"), [role, setRole] = useState("Sales");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function make() {
    setBusy(true); setError("");
    try { const r = await post<{ id: string }>("workflows/boards", { name, purpose: purpose || null, firstTab: first, role: role || null }); router.push(`/sops/boards/${r.id}`); }
    catch (e) { setError(msg(e)); setBusy(false); }
  }
  return <>
    <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => setOpen(true)}><LayoutGrid size={14} aria-hidden="true" />New board</button>
    {open ? <Drawer title="New board" help="A board puts each person's workflow in a tab, built from blocks you connect, and joins them with hand-offs." onClose={() => setOpen(false)} size="sm"
      footer={<DrawerFooter status={error}><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !name.trim() || !first.trim()} onClick={() => void make()}>Make the board</button></DrawerFooter>}>
      <DrawerSection>
        <label className={css.field}><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} placeholder="Quote to install" data-autofocus="" /></label>
        <label className={css.field}><span>What it is for (optional)</span><textarea rows={2} value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={2000} /></label>
      </DrawerSection>
      <DrawerSection title="The first tab">
        <div className={css.row2}><label className={css.field}><span>Name</span><input value={first} onChange={(e) => setFirst(e.target.value)} maxLength={200} /></label>
          <label className={css.field}><span>Whose job (a role)</span><input value={role} onChange={(e) => setRole(e.target.value)} maxLength={80} /></label></div>
        <p className={css.note}>It starts with a Lead capture block. Add more tabs on the board; a Hand-off block passes the work from one to the next.</p>
      </DrawerSection>
    </Drawer> : null}
  </>;
}

export function WaitingNow({ items }: { items: WaitingItem[] }) {
  const router = useRouter();
  return <div className={css.vars}><WaitingList items={items} mode="live" empty="No step is waiting for you. When a process gives you a step, it appears here and in My tasks." onChanged={() => router.refresh()} /></div>;
}
