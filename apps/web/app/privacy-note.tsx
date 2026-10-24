// FEATURES-1024 (owner via the coordinator, 24 Oct 2026): a short, plain note about what Pulse measures (TELEMETRY:
// telemetry-host.tsx, /telemetry), in Settings → Privacy and on the one-time card (telemetry-notice.tsx).
import { Panel, styles } from "./ui";

export const TELEMETRY_NOTE = {
  title: "Pulse measures its own speed",
  short: "To make Pulse faster, it measures taps and how long pages take to load. It never records what you type, your messages or passwords. Leadership can see summaries of activity.",
  toast: "It measures taps and load times to get faster, never what you type, your messages or passwords; leadership sees summaries.",
};

/** Settings → Privacy: what is measured, what never is, and who sees it. */
export function PrivacyPanel() {
  return <Panel title="Privacy" sub="What Pulse measures to get faster">
    <div id="privacy" style={{ padding: "12px 16px" }}>
      <ul className={styles.muted} style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
        <li>Pulse measures taps, page loads and how long things take, to find what is slow and fix it.</li>
        <li>It never records what you type, your messages, your files or your passwords.</li>
        <li>Leadership can see summaries of activity: which pages are used and how fast they are.</li>
      </ul>
    </div>
  </Panel>;
}
