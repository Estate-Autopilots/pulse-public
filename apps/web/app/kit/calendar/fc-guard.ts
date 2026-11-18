// FIX-PR-CALENDAR: imported before FullCalendar (kit/calendar/index.tsx). The app's Content-Security-Policy takes fonts
// from Pulse only (font-src 'self'). FullCalendar 6 adds an icon font as a data: URI, which the browser refuses and
// reports as an error on every page that loads the calendar. We never use its icons (our own toolbar, lucide icons), so
// that one rule is left out; the policy stays as it is. FullCalendar adds its rules one by one with insertRule into a
// <style data-fullcalendar> it reuses when one exists (core/internal-common.js registerStylesRoot / appendStylesTo).
if (typeof document !== "undefined" && !document.querySelector("style[data-fullcalendar]")) {
  const el = document.createElement("style");
  el.setAttribute("data-fullcalendar", "");
  const nonce = document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce;
  if (nonce) el.nonce = nonce;
  document.head.prepend(el);
  const sheet = el.sheet;
  if (sheet) {
    const insert = sheet.insertRule.bind(sheet);
    // A skipped rule shifts FullCalendar's own indexes by one, so every index is kept within the sheet (order holds:
    // it always inserts at the end).
    sheet.insertRule = (rule: string, index?: number) => {
      const at = Math.min(index ?? 0, sheet.cssRules.length);
      return /^\s*@font-face/i.test(rule) ? at : insert(rule, at);
    };
  }
}
export {};
