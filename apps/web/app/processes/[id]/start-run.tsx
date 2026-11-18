"use client";
// FLOW-B: Start a process for a client or project. FIX-DOCS-WORK (owner walkthrough, 10 Nov 2026: "Start process shows
// odd text and odd fields; no clarity on how to use it"; Codex concept processes-3): one sheet in three numbered parts,
//   1. Who is it for?        a client (picked from the company's clients) or any name; the details the process needs
//                            (optional ones fold away under "More details");
//   2. Who does each part?   each role with its person, already filled when the company has one;
//   3. Check and start       "The first step, Lead call, goes to Ravi today." One primary: "Start for <name>".
// A practice run (made-up names, nobody is told, no tasks) is a quiet link under part 3, not a box in the form; a process
// that is not live yet can only be practised, and the sheet says so in one line.
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { FlaskConical, Play } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { Drawer, DrawerFooter, DrawerSection } from "../../kit";
import { SelectField } from "../../kit/select-field";
import { say } from "../../lib/words.mjs";
import { useWords } from "../../org-code";
import { styles } from "../../ui";
import { flow, why } from "../flow-client";
import type { ProcessDetail } from "../flow-types";
import css from "./process.module.css";

type Client = { id: string; name: string };

export function StartRun({ process, primary = true }: { process: ProcessDetail; primary?: boolean }) {
  const router = useRouter(), words = useWords();
  const clientWord = say("{client}", words);
  const live = process.status === "live" && process.canStart;
  const fields = (process.definition.fields ?? []).filter((f) => f.type !== "person");
  const must = fields.filter((f) => f.required), extra = fields.filter((f) => !f.required);
  // Who is on it: each role's people in the company, the only one chosen already; a role can be named later.
  const roles = (process.definition.roles ?? []).filter((r) => (process.roleHolders?.[r.key] ?? []).length);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [name, setName] = useState(""), [values, setValues] = useState<Record<string, unknown>>({});
  const [people, setPeople] = useState<Record<string, string>>(() => Object.fromEntries(roles.flatMap((r) => { const list = process.roleHolders[r.key] ?? []; return list.length === 1 ? [[r.key, list[0].id]] : []; })));
  const [clients, setClients] = useState<Client[]>([]);
  useEffect(() => {
    if (!open || clients.length) return;
    // The company's clients, to pick from (the meetings list of clients is the light one every staff member can read).
    void fetch("/api/v0/meetings/options", { cache: "no-store" }).then((r) => r.ok ? r.json() : null).then((d: { clients?: Client[] } | null) => { if (d?.clients) setClients(d.clients); }).catch(() => undefined);
  }, [open, clients.length]);
  const client = clients.find((c) => c.name.trim().toLowerCase() === name.trim().toLowerCase()) ?? null;
  const missing = must.filter((f) => values[f.key] === undefined || values[f.key] === "");

  // Part 3's one line: the first step, and who gets it.
  const first = useMemo(() => {
    const s = process.definition.steps?.[0];
    if (!s) return null;
    const role = s.who?.role ? (process.definition.roles ?? []).find((r) => r.key === s.who.role) : null;
    const pid = role ? people[role.key] : s.who?.personId ?? null;
    const person = pid ? Object.values(process.roleHolders ?? {}).flat().find((p) => p.id === pid)?.name ?? null : null;
    return { title: s.title, who: person ?? (role ? `the ${role.label}` : null), named: !!person };
  }, [process, people]);

  async function start(practice: boolean) {
    setBusy(true); setError("");
    try {
      const crew = practice ? Object.fromEntries((process.definition.roles ?? []).map((r) => [r.key, { name: `${r.label} (practice)` }])) : Object.fromEntries(Object.entries(people).filter(([, v]) => v));
      const r = await flow<{ id: string }>(`processes/${encodeURIComponent(process.id)}/runs`, "POST", {
        name: name.trim(), ...(client ? { clientId: client.id } : {}), fields: values, people: crew, ...(practice ? { mode: "demo" } : {}) });
      notify({ id: "run", tone: "success", title: practice ? "Practice started: nobody is told" : `Started for ${name.trim()}`,
        ...(!practice && first?.who ? { message: `${first.title} is with ${first.who} now.` } : {}), timeout: 4000 });
      router.push(`/runs/${r.id}`);
    } catch (err) { setError(why(err)); setBusy(false); }
  }
  const field = (f: (typeof fields)[number]) => <label key={f.key} className={css.field}><span>{f.label}{f.required ? "" : <em> optional</em>}</span>
    {f.type === "choice" ? <div className={css.choices} role="radiogroup" aria-label={f.label}>{f.options?.map((o) => <button key={o.value} type="button" role="radio" aria-checked={values[f.key] === o.value}
      onClick={() => setValues({ ...values, [f.key]: o.value })}>{o.label}</button>)}</div>
      : f.type === "boolean" ? <span className={css.yesNo}><input type="checkbox" checked={!!values[f.key]} onChange={(e) => setValues({ ...values, [f.key]: e.target.checked })} />Yes</span>
        : <input type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"} value={String(values[f.key] ?? "")} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />}
    {f.help ? <small>{f.help}</small> : null}</label>;
  const who = name.trim() || `the ${clientWord}`;
  const ready = !!name.trim() && !missing.length;
  const crewShown = roles.length > 0 && live;

  return <>
    <button type="button" className={`${styles.btn} ${primary ? `${styles.btnPrimary} ${css.solid}` : ""}`} data-primary={primary ? "" : undefined} onClick={() => setOpen(true)}>
      {live ? <Play size={14} aria-hidden="true" /> : <FlaskConical size={14} aria-hidden="true" />}{live ? say("Start for a {client}", words) : "Practise it"}</button>
    {open ? <Drawer title={live ? say("Start for a {client}", words) : "Practice run"} context={<span className={css.hint}>{process.name} · {process.steps} {process.steps === 1 ? "step" : "steps"}</span>} onClose={() => setOpen(false)} size="md"
      footer={<DrawerFooter status={error}>
        {live && process.canEdit ? <button type="button" className={css.quietLink} onClick={() => { if (ready) void start(true); else setError("Type who it is for first."); }} disabled={busy}>
          <FlaskConical size={13} aria-hidden="true" />Practise first</button> : null}
        <button type="button" className={`${styles.btn} ${styles.btnGhost} ${css.cancel}`} onClick={() => setOpen(false)}>Cancel</button>
        <button type="submit" form="start-run" className={`${styles.btn} ${styles.btnPrimary} ${css.solid} ${css.startBtn}`} disabled={busy || !ready} aria-label={live ? `Start for ${who}` : undefined}>{busy ? "Starting…" : live ? "Start" : "Start the practice"}</button>
      </DrawerFooter>}>
      <form id="start-run" className={css.sheet} onSubmit={(e) => { e.preventDefault(); if (ready) void start(!live); }}>
        {!live ? <p className={css.practiceNote}><FlaskConical size={15} aria-hidden="true" /><span>Just practising: made-up names, and nobody is told.</span></p> : null}
        <DrawerSection className={css.part} title={<><span className={css.num}>1</span>Who is it for?</>}>
          <label className={css.field}><span className={css.srOnly}>{say("{Client} or project", words)}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} list="start-run-clients" placeholder={say("Type a {client} or project name", words)} data-autofocus="" autoComplete="off" /></label>
          <datalist id="start-run-clients">{clients.map((c) => <option key={c.id} value={c.name} />)}</datalist>
          {client ? <p className={css.hint}>Linked to the {clientWord} “{client.name}”.</p> : null}
          {must.map(field)}
          {extra.length ? <details className={css.more}><summary>More details <em>optional</em></summary><div className={css.sheet}>{extra.map(field)}</div></details> : null}
        </DrawerSection>
        {crewShown ? <DrawerSection className={css.part} title={<><span className={css.num}>2</span>Who does each part?</>}>
          <div className={css.crew}>{roles.map((r) => <label key={r.key}><span>{r.label}</span><SelectField value={people[r.key] ?? ""} onChange={(e) => setPeople({ ...people, [r.key]: e.target.value })}>
            <option value="">Pick later</option>{(process.roleHolders[r.key] ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</SelectField></label>)}</div>
        </DrawerSection> : null}
        <DrawerSection className={css.part} title={<><span className={css.num}>{crewShown ? 3 : 2}</span>Check and start</>}>
          <p className={css.firstStep}>{first ? <><span className={css.firstShort}>First step: <b>{first.title}</b> · {first.who ?? "its person"}{live && !first.named ? <span className={css.firstNote}>Nobody has that role yet. You will pick someone after you start.</span> : null}</span><span className={css.firstLong}>The first step, <b>{first.title}</b>, {live ? first.named ? `goes to ${first.who} today.` : <>is for {first.who ?? "its person"}.<br /><span className={css.firstNote}><em className={css.laterChip}>Pick later</em>Nobody has that role yet. You will pick someone after you start.</span></> : "is where the practice starts."}</span></> : "It starts with its first step."}</p>
          {(live && first && !first.named) || !live ? null : <p className={css.hint}>Each person gets their step when it is their turn. You follow it here, step by step.</p>}

        </DrawerSection>
      </form>
    </Drawer> : null}
  </>;
}
