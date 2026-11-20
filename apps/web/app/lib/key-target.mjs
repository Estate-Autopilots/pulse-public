// FIX-LIVE (19 Nov 2026, BUG-CENSUS BC-249): "a?.closest is not a function" on /dashboard in the Android app. A page's
// key shortcuts read the key's target as an element, but a key can come from the document itself (nothing focused;
// Android WebView's keys), and the document has no closest(). Pure; unit-tested beside it.

/** The element a key or pointer event came from, or null when it came from the document, the window or a text node. */
export function eventElement(target) {
  return target && typeof target.closest === "function" ? target : null;
}
