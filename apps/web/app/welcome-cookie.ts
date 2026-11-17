// UX-5A: the getting-started list's state (hidden, steps seen) is kept in a cookie as well as in localStorage, so the
// dashboard's server render draws what the browser will show and nothing pops in after loading (layout shift).
export const WELCOME_COOKIE = "pulse_welcome";
