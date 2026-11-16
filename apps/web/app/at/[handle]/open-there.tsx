"use client";
import { Building2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { arrive, openInTab } from "../../orgs/client";
import { Empty, Page, styles } from "../../ui";

/** FIX-SHELL: switch the session to the link's company, then open the page there (the shell shows "Opening …"). */
export function OpenThere({ org, name, next, opened = false }: { org: string; name: string; next: string; opened?: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const go = () => {
    setError(null);
    openInTab(org).then((moved) => arrive(moved, next, opened)).catch((e: unknown) => setError(e instanceof Error ? e.message : "That did not work. Try again."));
  };
  useEffect(() => { if (started.current) return; started.current = true; go(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Page>
      <section className={styles.panel} aria-live="polite">
        {error
          ? <Empty icon={Building2} first title={`Couldn't open ${name}`} text={error}><button type="button" className={styles.btn} onClick={go}>Try again</button></Empty>
          : <Empty icon={Building2} first title={`Opening ${name}…`} text="Opening that company in this tab. Your other tabs stay where they are." />}
      </section>
    </Page>
  );
}
