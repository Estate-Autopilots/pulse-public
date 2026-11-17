// BUG-REPORT (owner, 27 Oct 2026): the app, build and device a report came from: what the team needs to reproduce it,
// nothing personal. The API keeps only these fields (bug-report-model.ts cleanContext); who sent it and from which
// company it knows from the sign-in.
import { platformOf, screenOf } from "../lib/telemetry.mjs";

export type ReportContext = Record<string, string | number | boolean>;

/** "Android 14", "iOS 18.2", "Windows", "macOS" or "Linux". */
export function osFrom(ua: string): string | undefined {
  const android = /Android (\d+(?:\.\d+)?)/.exec(ua);
  if (android) return `Android ${android[1]}`;
  const ios = /(?:iPhone|iPad|iPod).*? OS (\d+)_(\d+)/.exec(ua);
  if (ios) return `iOS ${ios[1]}.${ios[2]}`;
  if (/Windows/.test(ua)) return "Windows";
  if (/Mac OS X/.test(ua)) return "macOS";
  if (/Linux|CrOS/.test(ua)) return "Linux";
  return undefined;
}

/** "Chrome 141", "Edge 141", "Firefox 132", "Safari 18" or "Android WebView 141". */
export function browserFrom(ua: string): string | undefined {
  const pick = (pattern: RegExp, name: string) => { const m = pattern.exec(ua); return m ? `${name} ${m[1]}` : undefined; };
  if (/; wv\)|PulseShell\//.test(ua)) return pick(/Chrome\/(\d+)/, "Android WebView") ?? pick(/Version\/(\d+)/, "WebKit");
  return pick(/Edg\/(\d+)/, "Edge") ?? pick(/SamsungBrowser\/(\d+)/, "Samsung Internet") ?? pick(/Firefox\/(\d+)/, "Firefox")
    ?? pick(/Chrome\/(\d+)/, "Chrome") ?? pick(/Version\/(\d+).*Safari/, "Safari");
}

/** Where the report was made: the platform, the app's version, the screen and the device. */
export function reportContext(release: string): { platform: string; appVersion: string; route: string; context: ReportContext } {
  const ua = navigator.userAgent;
  const { plat, shell } = platformOf(ua, window as unknown as Record<string, unknown>);
  const nav = navigator as Navigator & { connection?: { effectiveType?: string }; deviceMemory?: number };
  const media = (q: string) => { try { return window.matchMedia(q).matches; } catch { return false; } };
  const theme = document.documentElement.dataset.theme;
  const context: ReportContext = {
    release, ...(shell ? { shell } : {}),
    ...(osFrom(ua) ? { os: osFrom(ua)! } : {}), ...(browserFrom(ua) ? { browser: browserFrom(ua)! } : {}),
    viewport: `${window.innerWidth}x${window.innerHeight}`, screen: `${window.screen.width}x${window.screen.height}`,
    pixelRatio: Math.round(window.devicePixelRatio * 100) / 100, touch: media("(pointer: coarse)"), online: navigator.onLine,
    standalone: media("(display-mode: standalone)"), language: navigator.language, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    theme: theme === "dark" || theme === "light" ? theme : media("(prefers-color-scheme: dark)") ? "dark" : "light",
    ...(nav.connection?.effectiveType ? { connection: nav.connection.effectiveType } : {}),
    ...(typeof nav.deviceMemory === "number" ? { memoryGb: nav.deviceMemory } : {}),
  };
  return { platform: plat, appVersion: shell ? `${release}+shell-${shell}`.slice(0, 60) : release.slice(0, 60), route: screenOf(window.location.href) ?? "/", context };
}
