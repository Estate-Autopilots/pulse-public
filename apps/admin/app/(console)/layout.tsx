import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { loadAccess } from "@/app/lib/access";
import { adminConfig } from "@/app/lib/config";
import { ConsoleShell } from "@/app/ui/shell";
import { Page, kitStyles } from "@/app/ui/kit";

/** Every console page shares one frame; who is signed in is read once, on the server. Platform admins only. */
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const access = await loadAccess();
  if (access.state === "signed-out") redirect("/login");
  if (access.state !== "verified") {
    return (
      <main id="admin-content" tabIndex={-1}>
        <Page>
          <section className={kitStyles.panel} role="alert">
            <div className={kitStyles.empty}>
              <p className={kitStyles.emptyTitle}>{access.state === "unavailable" ? "The admin console can’t reach Pulse" : "This console is for Pulse’s platform admins"}</p>
              <p className={kitStyles.emptyText}>{access.reason ?? "Nothing was changed."}</p>
              <a className={kitStyles.button} href="/auth/sign-out">Sign in as someone else</a>
            </div>
          </section>
        </Page>
      </main>
    );
  }
  return <ConsoleShell access={access} config={adminConfig()}>{children}</ConsoleShell>;
}
