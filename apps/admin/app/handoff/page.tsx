import { adminConfig } from "@/app/lib/config";
import { PulseMark } from "@/app/ui/shell";
import styles from "../login/login.module.css";
import { Handoff } from "./handoff";

/** SETTINGS-APPLE (T1.3.4): where Pulse's Admin console link lands; signs the platform admin in without a second sign-in. */
export default function HandoffPage() {
  const config = adminConfig();
  return (
    <main id="admin-content" className={styles.page} tabIndex={-1}>
      <section className={styles.card} aria-labelledby="handoff-title">
        <span className={styles.mark}><PulseMark size={22} /></span>
        <p className={styles.kicker}>{config.product} admin</p>
        <h1 id="handoff-title" className={styles.title}>Admin console</h1>
        <div className={styles.sub}><Handoff pulse={config.appUrl} /></div>
      </section>
    </main>
  );
}
