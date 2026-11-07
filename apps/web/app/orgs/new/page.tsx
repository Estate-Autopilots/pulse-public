import { redirect } from "next/navigation";

// ONBOARD-SELF: "Start your own Pulse" is now the guided "Start your company on Pulse" (/start): what you do, modules,
// working days, starter projects, then inviting your team. (SELF-SERVE's quicker Start another space is /start/space,
// offered from /start; review, 5 Nov 2026: existing staff keep the full set-up here.)
export default function NewOrganisation() { redirect("/start"); }
