"use client";
// The policy reader: the whole document on one scrolling page, typeset from its Markdown (headings, lists, tables),
// with a contents list that follows the reading position, a status bar for HR's actions and a print copy that the
// browser's Print / Save as PDF uses. HR desk → Policies and My desk → Policies both read through it.

import { createElement, Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import { PrintBrand } from "../print-brand";
import { createPortal } from "react-dom";
import {policyMarkdown} from "../lib/policy-format.mjs";
import { parseMarkdown, plain } from "../lib/markdown.mjs";
import type { Block, Inline, OutlineEntry } from "../lib/markdown.mjs";
import css from "./policy-reader.module.css";

function Inlines({ nodes }: { nodes: Inline[] }) {
  return <>{nodes.map((n, i) => {
    switch (n.type) {
      case "text": return <Fragment key={i}>{n.text}</Fragment>;
      case "strong": return <strong key={i}><Inlines nodes={n.children} /></strong>;
      case "em": return <em key={i}><Inlines nodes={n.children} /></em>;
      case "code": return <code key={i}>{n.text}</code>;
      case "break": return <br key={i} />;
      case "confirm": return <mark key={i} className={css.confirm} title="To be confirmed by HR and the founders before publishing">{n.text}</mark>;
      case "link": { const external = /^(https?:|mailto:)/i.test(n.href); return <a key={i} href={n.href} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}><Inlines nodes={n.children} /></a>; }
    }
  })}</>;
}

/** Headings sit under the page's own title (h2) and the panel level (h3), so a document's "#" is drawn as an h3. */
const tag = (level: number) => `h${Math.min(6, level + 2)}`;

/** The document's blocks as HTML elements. Tables keep their header for each cell, so phones can stack the rows.
 *  `anchors={false}` leaves out the heading ids (the print copy repeats the document). */
export function MarkdownBody({ blocks, anchors = true }: { blocks: Block[]; anchors?: boolean }) {
  return <>{blocks.map((b, i) => {
    switch (b.type) {
      case "heading": return createElement(tag(b.level), { key: i, id: anchors ? b.id : undefined, tabIndex: anchors ? -1 : undefined, "data-level": b.level }, <Inlines nodes={b.children} />);
      case "paragraph": return <p key={i}><Inlines nodes={b.children} /></p>;
      case "list": {
        const items = b.items.map((item, k) => <li key={k}><MarkdownBody blocks={item.children} anchors={anchors} /></li>);
        return b.ordered ? <ol key={i} start={b.start === 1 ? undefined : b.start} data-loose={b.loose ? "" : undefined}>{items}</ol> : <ul key={i} data-loose={b.loose ? "" : undefined}>{items}</ul>;
      }
      case "table": {
        const heads = b.head.map(plain);
        return <div key={i} className={css.tableWrap} role="region" aria-label={`Table: ${heads.join(", ")}`} tabIndex={0}><table>
          <thead><tr>{b.head.map((h, k) => <th key={k} scope="col" style={b.align[k] ? { textAlign: b.align[k]! } : undefined}><Inlines nodes={h} /></th>)}</tr></thead>
          <tbody>{b.rows.map((row, r) => <tr key={r}>{row.map((cell, k) => <td key={k} data-label={heads[k]} style={b.align[k] ? { textAlign: b.align[k]! } : undefined}><Inlines nodes={cell} /></td>)}</tr>)}</tbody>
        </table></div>;
      }
      case "quote": return <blockquote key={i}><MarkdownBody blocks={b.children} anchors={anchors} /></blockquote>;
      case "rule": return <hr key={i} />;
      case "code": return <pre key={i}><code>{b.text}</code></pre>;
    }
  })}</>;
}

/** The parsed document; a body without its own "# Title" gets the stored title on top. */
export function usePolicy(title: string, body: string) {
  return useMemo(() => {
    const doc = parseMarkdown(policyMarkdown(body));
    const titled = doc.blocks[0]?.type === "heading" && doc.blocks[0].level === 1;
    return { ...doc, blocks: titled ? doc.blocks : [{ type: "heading", level: 1, id: "document-title", children: [{ type: "text", text: title }] } as Block, ...doc.blocks] };
  }, [title, body]);
}

const noop = () => () => {};

function Contents({ outline, active, onGo }: { outline: OutlineEntry[]; active: string | null; onGo: (event: MouseEvent<HTMLAnchorElement>, id: string) => void }) {
  return <ol className={css.tocList}>{outline.map((o) => <li key={o.id} data-level={o.level}>
    <a href={`#${o.id}`} aria-current={o.id === active ? "location" : undefined} onClick={(event) => onGo(event, o.id)}>{o.text}</a>
  </li>)}</ol>;
}

/** The section being read: the last heading that has scrolled past the top of the reading area. */
function useActive(scroller: React.RefObject<HTMLDivElement | null>, outline: OutlineEntry[]) {
  const [active, setActive] = useState<string | null>(outline[0]?.id ?? null);
  useEffect(() => {
    const box = scroller.current; if (!box) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const top = Math.max(0, box.getBoundingClientRect().top) + 96;
      let current = outline[0]?.id ?? null;
      for (const o of outline) { const el = document.getElementById(o.id); if (el && el.getBoundingClientRect().top <= top) current = o.id; }
      // At the very end the last short sections can never reach the top line; the last one is then the current one.
      if (box.scrollHeight > box.clientHeight && box.scrollTop + box.clientHeight >= box.scrollHeight - 4) current = outline.at(-1)?.id ?? current;
      setActive(current);
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(measure); };
    frame = requestAnimationFrame(measure);
    // The reader scrolls itself on a desktop; on smaller screens the page (or the window) does. Scroll events do not
    // bubble, so one capturing listener hears all of them.
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => { document.removeEventListener("scroll", onScroll, { capture: true }); if (frame) cancelAnimationFrame(frame); };
  }, [scroller, outline]);
  return [active, setActive] as const;
}

/**
 * One policy document. `status` and `actions` fill the bar above it; `footer` (acknowledgement, history) follows the
 * text. The print copy repeats `status` above the document.
 */
export function PolicyReader({ title, body, status, actions, footer, label }: { title: string; body: string; status: ReactNode; actions?: ReactNode; footer?: ReactNode; label: string }) {
  const doc = usePolicy(title, body);
  const outline = useMemo(() => doc.outline.filter((o) => o.level > 1), [doc.outline]);
  const scroller = useRef<HTMLDivElement>(null);
  const [active, setActive] = useActive(scroller, outline);
  // The print copy lives on <body>, so it exists only in the browser (never in the server render).
  const printable = useSyncExternalStore(noop, () => true, () => false);
  const go = (event: MouseEvent<HTMLAnchorElement>, id: string) => {
    const el = document.getElementById(id); if (!el) return;
    event.preventDefault(); setActive(id);
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
    el.focus({ preventScroll: true });
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}#${id}`);
    (event.currentTarget.closest("details") as HTMLDetailsElement | null)?.removeAttribute("open");
  };
  // A new document opens at its top.
  useEffect(() => { scroller.current?.scrollTo({ top: 0 }); }, [title, label]);
  return <section className={css.reader} aria-label={label}>
    <header className={css.bar}>
      <div className={css.status}>{status}</div>
      {actions ? <div className={css.actions}>{actions}</div> : null}
    </header>
    <div ref={scroller} className={css.scroll} role="document" tabIndex={0} aria-label={`${label}: document text`}>
      <div className={css.layout} data-toc={outline.length > 1 ? "" : undefined}>
        {outline.length > 1 ? <details className={css.tocInline}><summary>Contents · {outline.length} sections</summary><nav aria-label="Contents"><Contents outline={outline} active={active} onGo={go} /></nav></details> : null}
        <article className={css.doc}>
          <MarkdownBody blocks={doc.blocks} />
          {footer ? <footer className={css.docFoot}>{footer}</footer> : null}
        </article>
        {outline.length > 1 ? <nav className={css.toc} aria-label="Contents"><p className={css.tocHead}>Contents</p><Contents outline={outline} active={active} onGo={go} /></nav> : null}
      </div>
    </div>
    {printable ? createPortal(<div className="pulse-print-root" aria-hidden="true"><PrintBrand /><div className={css.printMeta}>{status}</div><article className={css.doc}><MarkdownBody blocks={doc.blocks} anchors={false} /></article></div>, document.body) : null}
  </section>;
}
