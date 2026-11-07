import { redirect } from "next/navigation";

import { loadAccess } from "@/app/lib/access";
import { adminConfig } from "@/app/lib/config";
import { PulseMark } from "@/app/ui/shell";
import { SignInForm } from "./form";
import styles from "./login.module.css";

/** Sign in to the admin site with Pulse (PULSE-ADMIN). Behind Cloudflare Access too, on its own address. */
export default async function Login() {
  const access = await loadAccess();
  if (access.state === "verified") redirect("/");
  const config = adminConfig();
  return (
    <main id="admin-content" className={styles.page} tabIndex={-1}>
      <section className={styles.card} aria-labelledby="sign-in-title">
        <span className={styles.mark}><PulseMark size={22} /></span>
        <p className={styles.kicker}>{config.product} admin{config.environment === "development" ? " · development" : ""}</p>
        <h1 id="sign-in-title" className={styles.title}>Sign in with {config.product}</h1>
        <p className={styles.sub}>Your {config.product} username and password. Only {config.product}’s platform admins can use this console.</p>
        <SignInForm product={config.product} />
        {access.state === "refused" ? <p className={styles.note} role="status">{access.reason}</p> : null}
        <p className={styles.foot}>{config.company ? `${config.company} · ` : ""}{config.supportEmail ? <a href={`mailto:${config.supportEmail}`}>{config.supportEmail}</a> : "Back office"}</p>
      </section>
    </main>
  );
}
