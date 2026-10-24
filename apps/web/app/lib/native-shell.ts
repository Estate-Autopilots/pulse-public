// The Pulse phone app is this web app inside a thin native shell (apps/mobile, Capacitor). The shell adds a few
// abilities a browser does not have; everything here is feature-detected, so in a normal browser `shell()` is null
// and the same code simply does nothing.
export type ShellInfo = {
  platform: "android" | "ios"; version: string; build: number | string; enrolled: boolean; deviceId: string | null; personId: string | null;
  notifications: boolean; pushReady: boolean; pushActive: boolean;
  /** POLISH-1 (shell 1.1.2+): what a request would do while notifications are off: the system prompt, or nothing. */
  notificationsAsk?: "granted" | "prompt" | "denied";
};
export type ShellUpdate = { available: boolean; current: string; version?: string; size?: number; notes?: string };
export type ShellWifi = { permission: "granted" | "denied" | "unsupported"; connected?: boolean; ssid?: string | null; bssid?: string | null };
export type ShellPresence = { enabled: boolean; offices: import("@pulse/companion").CompanionPayload["presence"]["offices"]; sites: [];
  /** PRESENCE-ONBOARD: the person's own automatic consent, HR's dwell, and what Android allows for office arrival. */
  auto?: boolean; dwellMinutes?: number; arrival?: { location: boolean; background: boolean } };
type Permission = "granted" | "denied" | "prompt" | "prompt-with-rationale";

/** The native methods (Android: PulseShellPlugin.java, iPhone: PulseShellPlugin.swift). Keep the three in step. */
export interface PulseShell {
  info(): Promise<ShellInfo>;
  status(): Promise<ShellInfo>;
  startEnrollment(): Promise<{ code: string; replaces: string | null }>;
  finishEnrollment(): Promise<{ deviceId: string }>;
  signOut(): Promise<void>;
  checkInbox(): Promise<void>;
  requestNotifications(): Promise<{ state: "granted" | "denied" }>;
  setBadge(options: { count: number }): Promise<void>;
  /** CHAT-VOICE (shell 1.1.5+): loudspeaker or earpiece during a call. Absent on older shells. */
  setSpeaker?(options: { on: boolean }): Promise<{ on: boolean }>;
  setTheme(options: { dark: boolean }): Promise<void>;
  setPushToken(options: { token: string | null }): Promise<void>;
  presencePreferences(options?: { enabled: boolean }): Promise<ShellPresence>;
  wifi(): Promise<ShellWifi>;
  location(): Promise<{ lat: number; lng: number; accuracy: number; at: number }>;
  checkUpdate(): Promise<ShellUpdate>;
  downloadUpdate(): Promise<{ version: string }>;
  installUpdate(): Promise<{ result: "installer" | "permission" }>;
  openInstallSettings(): Promise<void>;
  openNotificationSettings(): Promise<void>;
  openExternal(options: { url: string }): Promise<void>;
  saveFile(options: { name: string; mime: string; base64: string }): Promise<void>;
  checkPermissions(): Promise<{ location: Permission; notifications?: Permission; background?: Permission }>;
  requestPermissions(options: { permissions: ("location" | "notifications" | "background")[] }): Promise<{ location: Permission; notifications?: Permission; background?: Permission }>;
}
type Haptics = { impact(o: { style: "LIGHT" | "MEDIUM" | "HEAVY" }): Promise<void>; notification(o: { type: "SUCCESS" | "WARNING" | "ERROR" }): Promise<void> };
type Capacitor = { isNativePlatform?: () => boolean; getPlatform?: () => string; Plugins?: Record<string, unknown> };

function capacitor(): Capacitor | null {
  if (typeof window === "undefined") return null;
  const cap = (window as unknown as { Capacitor?: Capacitor }).Capacitor;
  return cap?.isNativePlatform?.() ? cap : null;
}

/** The shell's bridge, or null in a browser. */
export function shell(): PulseShell | null {
  return (capacitor()?.Plugins?.PulseShell as PulseShell | undefined) ?? null;
}

/** Server side: the shell adds "PulseShell/<version>" to the WebView's user agent. */
export function shellFromUserAgent(ua: string | null | undefined): "android" | "ios" | null {
  if (!ua || !/\bPulseShell\/\d/.test(ua)) return null;
  return /iPhone|iPad|iOS/.test(ua) ? "ios" : "android";
}

/** Server side: a phone (or the Pulse phone app), where wide layouts get a phone default. Tablets keep theirs. */
export function phoneUserAgent(ua: string | null | undefined): boolean {
  return !!ua && (/\bPulseShell\/\d/.test(ua) || /iPhone|iPod|Android.+Mobile/.test(ua)) && !/iPad|Tablet/.test(ua);
}

/** A short vibration for confirmations (check-in done, sent). No-op in a browser. */
export function haptic(kind: "light" | "success" | "warning" = "light") {
  const h = capacitor()?.Plugins?.Haptics as Haptics | undefined;
  if (!h) return;
  void (kind === "light" ? h.impact({ style: "LIGHT" }) : h.notification({ type: kind === "success" ? "SUCCESS" : "WARNING" })).catch(() => {});
}

/** Open a link outside Pulse: a Custom Tab in the app, a new tab in a browser. */
export function openOutside(url: string) {
  const s = shell();
  if (s && url.startsWith("https://")) { void s.openExternal({ url }); return; }
  window.open(url, "_blank", "noopener,noreferrer");
}

/** R21 Android surface extension. Absent in a browser, iOS and the 1.1.0 shell. */
export interface PulseAttendance {
  refresh(options: { personId: string }): Promise<void>;
  takeAction(options: { personId: string }): Promise<{ action?: "check-in" | "check-out"; personId?: string }>;
  ribbon(options?: { enabled: boolean }): Promise<{ enabled: boolean; permission: boolean }>;
}
export function attendanceShell(): PulseAttendance | null {
  return (capacitor()?.Plugins?.PulseAttendance as PulseAttendance | undefined) ?? null;
}
