// BUG-REPORT (owner, 27 Oct 2026; from Sales X-Ray's reporter): what a bug report may carry from this device. The
// device scrubs before it sends and the API scrubs again (services/api/src/bug-report-model.ts): no secrets, sign-in
// codes, contact details or message text. Free text is cut short; anything shaped like a token, key, e-mail address
// or phone number becomes a marker. Plain functions (node --test in bug-report.test.mjs).

const REDACTIONS = [
  [/\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{6,}/g, "[token]"],
  [/\bbearer\s+[\w.~+/=-]{8,}/gi, "Bearer [token]"],
  [/\b(?:sk|pk|rk|whsec|AIza|ghp|gho|xox[abp])[\w-]{10,}/g, "[key]"],
  [/\b(?:password|passwd|secret|token|otp|cookie|session|api[_-]?key)\s*[:=]\s*\S+/gi, "[secret]"],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]"],
  [/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, "[long]"],
  [/(?<![\w-])\+?\d(?:[\s().-]?\d){8,}(?![\w-])/g, "[phone]"],
];
// Secrets only, for the screen's picture: tokens, keys and long opaque strings; what a person reads stays as it is.
const SECRETS = REDACTIONS.filter(([, marker]) => !["[email]", "[phone]"].includes(marker));

/** Text with tokens, keys and long opaque strings masked (for the screen's picture). */
export function maskSecrets(text) {
  let out = String(text ?? "");
  for (const [pattern, marker] of SECRETS) out = out.replace(pattern, marker);
  return out;
}

/** One line of plain text, redacted and cut to `limit` characters. */
export function scrubText(value, limit) {
  if (typeof value !== "string") return "";
  let text = value.replace(/\s+/g, " ").trim();
  for (const [pattern, marker] of REDACTIONS) text = text.replace(pattern, marker);
  return text.slice(0, limit);
}

/** A typed value in the screen's picture: dots of about the same length (a password always six). */
export function hiddenValue(value, password = false) {
  const n = String(value ?? "").length;
  return password ? (n ? "••••••" : "") : "•".repeat(Math.min(n, 24));
}

// ------------------------------------------------------------------------------------------------ the shortcut
/** What a key press means for the reporter: "open" for Ctrl+B (⌘B on a Mac) outside a text editor, and for
 *  Ctrl+Shift+B (⌘⇧B) anywhere, editors included; null otherwise. In a rich-text editor (contenteditable, a textbox)
 *  Ctrl+B stays bold, so the Shift combination is the way in there. */
export function shortcutAction(event, inEditor) {
  if (!event || !(event.ctrlKey || event.metaKey) || event.altKey) return null;
  if (String(event.key ?? "").toLowerCase() !== "b" && event.code !== "KeyB") return null;
  if (event.shiftKey) return "open";
  return inEditor ? null : "open";
}

/** The shortcut as this computer writes it, for menus and the reporter's own hint. */
export function shortcutLabel(mac) {
  return mac ? { open: "⌘B", editor: "⌘⇧B" } : { open: "Ctrl+B", editor: "Ctrl+Shift+B" };
}

// ------------------------------------------------------------------------------------------------ shake
// From Sales X-Ray (26 Oct 2026): a deliberate shake is three swings within 1.2 seconds, each the other way from the
// one before; picking the phone up, walking, typing or a bump in the pocket does not count. Never twice in 5 seconds.
const THRESHOLD = 13; // m/s² of motion, gravity taken out
const PEAKS = 3;
const WINDOW_MS = 1200;
const SWING_MS = 80;
const COOLDOWN_MS = 5000;
const GRAVITY_FOLLOW = 0.9;

/** A function of one accelerometer reading (x, y, z with gravity) that answers true when it completes a shake. */
export function shakeDetector(now = Date.now) {
  let gravity = null, swings = [], opened = -Infinity;
  return (x, y, z) => {
    const at = now(), reading = [x, y, z];
    const base = gravity ?? reading;
    const motion = reading.map((value, i) => value - base[i]);
    gravity = base.map((g, i) => GRAVITY_FOLLOW * g + (1 - GRAVITY_FOLLOW) * reading[i]);
    if (swings.length && at - swings[0].at > WINDOW_MS) swings = [];
    const force = Math.hypot(motion[0], motion[1], motion[2]);
    if (force < THRESHOLD || at - opened < COOLDOWN_MS) return false;
    const axis = motion.reduce((best, value, i) => (Math.abs(value) > Math.abs(motion[best]) ? i : best), 0);
    const sign = Math.sign(motion[axis]);
    const previous = swings.at(-1);
    if (previous && ((previous.axis === axis && previous.sign === sign) || at - previous.at < SWING_MS)) return false;
    swings.push({ at, axis, sign });
    if (swings.length < PEAKS) return false;
    swings = [];
    opened = at;
    return true;
  };
}

// ------------------------------------------------------------------------------------------------ status words
/** How a report's status reads to the person who sent it, and on the triage page. */
export const STATUS_WORDS = { new: "Received", triaged: "Seen by the team", fixing: "Being fixed", fixed: "Fixed", wontfix: "Won't fix" };
export const TRIAGE_WORDS = { new: "New", triaged: "Triaged", fixing: "Fixing", fixed: "Fixed", wontfix: "Won't fix" };
