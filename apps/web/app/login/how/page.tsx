import { HowYouGetIn } from "./view";

// ONBOARD (owner, 26 Oct 2026): one page, open without signing in (it lives under /login), that says the one way into
// Pulse. Linked from Sign in, the invitation page and the invitation e-mail. SIGNED-OUT-SHELL: the ways this install really
// has (e-mail code, username or @handle and password; Google only where it is switched on).
export const metadata = { title: "How you get into Pulse" };
export default function Page() { return <HowYouGetIn />; }
