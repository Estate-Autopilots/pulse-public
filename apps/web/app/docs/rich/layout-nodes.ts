// DOCS-RICH: layout in a doc. A toggle (a line you open to see more: <details data-type="toggle"><summary>…</summary>
// <div data-type="toggle-content">…</div></details>) and columns (2 or 3 side by side: <div data-type="columns"
// data-count="2"><div data-type="column">…</div>…</div>), stacked one under another on a phone. The same HTML is what the
// API keeps (docs.ts sanitiser) and what Markdown carries (turndown rules there).
import { Node, mergeAttributes, type Editor } from "@tiptap/react";

export const ToggleSummary = Node.create({
  name: "toggleSummary", content: "inline*", defining: true, selectable: false,
  parseHTML() { return [{ tag: "summary" }]; },
  renderHTML({ HTMLAttributes }) { return ["summary", mergeAttributes(HTMLAttributes), 0]; },
});
export const ToggleContent = Node.create({
  name: "toggleContent", content: "block+", defining: true, selectable: false,
  parseHTML() { return [{ tag: 'div[data-type="toggle-content"]' }]; },
  renderHTML({ HTMLAttributes }) { return ["div", mergeAttributes(HTMLAttributes, { "data-type": "toggle-content" }), 0]; },
});
/** Open or closed is the reader's own (never saved): open while you edit, closed for readers until they open it. */
export const Toggle = Node.create({
  name: "toggle", group: "block", content: "toggleSummary toggleContent", defining: true, draggable: true,
  parseHTML() { return [{ tag: "details" }]; },
  renderHTML({ HTMLAttributes }) { return ["details", mergeAttributes(HTMLAttributes, { "data-type": "toggle" }), 0]; },
  addNodeView() {
    return ({ editor }) => {
      const dom = document.createElement("div");
      dom.setAttribute("data-type", "toggle");
      dom.dataset.open = editor.isEditable ? "1" : "0";
      const button = document.createElement("button");
      button.type = "button"; button.contentEditable = "false"; button.className = "pulse-toggle-btn";
      const sync = () => { const on = dom.dataset.open === "1"; button.setAttribute("aria-expanded", String(on)); button.setAttribute("aria-label", on ? "Close this part" : "Open this part"); };
      button.addEventListener("mousedown", (e) => e.preventDefault());
      button.addEventListener("click", () => { dom.dataset.open = dom.dataset.open === "1" ? "0" : "1"; sync(); });
      sync();
      const body = document.createElement("div");
      body.className = "pulse-toggle-body";
      dom.append(button, body);
      return { dom, contentDOM: body, ignoreMutation: (m) => m.target === dom || m.target === button };
    };
  },
});

export const Column = Node.create({
  name: "column", content: "block+", isolating: true, selectable: false,
  parseHTML() { return [{ tag: 'div[data-type="column"]' }]; },
  renderHTML({ HTMLAttributes }) { return ["div", mergeAttributes(HTMLAttributes, { "data-type": "column" }), 0]; },
});
export const Columns = Node.create({
  name: "columns", group: "block", content: "column{2,3}", defining: true, draggable: true,
  addAttributes() { return { count: { default: 2, parseHTML: (el: HTMLElement) => el.getAttribute("data-count") === "3" ? 3 : 2, renderHTML: (a: { count?: number }) => ({ "data-count": a.count === 3 ? "3" : "2" }) } }; },
  parseHTML() { return [{ tag: 'div[data-type="columns"]' }]; },
  renderHTML({ HTMLAttributes }) { return ["div", mergeAttributes(HTMLAttributes, { "data-type": "columns" }), 0]; },
});
export const LAYOUT_NODES = [ToggleSummary, ToggleContent, Toggle, Column, Columns];

export function insertToggle(e: Editor) {
  e.chain().focus().insertContent({ type: "toggle", content: [{ type: "toggleSummary", content: [{ type: "text", text: "Open to see more" }] },
    { type: "toggleContent", content: [{ type: "paragraph" }] }] }).run();
}
export function insertColumns(e: Editor, count: 2 | 3 = 2) {
  e.chain().focus().insertContent({ type: "columns", attrs: { count }, content: Array.from({ length: count }, () => ({ type: "column", content: [{ type: "paragraph" }] })) }).run();
}
