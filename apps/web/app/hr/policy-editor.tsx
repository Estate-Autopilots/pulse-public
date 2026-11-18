"use client";
// HR edits a policy. Every pause in typing saves the text as the draft (never as a published version): a published
// policy gets its next version as a draft, an existing draft is updated in place. Employees keep reading the published
// version until HR presses Publish.
// DOCS-INTERACTIVE (7 Nov 2026): the policy is written in Pulse's one doc editor (headings, lists, tables, checklists,
// callouts; "/" for blocks) instead of a Markdown box. It is still kept as Markdown, so the employee reader, the Word
// export and the "(confirm)" marks work as before: the screen turns the Markdown into rich text when it opens, and the API
// turns the rich text back into Markdown when it saves (services/api/src/company.ts, the same turndown as Docs).

import { CircleHelp, X } from "lucide-react";
import { marked } from "marked";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { styles } from "../ui";
import { DocEditor, type DocEditorHandle } from "../docs/editor";
import css from "./policy-editor.module.css";
import { useConfirm } from "../kit/dialogs";
import type { EditorDoc } from "./policy-template";

type Saved = { id: string; version: number; revision: number; savedAt: string };
type State = { tone: "idle" | "saving" | "saved" | "error" | "conflict"; text: string };

const time = (at: string) => new Date(at).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
const plain = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();


export function PolicyEditor({ doc, onClose }: { doc: EditorDoc; onClose: (saved: Saved | null) => void }) {
  const confirm = useConfirm();
  const startHtml = useMemo(() => String(marked.parse(doc.body, { async: false, gfm: true })), [doc.body]);
  const [title, setTitle] = useState(doc.title), [html, setHtml] = useState(startHtml);
  const [state, setState] = useState<State>({ tone: "idle", text: "" });
  const [savedKey, setSavedKey] = useState(() => JSON.stringify([doc.title, startHtml]));
  const titleId = useId(), hintId = useId();
  const box = useRef<HTMLDivElement>(null), editor = useRef<DocEditorHandle>(null);
  // What the server has: the version/revision to save against and the text it holds.
  const server = useRef({ version: doc.version, revision: doc.revision, saved: JSON.stringify([doc.title, startHtml]), last: null as Saved | null, busy: false, again: false, conflict: false });
  const text = useRef({ title, html });
  useEffect(() => { text.current = { title, html }; }, [title, html]);
  const dirty = JSON.stringify([title, html]) !== savedKey;

  const save = useCallback(async (): Promise<boolean> => {
    const s = server.current, { title: t, html: h } = text.current, key = JSON.stringify([t, h]);
    if (key === s.saved) return true;
    if (s.busy) { s.again = true; return false; }
    if (t.trim().length < 2 || plain(h).length < 10) { setState({ tone: "error", text: "Not saved yet: give the policy a title and some text." }); return false; }
    s.busy = true; setState({ tone: "saving", text: "Saving the draft…" });
    try {
      const r = await fetch("/api/v0/hr/policies/draft", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: doc.kind, title: t, html: h, version: s.version, revision: s.revision }) });
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
  }, [title, html, dirty, save]);
  // Leaving the page with unsaved text asks first.
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (JSON.stringify([text.current.title, text.current.html]) !== server.current.saved) event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  const close = useCallback(async () => {
    // Let a save that is on its way finish, then save what is left.
    for (let i = 0; i < 100 && server.current.busy; i++) await new Promise((done) => setTimeout(done, 100));
    const ok = await save();
    if (!ok && server.current.saved !== JSON.stringify([text.current.title, text.current.html]) && !(await confirm({ title: "Close without saving?", body: "Your newest changes were not saved. If you close now, they are lost.", confirmLabel: "Close anyway", cancelLabel: "Keep editing", danger: true }))) return;
    onClose(server.current.last);
  }, [save, onClose, confirm]);

  // A full-screen dialog: focus starts in the text, stays inside, Escape closes (after saving), the page stays still.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const t = window.setTimeout(() => editor.current?.editor?.commands.focus("start"), 50);
    return () => { window.clearTimeout(t); document.body.style.overflow = overflow; before?.focus?.(); };
  }, []);
  const onKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !document.querySelector("[role=listbox]")) { event.preventDefault(); void close(); return; }
    if ((event.metaKey || event.ctrlKey) && (event.key ?? "").toLowerCase() === "s") { event.preventDefault(); void save(); return; }
    if (event.key === "Tab" && !(event.target as HTMLElement).closest?.(".ProseMirror")) {
      const all = Array.from(box.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input, textarea, a[href], [tabindex='0'], [contenteditable='true']") ?? []).filter((el) => el.getClientRects().length);
      const first = all[0], last = all.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  };
  const markConfirm = () => editor.current?.editor?.chain().focus().insertContent([{ type: "text", text: " " }, { type: "text", text: "(confirm)", marks: [{ type: "bold" }] }]).run();
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
          <button type="button" className={styles.btn} onClick={markConfirm} title="Mark as “(confirm)”: a question for HR before publishing"><CircleHelp size={16} aria-hidden="true" />Mark “confirm”</button>
          <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => void close()} disabled={state.tone === "saving"}>Done</button>
          <button type="button" className={styles.iconBtn} aria-label="Close the editor" onClick={() => void close()}><X size={16} aria-hidden="true" /></button>
        </header>
        <div className={css.rich}>
          <div className={css.richInner}>
            <label className={css.title}><span>Title</span><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} required autoComplete="off" /></label>
            <DocEditor ref={editor} html={startHtml} editable onChange={setHtml} features={{ mentions: false, blocks: false, images: false }} label="Policy text"
              placeholder="Write the policy. Type / for headings, lists and tables." />
            <p id={hintId} className={css.hint}>Type / for a heading, list or table. Mark open questions with “confirm”. Ctrl+S saves now. Employees see it exactly like this once you publish.</p>
          </div>
        </div>
      </div>
    </div>, document.body);
}
