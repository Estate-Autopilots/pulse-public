"use client";
// R41: HR edits a policy's Word file in the approved browser editor (ONLYOFFICE Docs), full screen. Pulse opens a
// session for exactly this version and revision; the editor service saves the file back to Pulse a few seconds after
// the editor closes (or on Ctrl+S), and Pulse refuses the save if the policy changed meanwhile. Only offered on wide
// screens while Word editing is switched on; phones keep the reader (and the Markdown editor).

import { X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { styles } from "../ui";
import css from "./policy-editor.module.css";

export type WordStatus = { enabled: boolean; provider: "onlyoffice"; reason: string | null; label: string; fidelitySignedOff: boolean; maxBytes: number };
type DocEditor = { destroyEditor: () => void };
type DocsApi = { DocEditor: new (placeholder: string, config: Record<string, unknown>) => DocEditor };

/** Loads the editor service's script once (the page's CSP allows it through the nonced app script). */
function loadScript(src: string): Promise<void> {
  const existing = document.querySelector<HTMLScriptElement>(`script[data-policy-word="${CSS.escape(src)}"]`);
  if (existing?.dataset.loaded === "1") return Promise.resolve();
  return new Promise((done, failed) => {
    const script = existing ?? Object.assign(document.createElement("script"), { src, async: true });
    script.dataset.policyWord = src;
    script.addEventListener("load", () => { script.dataset.loaded = "1"; done(); }, { once: true });
    script.addEventListener("error", () => failed(new Error("The Word editor service did not answer. Try again, or edit the text in Pulse.")), { once: true });
    if (!existing) document.head.append(script);
  });
}

export function PolicyWordEditor({ documentId, kindLabel, onClose }: { documentId: string; kindLabel: string; onClose: (opened: boolean) => void }) {
  const [state, setState] = useState<{ tone: "idle" | "saved" | "error"; text: string }>({ tone: "idle", text: "Opening the Word editor…" });
  const opened = useRef(false), titleId = useId(), holder = `policy-word-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;

  useEffect(() => {
    let editor: DocEditor | null = null, cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/v0/hr/policies/word-session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ documentId }) });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error ?? "The Word editor did not open.");
        await loadScript(data.script);
        const api = (window as unknown as { DocsAPI?: DocsApi }).DocsAPI;
        if (cancelled) return;
        if (!api) throw new Error("The Word editor service did not answer. Try again, or edit the text in Pulse.");
        editor = new api.DocEditor(holder, { ...data.config, width: "100%", height: "100%", type: "desktop",
          events: { onAppReady: () => { opened.current = true; setState({ tone: "idle", text: (data.word as WordStatus).label }); }, onError: () => setState({ tone: "error", text: "The Word editor reported a problem. Close it and open it again." }) } });
      } catch (e) { setState({ tone: "error", text: e instanceof Error ? e.message : "The Word editor did not open." }); }
    })();
    return () => { cancelled = true; editor?.destroyEditor(); };
  }, [documentId, holder]);

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = overflow; before?.focus?.(); };
  }, []);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className={css.backdrop}>
      <div className={css.editor} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onClose(opened.current); } }}>
        <header className={css.head}>
          <div className={css.headText}>
            <h2 id={titleId}>Edit the {kindLabel.toLowerCase()} policy in Word</h2>
            <p role="status" aria-live="polite" data-tone={state.tone}>{state.text}</p>
          </div>
          <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => onClose(opened.current)}>Done</button>
          <button type="button" className={styles.iconBtn} aria-label="Close the Word editor" onClick={() => onClose(opened.current)}><X size={16} aria-hidden="true" /></button>
        </header>
        <div className={css.word}><div id={holder} /></div>
      </div>
    </div>, document.body);
}

/** A Word file as base64 for the upload, refused early when it cannot be a .docx under the limit. */
export async function docxBase64(file: File, maxBytes: number): Promise<string> {
  if (!/\.docx$/i.test(file.name)) throw new Error("Choose a Word document (.docx).");
  if (file.size > maxBytes) throw new Error(`A Word file can be at most ${Math.round(maxBytes / 1048576)} MB.`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
