// FEATURES-1024 (owner via the coordinator, 24 Oct 2026): a short, plain note about what Pulse measures (TELEMETRY:
// telemetry-host.tsx, /telemetry), in Settings → Privacy and on the one-time card (telemetry-notice.tsx).
// BUGKIT-TELEMETRY (6 Nov 2026): the note now says Pulse records how the app is used (session replay included), and the
// company's admins choose what is recorded and for how long (usage-settings.tsx).
import { Panel, styles } from "./ui";
import { UsageSettings } from "./usage-settings";

export const TELEMETRY_NOTE = {
  title: "Pulse records how the app is used to improve it",
  short: "To make Pulse easier and faster, it records pages, clicks, speed, errors and replays of how screens moved. It never records what you type, your passwords or private areas. Leadership can see summaries and replays.",
  toast: "Pages, clicks, speed and replays of how screens moved, never what you type or your passwords; leadership sees summaries.",
};

/** Settings → Privacy: what is recorded, what never is, who sees it, and (for admins) the company's switches. */
export function PrivacyPanel() {
  return <Panel title="Privacy" sub={TELEMETRY_NOTE.title}>
    <div id="privacy" style={{ padding: "12px 16px" }}>
      <ul className={styles.muted} style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
        <li>Pulse records how the app is used to improve it: pages, taps and clicks, how long things take, errors, where people get stuck, and replays of how screens moved.</li>
        <li>It never records what you type, your passwords or keystrokes. Fields, money and personal pages are hidden in replays on your device, before anything is sent.</li>
        <li>Everything stays on Pulse’s own servers, in your company only. Nothing goes to another analytics service.</li>
        <li>Leadership can see summaries and replays to find what is slow or confusing. Admins choose what is recorded and how long it is kept (30 days unless changed).</li>
      </ul>
      <UsageSettings />
    </div>
  </Panel>;
}
