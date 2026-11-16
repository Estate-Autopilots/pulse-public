import { EyeOff } from "lucide-react";
import { Empty, Page, styles } from "../ui";

/** EST-1420: what a screen the organisation hides from this person's role shows instead: the /hidden page (a direct
 *  link, redirected before the page renders) and the navigation gate (an in-app link, back or forward). An admin gets
 *  the way to show it again; nothing about the hidden page is shown. */
export function HiddenNotice({ admin, client }: { admin: boolean; /** E2E-4P: a client's seat: the organisation they are a client of. */ client?: string | null }) {
  if (client !== undefined && client !== null) return (
    <Page>
      <section className={styles.panel}>
        <Empty icon={EyeOff} first title="Not part of your access"
          text={`You are here as a client of ${client || "this organisation"}: the work and chats they share with you are in Work and Chats.`}
          action={{ href: "/tasks", label: "Go to your work" }} />
      </section>
    </Page>
  );
  return (
    <Page>
      <section className={styles.panel}>
        <Empty icon={EyeOff} first title="Hidden by your admin"
          text={admin ? "Your organisation hides this screen for your role. Show it again in Settings → Modules → Screens and menu." : "Your organisation hides this screen for your role. Ask an admin if you need it."}
          action={admin ? { href: "/settings?tab=organisation&section=Modules", label: "Open Settings → Modules" } : { href: "/dashboard", label: "Go to Dashboard" }} />
      </section>
    </Page>
  );
}
