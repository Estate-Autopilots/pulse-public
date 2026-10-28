"use client";
// HR edits a policy in Markdown with the reader's own rendering beside it. Every pause in typing saves the text as the
// draft (never as a published version): a published policy gets its next version as a draft, an existing draft is
// updated in place. Employees keep reading the published version until HR presses Publish.

import { Bold, Heading2, List, ListOrdered, CircleHelp, Table2, X } from "lucide-react";
import { useCallback, useDeferredValue, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { styles } from "../ui";
import { MarkdownBody, usePolicy } from "./policy-reader";
import reader from "./policy-reader.module.css";
import css from "./policy-editor.module.css";

export type EditorDoc = { kind: string; kindLabel: string; title: string; body: string; version: number; revision: number; published: boolean; wordFile?: string | null };
type Saved = { id: string; version: number; revision: number; savedAt: string };
type State = { tone: "idle" | "saving" | "saved" | "error" | "conflict"; text: string };
type Tool = "heading" | "bold" | "bullet" | "number" | "table" | "confirm";

const time = (at: string) => new Date(at).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
const TABLE = "\n| Column | Column |\n| --- | --- |\n| Text | Text |\n";

/** A new policy starts from an outline HR fills in. */
export const template = (title: string) => `# ${title}\n\nVersion 1 (draft) · Applies to all employees\n\n## 1. Purpose\n\nWhat this policy is for.\n\n## 2. The rules\n\n- A rule\n- A rule that needs a decision **(confirm)**\n\n## 3. Questions\n\nAsk HR in Pulse → My desk → Requests.\n`;

export function PolicyEditor({ doc, onClose }: { doc: EditorDoc; onClose: (saved: Saved | null) => void }) {
  const [title, setTitle] = useState(doc.title), [body, setBody] = useState(doc.body);
  const [state, setState] = useState<State>({ tone: "idle", text: "" });
  const [savedKey, setSavedKey] = useState(() => JSON.stringify([doc.title, doc.body]));
  const [mode, setMode] = useState<"write" | "preview">("write");
  const titleId = useId(), hintId = useId();
  const box = useRef<HTMLDivElement>(null), area = useRef<HTMLTextAreaElement>(null);
  // What the server has: the version/revision to save against and the text it holds.
  const server = useRef({ version: doc.version, revision: doc.revision, saved: JSON.stringify([doc.title, doc.body]), last: null as Saved | null, busy: false, again: false, conflict: false });
  const text = useRef({ title, body });
  useEffect(() => { text.current = { title, body }; }, [title, body]);
  const preview = usePolicy(useDeferredValue(title), useDeferredValue(body));
  const dirty = JSON.stringify([title, body]) !== savedKey;

  const save = useCallback(async (): Promise<boolean> => {
    const s = server.current, { title: t, body: b } = text.current, key = JSON.stringify([t, b]);
    if (key === s.saved) return true;
    if (s.busy) { s.again = true; return false; }
    if (t.trim().length < 2 || b.trim().length < 10) { setState({ tone: "error", text: "Not saved yet: give the policy a title and some text." }); return false; }
    s.busy = true; setState({ tone: "saving", text: "Saving the draft…" });
    try {
      const r = await fetch("/api/v0/hr/policies/draft", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: doc.kind, title: t, body: b, version: s.version, revision: s.revision }) });
      const data = await r.json().catch(() => ({}));
      if (r.status === 409) { s.conflict = true; setState({ tone: "conflict", text: "Someone changed this policy in another window. Your text is still here: copy it, close the editor and open it again." }); return false; }
      if (!r.ok) { setState({ tone: "error", text: `Not saved: ${data.error ?? "the HR service did not answer"}. Pulse tries again when you keep typing.` }); return false; }
      const saved = data as Saved;
      s.version = saved.version; s.revision = saved.revision; s.saved = key; s.last = saved; setSavedKey(key);
      setState({ tone: "saved", text: `Draft saved at ${time(saved.savedAt)}` });
      return true;
    } catch { setState({ tone: "error", text: "Not saved: Pulse could not be reached. It tries again when you keep typing." }); return false; }
    finally { s.busy = false; if (s.again) { s.again = false; void save(); } }
  }, [doc.kind]);

  // Autosave a moment after typing stops; after a failed save, the next change tries again.
  useEffect(() => {
    if (!dirty || server.current.conflict) return;
    const timer = window.setTimeout(() => void save(), 1200);
    return () => window.clearTimeout(timer);
  }, [title, body, dirty, save]);
  // Leaving the page with unsaved text asks first.
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (JSON.stringify([text.current.title, text.current.body]) !== server.current.saved) event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  const close = useCallback(async () => {
    // Let a save that is on its way finish, then save what is left.
    for (let i = 0; i < 100 && server.current.busy; i++) await new Promise((done) => setTimeout(done, 100));
    const ok = await save();
    if (!ok && server.current.saved !== JSON.stringify([text.current.title, text.current.body]) && !window.confirm("Your latest changes are not saved. Close the editor anyway?")) return;
    onClose(server.current.last);
  }, [save, onClose]);

  // A full-screen dialog: focus starts in the text, stays inside, Escape closes (after saving), the page stays still.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    area.current?.focus();
    return () => { document.body.style.overflow = overflow; before?.focus?.(); };
  }, []);
  const onKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); void close(); return; }
    if ((event.metaKey || event.ctrlKey) && (event.key ?? "").toLowerCase() === "s") { event.preventDefault(); void save(); return; }
    if (event.key === "Tab") {
      const all = Array.from(box.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input, textarea, a[href], [tabindex='0']") ?? []).filter((el) => el.getClientRects().length);
      const first = all[0], last = all.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  };

  /** Wrap the selection, or start the current lines with a prefix, keeping the selection where the user expects it. */
  const format = (kind: Tool) => {
    const el = area.current; if (!el) return;
    const { selectionStart: a, selectionEnd: z, value } = el;
    let next = value, from = a, to = z;
    if (kind === "bold") { const inner = value.slice(a, z) || "bold text"; next = `${value.slice(0, a)}**${inner}**${value.slice(z)}`; from = a + 2; to = from + inner.length; }
    else if (kind === "confirm") { next = `${value.slice(0, z)} **(confirm)**${value.slice(z)}`; from = to = z + 14; }
    else if (kind === "table") { const at = value.indexOf("\n", z) < 0 ? value.length : value.indexOf("\n", z); next = `${value.slice(0, at)}\n${TABLE}${value.slice(at)}`; from = at + 4; to = from + 6; }
    else {
      const start = value.lastIndexOf("\n", a - 1) + 1, end = value.indexOf("\n", z) < 0 ? value.length : value.indexOf("\n", z);
      const lines = value.slice(start, end).split("\n");
      const done = lines.map((line, i) => kind === "heading" ? `## ${line.replace(/^#{1,6}\s+/, "")}` : kind === "bullet" ? `- ${line.replace(/^(\s*)([-*+]|\d+[.)])\s+/, "$1")}` : `${i + 1}. ${line.replace(/^(\s*)([-*+]|\d+[.)])\s+/, "$1")}`).join("\n");
      next = value.slice(0, start) + done + value.slice(end); from = start; to = start + done.length;
    }
    setBody(next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(from, to); });
  };
  const tools: [Tool, string, typeof Bold][] = [["heading", "Section heading", Heading2], ["bold", "Bold", Bold], ["bullet", "Bulleted list", List], ["number", "Numbered list", ListOrdered], ["table", "Insert a table", Table2], ["confirm", "Mark as “(confirm)”: a question for HR before publishing", CircleHelp]];
  const intro = (doc.published ? `Editing starts version ${doc.version + 1} as a draft. Version ${doc.version} stays published until you publish the new one.` : "Changes save automatically as a draft. Employees cannot see drafts.")
    + (doc.wordFile ? ` Changing the text here leaves the Word file (${doc.wordFile}) out of the draft.` : "");

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className={css.backdrop}>
      <div ref={box} className={css.editor} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKey}>
        <header className={css.head}>
          <div className={css.headText}>
            <h2 id={titleId}>Edit {doc.kindLabel.toLowerCase()} policy</h2>
            <p role="status" aria-live="polite" data-tone={state.tone}>{state.text || (dirty ? "Unsaved changes…" : intro)}</p>
          </div>
          <div className={`${styles.segmented} ${css.modes}`} role="group" aria-label="Show">
            <button type="button" className={styles.segment} aria-pressed={mode === "write"} onClick={() => setMode("write")}>Write</button>
            <button type="button" className={styles.segment} aria-pressed={mode === "preview"} onClick={() => setMode("preview")}>Preview</button>
          </div>
          <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => void close()} disabled={state.tone === "saving"}>Done</button>
          <button type="button" className={styles.iconBtn} aria-label="Close the editor" onClick={() => void close()}><X size={16} aria-hidden="true" /></button>
        </header>
        <div className={css.panes} data-mode={mode}>
          <section className={css.write} aria-label="Write">
            <label className={css.title}><span>Title</span><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} required autoComplete="off" /></label>
            <div className={css.toolbar} role="group" aria-label="Formatting">
              {tools.map(([kind, label, Icon]) => <button key={kind} type="button" className={styles.iconBtn} aria-label={label} title={label} onClick={() => format(kind)}><Icon size={16} aria-hidden="true" /></button>)}
              <span className={css.count}>{body.length.toLocaleString("en-IN")} / 30,000</span>
            </div>
            <textarea ref={area} className={css.area} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Policy text (Markdown)" aria-describedby={hintId} spellCheck maxLength={30000} />
            <p id={hintId} className={css.hint}># Title · ## Section · - list · 1. numbered list · | table | · **bold** · mark open questions with (confirm). Ctrl+S saves now.</p>
          </section>
          <section className={css.preview} aria-label="Preview" tabIndex={0}>
            <article className={reader.doc}><MarkdownBody blocks={preview.blocks} anchors={false} /></article>
          </section>
        </div>
      </div>
    </div>, document.body);
}
