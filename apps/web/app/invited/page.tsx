import { InvitedView } from "./view";

// CONNECT: a client link (/invited#<token>) from an organisation that closed a deal with you. Signed out, it makes a Pulse
// account; either way it sets up your organisation from the details they filled in and connects the two. The token
// stays in the fragment: it never reaches a server log.
export const metadata = { title: "You are invited to Pulse" };
export default function Invited() { return <InvitedView />; }
