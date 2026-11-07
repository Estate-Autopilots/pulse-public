/**
 * Runs before first paint (Next's "preventing flash" guide): applies the saved
 * System / Light / Dark choice to <html data-theme>, so no page flashes the
 * wrong theme. The toggle (theme.tsx) writes the same key.
 */
export const THEME_KEY = "pulse:admin-theme";

const script = `(function(){try{var c=localStorage.getItem("${THEME_KEY}");var d=c==="dark"||((c===null||c==="system")&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.setAttribute("data-theme",d?"dark":"light");document.documentElement.setAttribute("data-theme-choice",c==="dark"||c==="light"?c:"system");}catch(e){}})();`;

export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
