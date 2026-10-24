import { JoinView } from "./view";

// ORG: an invitation link (/join#<token>) into an organisation on this Pulse. Signed out, it makes a Pulse account; signed
// in, it adds the organisation to the account. The token stays in the fragment: it never reaches a server log.
export const metadata = { title: "Join on Pulse" };
export default function Join() { return <JoinView />; }
