import { Building2 } from "lucide-react";
import { redirect } from "next/navigation";
import { api, getMe } from "../../lib/api";
import { safeNext } from "../../lib/safe-next.mjs";
import { Empty, Page, styles } from "../../ui";
import { OpenThere } from "./open-there";

export const metadata = { title: "Opening…" };

/** FIX-SHELL (owner, 10 Nov 2026: "links must use app.vitalsos.ai, with company paths such as
 *  app.vitalsos.ai/@estateautopilots/…"): a company path. proxy.ts shows this page for /@handle/rest:
 *  - the session is already in that company: the page opens at once;
 *  - the person's account is in it too: the session switches there first, then the page opens;
 *  - otherwise one clear card and the way home (never someone else's page).
 *  Signed out, the layout sends the person to sign in and back to the same /@handle link. */
// ORG-PER-TAB: /at/<company id> too (the switcher's "Open in new tab", a record link of another company: ?opened=1 says
// "Opened in …" there). The company opens in this tab only.
export default async function CompanyPath({ params, searchParams }: { params: Promise<{ handle: string }>; searchParams: Promise<{ next?: string; opened?: string }> }) {
  const [{ handle }, q] = await Promise.all([params, searchParams]);
  const next = safeNext(q.next) ?? "/";
  const me = (await getMe()).data;
  const wanted = handle.toLowerCase();
  const byId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(wanted);
  const org = me?.account?.orgs?.find((o) => byId ? o.id === wanted : o.handle?.toLowerCase() === wanted);
  // A company-id link (new tab, a record of another company) always opens the company in this tab first, so the tab
  // keeps it (and says "Opened in …"); a /@handle link to the company already open goes straight on.
  if (!byId && q.opened !== "1" && (org?.current || me?.orgHandle?.toLowerCase() === wanted)) redirect(next);
  if (org) return <OpenThere org={org.id} name={org.name} next={next} opened={q.opened === "1"} />;
  // PERSONAL-MERGE: a company of mine that was merged into my personal space: the link opens there.
  const moved = me?.account ? (await api<{ redirect: { org: string } | null }>(`account/org-redirect?ref=${encodeURIComponent(wanted)}`)).data?.redirect : null;
  const into = moved ? me?.account?.orgs?.find((o) => o.id === moved.org) : undefined;
  if (into?.current) redirect(next);
  if (into) return <OpenThere org={into.id} name={into.name} next={next} opened />;
  return (
    <Page>
      <section className={styles.panel}>
        <Empty icon={Building2} first title={byId ? "This link is for another company" : `This link is for @${wanted}`}
          text="Your account is not in that company, so the page can't open here. Ask whoever sent the link to add you."
          action={{ href: "/", label: "Go to your Home" }} />
      </section>
    </Page>
  );
}
