import { TeamSetup } from "./view";

// ONBOARD (owner, 26 Oct 2026): the public, self-serve team setup page. No sign-in (layout.tsx lists it with the sign-in
// pages); the team code the admin shares in the team's WhatsApp group keeps strangers out, and no names are ever listed.
export const metadata = { title: "Set up your Pulse login" };
export default function Page() { return <TeamSetup />; }
