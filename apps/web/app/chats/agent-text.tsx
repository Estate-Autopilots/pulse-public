"use client";
// AI-AGENTS-2 (owner, 17 Nov 2026: "numbered answers render badly"): an AI employee writes Markdown (numbered steps,
// bullets under them, **bold**, `code`, short headings), and the chat showed it as raw text: "**" marks, "1." lines
// whose wrapped words ran back under the number, "###" in front of a title. Its messages are typeset with the policy
// reader's parser (lib/markdown.mjs: no HTML passes through, links keep only http(s), mailto and in-app addresses),
// compact enough for a bubble. A message with no Markdown in it stays the plain paragraph it always was, and people's
// own messages are never parsed (a WhatsApp "*bold*" or "1)" means what they typed).
import { createElement, Fragment, useMemo, type ReactNode } from "react";
import { parseMarkdown } from "../lib/markdown.mjs";
import { looksLikeMarkdown } from "../lib/chat-format.mjs";
import { inAppPage } from "../lib/panel-target.mjs";
import { openInPanel } from "./workspace/tabs";
export { looksLikeMarkdown };
import type { Block, Inline } from "../lib/markdown.mjs";
import css from "./agent-text.module.css";

type Run = (text: string, key: string) => ReactNode;

function Inlines({ nodes, run, at }: { nodes: Inline[]; run: Run; at: string }) {
  return <>{nodes.map((n, i) => {
    const k = `${at}.${i}`;
    switch (n.type) {
      case "text": return <Fragment key={k}>{run(n.text, k)}</Fragment>;
      case "strong": return <strong key={k}><Inlines nodes={n.children} run={run} at={k} /></strong>;
      case "em": return <em key={k}><Inlines nodes={n.children} run={run} at={k} /></em>;
      case "code": return <code key={k}>{n.text}</code>;
      case "break": return <br key={k} />;
      case "confirm": return <Fragment key={k}>{n.text}</Fragment>;
      // WL-ONBOARD-FIX (Sakobe's quotation link opened a new tab): a Markdown link to a page of this app opens in the side
      // panel like a plain link in a message; Ctrl/Cmd/Shift-click still opens a tab; other sites keep a new tab.
      case "link": { const external = /^(https?:|mailto:)/i.test(n.href); return <a key={k} href={n.href} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; if (inAppPage(n.href, window.location.origin) && openInPanel({ href: n.href })) e.preventDefault(); }}><Inlines nodes={n.children} run={(t) => t} at={k} /></a>; }
    }
  })}</>;
}

function Blocks({ blocks, run, at }: { blocks: Block[]; run: Run; at: string }) {
  return <>{blocks.map((b, i) => {
    const k = `${at}/${i}`;
    switch (b.type) {
      // A heading in a chat answer is a bold line, never a page-sized title.
      case "heading": return createElement("p", { key: k, className: css.heading }, <Inlines nodes={b.children} run={run} at={k} />);
      case "paragraph": return <p key={k}><Inlines nodes={b.children} run={run} at={k} /></p>;
      case "list": {
        const items = b.items.map((item, j) => <li key={`${k}-${j}`}><Blocks blocks={item.children} run={run} at={`${k}-${j}`} /></li>);
        return b.ordered ? <ol key={k} start={b.start === 1 ? undefined : b.start}>{items}</ol> : <ul key={k}>{items}</ul>;
      }
      case "table": return <div key={k} className={css.table} role="region" aria-label="Table" tabIndex={0}><table>
        <thead><tr>{b.head.map((h, j) => <th key={j} scope="col"><Inlines nodes={h} run={run} at={`${k}h${j}`} /></th>)}</tr></thead>
        <tbody>{b.rows.map((row, r) => <tr key={r}>{row.map((cell, j) => <td key={j}><Inlines nodes={cell} run={run} at={`${k}r${r}c${j}`} /></td>)}</tr>)}</tbody>
      </table></div>;
      case "quote": return <blockquote key={k}><Blocks blocks={b.children} run={run} at={k} /></blockquote>;
      case "rule": return <hr key={k} />;
      case "code": return <pre key={k}><code>{b.text}</code></pre>;
    }
  })}</>;
}

/** An AI employee's message, typeset. `run` draws a plain run of text (mentions and bare links, as the chat does). */
export function AgentText({ body, run, tail }: { body: string; run: Run; tail?: ReactNode }) {
  const blocks = useMemo(() => parseMarkdown(body).blocks, [body]);
  return <div className={css.md} data-find-text="" data-agent-md="">
    <Blocks blocks={blocks} run={run} at="m" />{tail}
  </div>;
}
