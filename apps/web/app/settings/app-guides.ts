// How to install Pulse on each platform, in plain words. Shared by Settings → Devices → Get the apps and the public
// install pages (/apps/windows, /apps/mac, …) that are sent to testers.
import type { AppFile } from './downloads';

// Pulse Desktop asks for the company's Pulse address before sign-in (EST-657): the step names this install's own.
const ADDRESS = '{address}';

export type Guide = {
  key: AppFile['platform']; slug: string; title: string; what: string; kinds: { kind: string; label: string }[]; steps: string[];
  pending?: string; shots: { src: string; alt: string }[];
};

export const GUIDES: Guide[] = [
  { key: 'windows', slug: 'windows', title: 'Windows', what: 'The full Pulse in its own window, plus a quick panel in the tray by the clock for one-click check-in, inbox and chats.',
    kinds: [{ kind: 'exe', label: 'Setup (.exe)' }, { kind: 'msi', label: 'Managed installer (.msi)' }],
    steps: [
      'Download Setup (.exe) and open it. Windows may say it protected your PC, because Pulse is not signed by Microsoft yet: choose More info → Run anyway.',
      'Pulse installs for your Windows account in a few seconds (no administrator needed) and opens the Pulse window.',
      `When Pulse asks for your company’s Pulse address, enter ${ADDRESS}.`,
      'Choose Sign in with your Pulse account and approve the code in your browser. That is the only sign-in: the Pulse window, the quick panel and pings all use it.',
      'Pulse is in the Start menu and in the tray by the clock (^). Click the tray icon or press Ctrl+Alt+P for the quick panel.',
      'Allow notifications when Windows asks, so messages and approvals reach you. If a ping can ever not arrive, the panel shows one Fix button.',
      'Updates arrive by themselves: Pip offers Install and restart when you are not in the middle of something, and you stay signed in.',
    ],
    shots: [{ src: '/apps/windows-panel.png', alt: 'The Pulse quick panel above the Windows taskbar' }, { src: '/apps/settings.png', alt: 'Pulse Settings: General, Notifications, Check-in & presence, Privacy & permissions, Account, Updates & about' }] },
  { key: 'macos', slug: 'mac', title: 'Mac', what: 'The full Pulse in its own window with the Mac title bar and menus, plus a quick panel under the menu-bar icon.',
    kinds: [{ kind: 'dmg', label: 'Disk image (.dmg)' }],
    steps: [
      'Download the disk image (.dmg), open it and drag Pulse into Applications.',
      'The first time, right-click Pulse in Applications → Open → Open. Pulse is signed by its publisher but not yet notarised by Apple. If macOS refuses: System Settings → Privacy & Security → Open Anyway.',
      `When Pulse asks for your company’s Pulse address, enter ${ADDRESS}.`,
      'Choose Sign in with your Pulse account and approve the code in your browser.',
      'Allow notifications when asked. For office check-in on Wi-Fi, turn on Office presence in Settings; macOS then asks for Location so Pulse can read the Wi-Fi name.',
      'Pulse sits in the Dock while its window is open and in the menu bar always. ⌃⌥P opens the quick panel; ⌘K searches in the Pulse window.',
      'Updates install themselves and keep you signed in, with no Keychain password prompts. Coming from a test version before 1.0? Pulse asks you to sign in once more.',
    ],
    shots: [{ src: '/apps/mac-panel.png', alt: 'The Pulse quick panel under the Mac menu bar' }, { src: '/apps/settings.png', alt: 'Pulse Settings on a Mac' }] },
  { key: 'android', slug: 'android', title: 'Android', what: 'The full Pulse as a phone app: the same Pulse as on the website, with notifications for messages and requests, Pulse links that open in the app, and check-in on Today.',
    kinds: [{ kind: 'apk', label: 'App (.apk)' }],
    steps: [
      'Open this page on your phone and download the app (.apk).',
      'When Android asks, allow your browser to install apps (Settings → Install unknown apps). Already have the earlier Pulse app? Open it once while online so any saved check-ins reach Pulse, then install this over it: no need to uninstall.',
      'Open Pulse and sign in with your Pulse username and password, the same as on the website. You stay signed in, and this phone appears in Settings → Devices, where you can sign it out.',
      'Settings → Devices → This phone → Turn on notifications, so new messages, requests waiting for you and decisions on yours reach you.',
      'Pulse links in emails and chats open in the app; payslips and policies open in your PDF viewer. Pull down at the top of a page to refresh it.',
      'Updates: Settings → Devices → This phone → Check for updates. Android asks you to confirm the install.',
    ],
    shots: [{ src: '/apps/android-today.png', alt: 'Pulse’s web app on a phone: My desk and Today, shown with synthetic data' }] },
  { key: 'ios', slug: 'iphone', title: 'iPhone', what: 'The same Pulse phone app as on Android, for iPhone. It installs through Apple’s TestFlight once Pulse’s Apple account is ready.',
    kinds: [],
    steps: [
      'We’ll email testers a TestFlight invitation when the iPhone app is available. Install Apple’s TestFlight app, open your invitation, and Pulse installs.',
      'Until then, open Pulse in Safari and choose Share → Add to Home Screen: it opens like an app, signed in, with the same screens.',
      'Sign in once with your Pulse username and password; the iPhone appears in Settings → Devices.',
    ],
    pending: 'TestFlight invites coming soon', shots: [] },
  { key: 'chrome', slug: 'chrome', title: 'Chrome', what: 'A toolbar button with the same check-in buttons, timer and Pip. Work-context features stay off unless you turn them on.',
    kinds: [{ kind: 'zip', label: 'Extension (.zip)' }],
    steps: [
      'Download and unzip the extension into a folder you keep (for example Documents/Pulse Chrome).',
      'Open chrome://extensions and switch on Developer mode (top right).',
      'Load unpacked → choose the unzipped folder. Pin Pulse with the puzzle-piece icon.',
      'Click Pulse → Sign in with your Pulse account → approve the code.',
    ],
    shots: [] },
];
export const guideBySlug = (slug: string) => GUIDES.find((g) => g.slug === slug) ?? null;
/** A guide's steps for this install's address; without a known address the address step is left out. */
export const guideSteps = (g: Guide, origin: string | null) => g.steps.flatMap((s) => !s.includes(ADDRESS) ? [s] : origin ? [s.replace(ADDRESS, origin)] : []);
/** Android when no phone app is built for this address (EST-1256): the web app from the home screen instead. */
export const phoneHint = (origin: string | null) => `Not built for this address yet: open ${origin ?? 'your Pulse address'} in Chrome → ⋮ → Add to Home screen`;
