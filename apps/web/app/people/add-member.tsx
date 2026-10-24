"use client";

import { Bot, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { notify } from "@pulse/ui-shell";
import { FormField, Modal, post, RecordForm, type FieldDef } from "../records";
import { DrawerFooter, DrawerSection } from "../kit/drawer";
import styles from "../ui.module.css";
import own from "./add-member.module.css";

const HUMAN_NOTE = "Pulse gives the new member the next employee ID and a username. A sign-in is issued separately, from their profile or Settings.";
const AI_NOTE = "Pulse gives it the next AI employee ID. It never signs in: its runtime on this company's server works through a key the operator connects.";
const CONFIRMATION = "This member is AI. It is marked AI everywhere, has no sign-in, and acts only through its scoped token.";
// CHAT-WORK: an AI employee is added like anyone (the same person record and profile: name, role, pod, team, who it
// reports to); the switch adds only what is set for AI. Its tools and where it speaks can be changed on its profile.
export const MODELS: Record<string, string[]> = { claude: ["claude-opus-5-5", "claude-sonnet-5", "claude-haiku-5"], codex: ["gpt-6-luna", "gpt-6", "gpt-6-codex"] };
export const TOOLS = [
  { value: "chats", label: "Chats", hint: "Answers when asked in its groups and direct messages" },
  { value: "tasks", label: "Tasks", hint: "Takes tasks given to it and reports back in their chat" },
  { value: "memory", label: "Memory", hint: "Keeps notes of what it learns" },
  { value: "board", label: "Board", hint: "Hands bigger work to the company board when a leader agrees" },
] as const;
type AiMember = Record<string, string | string[]>;

export function AddMember({ admin, fields, owners, defaultOpen = false }: { admin: boolean; fields: FieldDef[]; owners: { value: string; label: string }[]; defaultOpen?: boolean }) {
  if (!admin) return <RecordForm path="people" title="Add a team member" sub="Only the name and role are needed now; the rest can follow." fields={fields} label="Add member" icon="add" variant="primary" created="/people/" note={HUMAN_NOTE} defaultOpen={defaultOpen} />;
  return <AdminAddMember humanFields={fields} owners={owners} defaultOpen={defaultOpen} />;
}

function AdminAddMember({ humanFields, owners, defaultOpen }: { humanFields: FieldDef[]; owners: { value: string; label: string }[]; defaultOpen: boolean }) {
  const router = useRouter(), formId = useId(), saving = useRef(false);
  const [open, setOpen] = useState(defaultOpen), [ai, setAi] = useState(false), [provider, setProvider] = useState("claude");
  const [tools, setTools] = useState<string[]>(["chats", "tasks", "memory"]);
  const [confirmation, setConfirmation] = useState<AiMember | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (confirmation) cancel.current?.focus(); }, [confirmation]);
  // The same fields a person has where they apply to AI (no employment, joining date, e-mail or phone); "Reports to" is
  // its manager, who reviews its work.
  const person = humanFields.filter((f) => ["name", "role", "pod", "department", "managerId"].includes(f.key))
    .map((f) => f.key === "managerId" ? { ...f, options: owners, required: true, hint: "Its manager: reviews its work and manages its settings." } : f.key === "name" ? { ...f, label: "Name", maxLength: 80 } : f);
  const aiFields: FieldDef[] = [
    { key: "provider", label: "Runtime", type: "choice", required: true, section: "AI employee", options: [{ value: "claude", label: "Claude", hint: "Claude Code on this server" }, { value: "codex", label: "Codex", hint: "Codex CLI on this server" }] },
    { key: "model", label: "Model", required: true, suggest: MODELS[provider], placeholder: MODELS[provider][0], maxLength: 80 },
    { key: "effort", label: "Effort", type: "choice", required: true, options: [{ value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }, { value: "xhigh", label: "Extra high" }] },
    { key: "lane", label: "Answers", type: "choice", required: true, options: [{ value: "quick", label: "Quick" }, { value: "thinking", label: "Thinking" }] },
    { key: "dailyTokenBudget", label: "Daily limit (tokens)", type: "number", required: true, hint: "Its runs stop for the day at this; its plan's own limits apply too." },
  ];
  const fields: FieldDef[] = ai ? [...person, ...aiFields] : humanFields;
  const defaults: Record<string, string> = ai ? { provider, model: MODELS[provider][0], effort: "medium", lane: "thinking", dailyTokenBudget: "160000" } : {};
  const groups: { section?: string; fields: FieldDef[] }[] = [];
  for (const f of fields) if (f.section || !groups.length) groups.push({ section: f.section, fields: [f] }); else groups.at(-1)!.fields.push(f);
  function close() {
    if (saving.current) return;
    setError("");
    if (confirmation) setConfirmation(null); else setOpen(false);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving.current) return;
    const data = new FormData(event.currentTarget);
    const missing = fields.find((f) => f.required && !String(data.get(f.key) ?? "").trim());
    if (missing) { setError(`${missing.label}: ${["select", "choice"].includes(missing.type ?? "") ? "choose one" : "fill this in"}`); return; }
    if (!event.currentTarget.reportValidity()) return;
    const body = Object.fromEntries(fields.map((f) => [f.key, String(data.get(f.key) ?? "").trim()]));
    setError("");
    if (ai) {
      const { role, managerId, ...rest } = body;
      setConfirmation({ ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== "")), title: role, ownerId: managerId, tools });
      return;
    }
    saving.current = true; setBusy(true);
    try {
      const result = await post<{ id: string }>("people", Object.fromEntries(Object.entries(body).filter(([, value]) => value !== "")));
      setOpen(false); notify({ id: "saved:people", tone: "success", title: "Record created", timeout: 2500 });
      if (result.id) router.push(`/people/${result.id}`); else router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save"); }
    finally { saving.current = false; setBusy(false); }
  }
  async function confirm() {
    if (!confirmation || saving.current) return;
    saving.current = true; setBusy(true); setError("");
    try {
      const result = await post<{ id: string; employeeId: string }>("agents", confirmation);
      const href = `/people/ai/${encodeURIComponent(result.id)}`;
      setOpen(false); setConfirmation(null);
      notify({ id: "saved:agents", tone: "success", title: `Added ${result.employeeId}`, message: String(confirmation.name), href,
        action: { label: "View", run: () => router.push(href) }, timeout: 10000 });
      router.push(href);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not add this member. Check your connection and try again."); }
    finally { saving.current = false; setBusy(false); }
  }
  return <>
    <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => { setAi(false); setError(""); setConfirmation(null); setOpen(true); }}><Plus size={14} aria-hidden="true" />Add member</button>
    {open ? <Modal title={confirmation ? "Add AI employee" : "Add a team member"} describedBy={confirmation ? `${formId}-confirmation` : undefined}
      sub={!confirmation ? "Only the name and role are needed now; the rest can follow." : undefined}
      help={!confirmation ? ai ? AI_NOTE : HUMAN_NOTE : undefined} onClose={close} foot={<DrawerFooter status={error}>
      <button ref={cancel} type="button" className={`${styles.btn} ${styles.btnGhost}`} disabled={busy} onClick={close}>Cancel</button>
      {confirmation ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={confirm}>{busy ? "Adding…" : "Add AI employee"}</button>
        : <button form={formId} className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>{busy ? "Saving…" : "Create"}</button>}
    </DrawerFooter>}>
      {confirmation ? <DrawerSection><p id={`${formId}-confirmation`} className={styles.modalNote}>{CONFIRMATION}</p></DrawerSection> : null}
      <form id={formId} className={styles.drawerForm} style={confirmation ? { display: "none" } : undefined} onSubmit={submit} noValidate>
        <DrawerSection><label className={own.switch} data-on={ai || undefined}>
          <input type="checkbox" role="switch" name="ai" checked={ai} aria-describedby={`${formId}-ai-hint`} onChange={(e) => { setAi(e.target.checked); setError(""); }} />
          <span className={own.track} aria-hidden="true"><span /></span>
          <span className={own.label}><b><Bot size={14} aria-hidden="true" />This is an AI employee</b><small id={`${formId}-ai-hint`}>Everything else is the same as for a person; an AI employee also gets a runtime, limits and tools.</small></span>
        </label></DrawerSection>
        <div key={String(ai)}>{groups.map((g, i) => <DrawerSection key={i} title={g.section}>
          <div className={styles.modalBody} onChange={(e) => {
            const t = e.target as HTMLInputElement; if (t.name !== "provider" || t.value === provider) return;
            // The model follows the runtime unless one was typed in.
            const model = t.form?.elements.namedItem("model") as HTMLInputElement | null;
            if (model && (!model.value || MODELS[provider]?.includes(model.value))) model.value = MODELS[t.value]?.[0] ?? "";
            setProvider(t.value);
          }}>
            {g.fields.map((f) => <FormField key={f.key} f={f} value={defaults[f.key] ?? ""} formId={formId} />)}
          </div>
          {g.section === "AI employee" ? <fieldset className={own.tools}><legend>Tools</legend>{TOOLS.map((t) => <label key={t.value}>
            <input type="checkbox" checked={tools.includes(t.value)} onChange={(e) => setTools((x) => e.target.checked ? [...x, t.value] : x.filter((y) => y !== t.value))} />
            <span><b>{t.label}</b><small>{t.hint}</small></span></label>)}</fieldset> : null}
        </DrawerSection>)}</div>
      </form>
    </Modal> : null}
  </>;
}
