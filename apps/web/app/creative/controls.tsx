"use client";
// EST-1474: CS Home's controls. Leadership and admins open anyone's Home; leadership, admins and growth strategists start
// a sprint on a client project (package, Day 1, both strategists, the client's approver: all four are needed, EST-1792).
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CloudOff, Info, Plus } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { Combobox, Drawer, DrawerFooter, DrawerSection, PersonSelect, Segmented } from "../kit";
import { post } from "../records";
import { Empty, Skeleton, styles } from "../ui";
import { apiFailure, describeFailure } from "../lib/load-error.mjs";
import { RetryButton } from "../retry-button";
import type { Person, SprintView } from "./types";
import { DateField } from "../kit/date-field";

type Choices = { projects: { id: string; name: string; client: string | null }[]; people: Person[]; me: string | null };
function useChoices(on: boolean) {
  const [state, setState] = useState<{ choices: Choices | null; error?: string }>({ choices: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!on) return;
    let active = true;
    void fetch("/api/v0/creative/choices", { cache: "no-store" }).then(async (r) => {
      const body = await r.json().catch(() => null);
      if (!r.ok) throw new Error(apiFailure(r.status, body));
      if (!body) throw new Error();
      if (active) setState({ choices: body });
    }).catch((e) => { if (active) setState({ choices: null, error: e instanceof Error ? e.message || "Unavailable" : "Unavailable" }); });
    return () => { active = false; };
  }, [on, attempt]);
  return { ...state, retry: () => { setState({ choices: null }); setAttempt((n) => n + 1); } };
}

export function LoadFailure({ error, retry }: { error?: string; retry?: () => void }) {
  const shown = describeFailure(error);
  return <Empty icon={shown.retry ? CloudOff : Info} title={shown.title} text={shown.text}>
    {shown.retry ? retry ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={retry}>Try again</button> : <RetryButton /> : null}
  </Empty>;
}

export function HomePerson({ current }: { current: string }) {
  const router = useRouter(), { choices, error, retry } = useChoices(true);
  if (error) {
    const shown = describeFailure(error);
    return <button type="button" className={styles.btn} title={shown.text} disabled={!shown.retry} onClick={retry}>Whose Home · {shown.retry ? "Try again" : "Unavailable"}</button>;
  }
  if (!choices) return <div role="status" aria-label="Loading Whose Home"><Skeleton width={160} height={28} /></div>;
  return <PersonSelect label="Whose Home" size="sm" variant="chip" people={choices.people} value={current} onChange={(p) => { if (p) router.push(`/creative?person=${p.id}`); }} />;
}

export function StartSprint({ packages }: { packages: { key: string; label: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false), { choices, error: choicesError, retry } = useChoices(open), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [project, setProject] = useState<string | null>(null), [pkg, setPkg] = useState(packages[0]?.key ?? ""), [dayOne, setDayOne] = useState("");
  const [gs, setGs] = useState<string | null | undefined>(undefined), [cs, setCs] = useState<string | null>(null), [approver, setApprover] = useState("");
  const candidate = gs === undefined ? choices?.me : gs;
  const growth = choices?.people.some((p) => p.id === candidate) ? candidate ?? null : null;
  async function start() {
    const missing = !project ? "Choose the client project" : !growth ? "Choose the growth strategist" : !cs ? "Choose the creative strategist" : !approver.trim() ? "Name the client approver" : "";
    if (missing) { setError(missing); return; }
    setBusy(true); setError("");
    try { const r = await post<SprintView>("creative/sprints", { projectId: project, package: pkg, dayOne, gsPersonId: growth, csPersonId: cs, approver: approver.trim() });
      notify({ id: "creative", tone: "success", title: "Sprint started", timeout: 2500 }); setOpen(false); router.push(r.link); }
    catch (e) { setError(e instanceof Error ? e.message : "Try again"); } finally { setBusy(false); }
  }
  return <>
    <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => {
      const now = new Date();
      if (!dayOne) setDayOne(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`);
      setOpen(true);
    }}><Plus size={14} aria-hidden="true" />Start a sprint</button>
    {open ? <Drawer title="Start a creative sprint" onClose={() => setOpen(false)} size="md"
      footer={<DrawerFooter status={error} primary={<button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !choices} onClick={() => void start()}>{busy ? "Starting…" : "Start the sprint"}</button>}>
        <button type="button" className={styles.btn} onClick={() => setOpen(false)}>Cancel</button></DrawerFooter>}>
      {choicesError ? <LoadFailure error={choicesError} retry={retry} /> : !choices ? <div role="status" aria-label="Loading sprint choices"><Skeleton height={120} /></div> : <>
      <DrawerSection title="Client project">
        <Combobox label="Client project" placeholder="Choose a project" value={project} onChange={(v) => setProject(v)}
          options={choices.projects.map((p) => ({ value: p.id, label: p.name, detail: p.client ?? undefined }))} emptyText="Every project already has a sprint" />
      </DrawerSection>
      <DrawerSection title="Package and Day 1" help="The package sets each deliverable's day. Day 1 is the research meet; critical inputs are due before it, and a late one moves the clock day for day.">
        <Segmented label="Package" value={pkg} onChange={setPkg} options={packages.map((p) => ({ value: p.key, label: p.label }))} />
        <label className={styles.field}><span>Day 1</span><DateField className={styles.input} value={dayOne} onChange={(e) => setDayOne(e.target.value)} /></label>
      </DrawerSection>
      <DrawerSection title="People">
        <div className={styles.kitField}><span>Growth strategist</span><PersonSelect label="Growth strategist" people={choices.people} me={choices.me} value={growth} onChange={(p) => setGs(p?.id ?? null)} /></div>
        <div className={styles.kitField}><span>Creative strategist</span><PersonSelect label="Creative strategist" people={choices?.people ?? []} value={cs} onChange={(p) => setCs(p?.id ?? null)} /></div>
        <label className={styles.field}><span>Client approver (one named person)</span><input className={styles.input} value={approver} maxLength={120} required onChange={(e) => setApprover(e.target.value)} placeholder="Name" /></label>
      </DrawerSection></>}
    </Drawer> : null}
  </>;
}
