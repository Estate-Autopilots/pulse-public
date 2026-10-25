// The employee's first run (PRESENCE-ONBOARD): about three minutes on a phone. Details, emergency contact, bank
// details for payroll, documents (Aadhaar masked, PAN, photo, whatever else HR asks for), the app, notifications,
// office-arrival consent and the staff notice. Every step saves on its own; "Later" is always allowed.
import { headers } from "next/headers";
import { Lock } from "lucide-react";
import { api, getMe } from "../lib/api";
import { readDownloads } from "../settings/downloads";
import { installOrigin } from "../lib/app-updates";
import { Empty, Message, Page, styles } from "../ui";
import type { CompanionDay } from "../lib/companion-day";
import type { OnboardingState } from "./types";
import { Wizard } from "./wizard";

export default async function Welcome({ searchParams }: { searchParams: Promise<{ step?: string; person?: string }> }) {
  const q = await searchParams;
  const me = await getMe();
  if (me.error) return <Message text={me.error} />;
  if (!me.data?.person) return <Page><section className={styles.panel}><Empty icon={Lock} first title="Onboarding is for one person" text="This is a shared login. Sign in with your own account to fill in your details." /></section></Page>;
  // HR (and leadership) can open someone's onboarding to help: ?person=<id>.
  const target = q.person && q.person !== me.data.person ? q.person : null;
  const [state, day, downloads] = await Promise.all([
    api<OnboardingState>(target ? `onboarding/${encodeURIComponent(target)}` : "onboarding"),
    api<CompanionDay>("companion"),
    headers().then((h) => readDownloads(installOrigin(h))),
  ]);
  if (state.error || !state.data) return <Message text={state.error ?? "Onboarding is not available right now"} />;
  // Install pages are public (/apps/<platform>), so the QR code works on a phone that is not signed in yet.
  const has = (platform: string) => downloads?.files.some((f) => f.platform === platform) ?? false;
  const installs = [["android", "Android phone", "/apps/android"], ["windows", "Windows computer", "/apps/windows"], ["macos", "Mac", "/apps/mac"], ["chrome", "Chrome", "/apps/chrome"]]
    .filter(([platform]) => has(platform)).map(([platform, label, href]) => ({ platform, label, href }));
  // The QR install link points at this install: the configured public URL, else the host the page was requested on.
  const h = await headers();
  const origin = process.env.PULSE_PUBLIC_URL ?? `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host") ?? ""}`;
  return <Wizard initial={state.data} step={q.step ?? null} autoAllowed={day.data?.presence?.autoCheckIn === true} offices={day.data?.presence?.offices?.length ?? 0}
    attendance={day.data?.attendanceEnabled === true} checkedIn={!!day.data?.entry} installs={installs} origin={origin} />;
}
