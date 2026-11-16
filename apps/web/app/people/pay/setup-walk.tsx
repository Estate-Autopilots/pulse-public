"use client";
// HR-PEOPLE (owner, 13 Nov 2026, T1.1.4: "when I go on set up pay, it redirects to … a small dashboard"): Set up pay opens
// the set-up form right here, over People & pay, one person after another ("2 of 51"), and never leaves the list. The
// form is the person page's own (flows.tsx ChangePay): the same figures, preview, letter and approval.
import { useEffect, useState } from "react";
import { Skeleton } from "../../kit/game";
import { Modal } from "../../records";
import { ChangePay } from "./flows";
import type { PersonPay } from "./model";

export function SetupWalk({ ids, at, onClose }: { ids: string[]; at: number; onClose: () => void }) {
  const [i, setI] = useState(at);
  const [p, setP] = useState<PersonPay | null>(null), [error, setError] = useState("");
  const id = ids[i];
  useEffect(() => {
    if (!id) return;
    let live = true;
    void (async () => {
      setP(null); setError("");
      try {
        const r = await fetch(`/api/v0/comp/people/${encodeURIComponent(id)}`, { cache: "no-store" }), d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "This person's pay did not load");
        if (live) setP(d as PersonPay);
      } catch (e) { if (live) setError(e instanceof Error ? e.message : "This person's pay did not load"); }
    })();
    return () => { live = false; };
  }, [id]);
  if (!id) return null;
  const step = ids.length > 1 ? `${i + 1} of ${ids.length}` : undefined;
  const next = () => (i + 1 < ids.length ? setI(i + 1) : onClose());
  // A saved person stays on screen until the next one has loaded: never their form under the next step's number.
  if (!p || p.person.id !== id) return <Modal title={error ? "Could not open this person's pay" : "Opening…"} sub={step} onClose={onClose}>
    {error ? <p role="alert">{error}</p> : <div style={{ display: "grid", gap: 10 }} aria-busy="true"><Skeleton height={44} /><Skeleton height={44} /><Skeleton height={120} /></div>}
  </Modal>;
  return <ChangePay key={p.person.id} p={p} start step={step} onSaved={next} onClose={onClose} />;
}
