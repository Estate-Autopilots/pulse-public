// Preferences shared by the quick panel and the Settings window (same local origin, same storage). A change in one
// window is announced to the others through the "pulse:prefs" app event.
export const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(`pulse.${key}`) ?? 'null') ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(`pulse.${key}`, JSON.stringify(value)); } catch { /* the choice lasts this session */ } },
};

/** Appearance: follow the system (default), or always light / always dark. */
export function applyTheme(doc = document) {
  const theme = store.get('theme', 'system');
  if (theme === 'light' || theme === 'dark') doc.documentElement.dataset.theme = theme;
  else delete doc.documentElement.dataset.theme;
}
