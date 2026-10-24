// MODULES-1024: the server renders dates and times in Pulse's home zone, as people's phones and laptops show them.
// Without a zone the server (UTC in containers) wrote "5:30 am" where the browser wrote "11:00 am" for the same
// interview, React refused the page ("Hydration failed") and the person saw "Something glitched" (Hiring, the AI
// employee tab, any screen that prints a time without naming a zone). lib/format.ts already formats in this zone.
export function register() {
  if (!process.env.TZ) process.env.TZ = "Asia/Kolkata";
}
