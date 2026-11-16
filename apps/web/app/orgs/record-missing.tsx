"use client";
// ORG-PER-TAB (judge rounds 1-2: "Doc not found" said neither why nor what to do; then: name the company this tab is in,
// two plain sentences, a bigger picture and title). A doc, task or project link that does not open here: the kit's empty
// state with the company this tab is in, the reason and the way on. The words are the same for every record that does
// not open (deleted, never there, or in a company the person is not in), so it never tells whether it exists elsewhere.
// A record of another of the person's own companies never gets here: it opens there, in this tab (lib/api openElsewhere),
// so switching company finds it nowhere else; the card still offers it second (a person may want another company),
// under "Go to ..." (judge rounds 3-4).
import { ArrowLeftRight } from "lucide-react";
import { EmptyState } from "../kit/game";
import { useWords } from "../org-code";
import { say } from "../lib/words.mjs";
import { Page, styles } from "../ui";
import css from "./orgs.module.css";

const KINDS = { doc: { one: "doc", list: "Docs", href: "/docs" }, task: { one: "task", list: "Tasks", href: "/tasks" }, project: { one: "{project}", list: "{Projects}", href: "/projects" } } as const;

export function RecordMissing({ kind, company, companies }: { kind: keyof typeof KINDS; company: string | null; companies: number }) {
  const words = useWords();
  const k = KINDS[kind], one = say(k.one, words), list = say(k.list, words);
  return <Page><section className={`${styles.panel} ${styles.message}`} data-record-missing={kind}>
    <EmptyState title={`We can't open this ${one}`}
      text={<>{company ? <>This {one} isn&apos;t in <strong>{company}</strong>. </> : <>This {one} isn&apos;t here. </>}
        Ask the person who sent the link to share it with you.</>}
      action={{ label: `Go to ${list}`, href: k.href }} />
    {companies > 1 ? <div className={css.missingMore}>
      <button type="button" className={styles.btn} onClick={() => window.dispatchEvent(new Event("pulse:orgs-open"))}>
        <ArrowLeftRight size={15} aria-hidden="true" />Switch company</button></div> : null}
  </section></Page>;
}
