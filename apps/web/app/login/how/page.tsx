import { HowYouGetIn } from "./view";

// ONBOARD (owner, 26 Oct 2026): one page, open without signing in (it lives under /login), that says the one way into
// Pulse: the company Google account is the Pulse login. Linked from Sign in, the invitation page and the invitation e-mail.
export const metadata = { title: "How you get into Pulse" };
export default function Page() { return <HowYouGetIn />; }
