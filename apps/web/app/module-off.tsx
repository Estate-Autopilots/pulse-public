import { ArrowRightLeft, ToggleLeft } from "lucide-react";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import type { PulseModule } from "@pulse/ui-shell";
import { api, getMe, type Me } from "./lib/api";
import { Empty, Page, styles } from "./ui";
import { OpenElsewhere } from "./open-elsewhere";

export const MODULE_OFF_TITLE = "This module is not switched on for your organisation.";

/** What an off module's page shows instead (EST-647): one neutral line and the way back. */
export function ModuleOff() {
  return (
    <Page>
      <section className={styles.panel}>
        <Empty icon={ToggleLeft} first title={MODULE_OFF_TITLE} text="Everything else in Pulse works as usual." action={{ href: "/dashboard", label: "Go to Dashboard" }} />
      </section>
    </Page>
  );
}

/** FIX-SHELL (owner, 10 Nov 2026: "Funding: I can't reach it from Estate Autopilots. Never show a dead page."): the
 *  person's other company where an organisation-only module is on (1947), where they are staff. */
export function moduleElsewhere(me: Me | null | undefined, key: string) {
  return me?.account?.orgs?.find((o) => !o.current && o.kind === "staff" && !!o.handle && o.orgOnly?.includes(key)) ?? null;
}

/** An organisation-only page opened in a company that does not have it, by someone who has it in another company:
 *  one card, one button that opens it there (/@handle/… switches company first). */
export function ModuleElsewhere({ name, handle, path }: { name: string; handle: string; path: string }) {
  return (
    <Page>
      <section className={styles.panel}>
        <Empty icon={ArrowRightLeft} first title={`This page is in ${name}`} text={`You are in another company right now. Open it in ${name}; you can switch back any time.`}
          action={{ href: `/@${handle}${path}`, label: `Open in ${name}` }} />
      </section>
    </Page>
  );
}

/** The layout of a switchable module's route folder. It decides on the server, on every navigation into the folder
 *  (a typed URL or a link), and shows the neutral page instead of the page; the module's API answers 404 as well, so
 *  an off page has no data to send. */
export function moduleLayout(key: PulseModule) {
  return async function ModuleLayout({ children }: { children: ReactNode }) {
    const me = (await getMe()).data;
    if (!me?.modules?.off?.includes(key)) return children;
    // FIX-SHELL: staff of another company that has this organisation-only module open it there (/@handle/…).
    const there = moduleElsewhere(me, key);
    if (there?.handle) {
      const h = await headers();
      const path = (h.get("x-pulse-path") ?? "/").replace(/^\/@[a-z0-9-]+/, "") || "/";
      return <ModuleElsewhere name={there.name} handle={there.handle} path={path + (h.get("x-pulse-search") ?? "")} />;
    }
    // UX-GAMIFY (owner, 9 Nov 2026; COMMON.md UI QUALITY GATE rule 6): an organisation-only module (one organisation
    // has it; nobody here can switch it on) never shows the dead page. Its page opens in the organisation that has it
    // when this person is an admin there (e.g. the org switcher kept /focus); otherwise the person goes home.
    if (ORG_ONLY.has(key)) {
      const home = (await api<{ org: { id: string; name: string } | null }>(`account/module-home/${key}`)).data?.org;
      if (home) return <OpenElsewhere org={home.id} name={home.name} what={ORG_ONLY.get(key) ?? "this page"} />;
      redirect("/");
    }
    return <ModuleOff />;
  };
}

/** Organisation-only modules (services/api/src/modules.ts ORG_ONLY) and what their page is called. */
const ORG_ONLY = new Map<PulseModule, string>([["focus", "Focus"], ["funding", "Funding"], ["pulse_hq", "Pulse HQ"]]);

/** An API read refused because its module is switched off: the API answers exactly like an unknown route. */
export const offModuleResponse = (r: { status?: number; error?: string }) => r.status === 404 && r.error === "Not Found";
