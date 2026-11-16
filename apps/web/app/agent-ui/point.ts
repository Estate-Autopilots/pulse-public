// AGENT-UI-CONTROL: point.at — the first button, link, tab or heading on screen whose words match, scrolled into view and
// glowing violet for a few seconds (from script: no global CSS), so a person sees where to click.
const norm = (s: string) => s.toLowerCase().replace(/[\s ]+/g, " ").replace(/[“”"'’]/g, "").trim();
const SELECTOR = "main button, main a[href], main [role=tab], main [role=button], main [role=menuitem], main h1, main h2, main h3, main label, main summary, [data-shell-topbar] button, [data-shell-topbar] a, nav a, aside button, aside a";

export function pointAt(text: string): { found: boolean; label?: string } {
  const want = norm(text);
  if (!want) return { found: false };
  const nameOf = (el: HTMLElement) => norm(el.getAttribute("aria-label") || el.textContent || el.getAttribute("title") || "");
  const seen = Array.from(document.querySelectorAll<HTMLElement>(SELECTOR)).filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden" && !el.closest("[data-agent-ui]"));
  const el = seen.find((e) => nameOf(e) === want) ?? seen.find((e) => nameOf(e).startsWith(want)) ?? seen.find((e) => nameOf(e).includes(want));
  if (!el) return { found: false };
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ block: "center", inline: "nearest", behavior: still ? "auto" : "smooth" });
  const before = { outline: el.style.outline, offset: el.style.outlineOffset, radius: el.style.borderRadius };
  el.style.outline = "2px solid var(--theme-action)"; el.style.outlineOffset = "3px";
  if (!getComputedStyle(el).borderRadius || getComputedStyle(el).borderRadius === "0px") el.style.borderRadius = "6px";
  const glow = still ? null : el.animate([{ boxShadow: "0 0 0 0 rgb(91 69 214 / 0)" }, { boxShadow: "0 0 0 9px rgb(91 69 214 / 0.24)" }, { boxShadow: "0 0 0 0 rgb(91 69 214 / 0)" }], { duration: 1200, iterations: 3, easing: "ease-in-out" });
  window.setTimeout(() => { el.style.outline = before.outline; el.style.outlineOffset = before.offset; el.style.borderRadius = before.radius; glow?.cancel(); }, 4200);
  return { found: true, label: nameOf(el).slice(0, 80) };
}
