import { ToggleLeft } from "lucide-react";
import type { ReactNode } from "react";
import type { PulseModule } from "@pulse/ui-shell";
import { api, type Me } from "./lib/api";
import { Empty, Page, styles } from "./ui";

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

/** The layout of a switchable module's route folder. It decides on the server, on every navigation into the folder
 *  (a typed URL or a link), and shows the neutral page instead of the page; the module's API answers 404 as well, so
 *  an off page has no data to send. */
export function moduleLayout(key: PulseModule) {
  return async function ModuleLayout({ children }: { children: ReactNode }) {
    const me = (await api<Me>("me")).data;
    return me?.modules?.off?.includes(key) ? <ModuleOff /> : children;
  };
}

/** An API read refused because its module is switched off: the API answers exactly like an unknown route. */
export const offModuleResponse = (r: { status?: number; error?: string }) => r.status === 404 && r.error === "Not Found";
