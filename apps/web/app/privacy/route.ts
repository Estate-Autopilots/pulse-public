import { html } from "../lib/oauth-web.mjs";

// EST-2811: the public privacy policy that app directories (Claude, ChatGPT) link for the Pulse connector.
export const dynamic = "force-static";
export const GET = () => html("Pulse privacy policy", `<h1>Pulse privacy policy</h1>
<p>Updated 28 October 2026. Pulse is the work and people app run by Estate Autopilots for its own team and the companies it serves.</p>
<h2 style="font-size:16px">What Pulse holds</h2><p>Work records (tasks, projects, deliveries, chats, attendance and leave) and staff records (name, role, team, joining date, work contact details) that a company keeps in its own Pulse. Each company sees only its own data.</p>
<h2 style="font-size:16px">Connected apps (Claude, ChatGPT, the Pulse CLI)</h2><p>When you connect an app you sign in with your own Pulse account and choose to allow it. The app then acts as you: it sees only what you can see in Pulse, and HR or admin tools appear only for people with those roles. Pulse stores the app's name and return address, and only a one-way fingerprint (SHA-256) of its tokens; access tokens last one hour. Every change an app makes records your name and the app's name, and most can be undone for 7 days.</p>
<p>What you ask the app, and what it shows you, is handled by that app's provider under its own privacy policy. Pulse does not sell data, does not use it to train AI models, and sends an app nothing beyond the answers to the calls it makes as you.</p>
<h2 style="font-size:16px">Your choices</h2><p>Disconnect an app from the app itself or ask your Pulse admin to end its connection; its tokens stop working at once. Ask your company's HR to see or correct your staff record.</p>
<h2 style="font-size:16px">Contact</h2><p>Estate Autopilots, Pulse: <a href="mailto:admin@estateautopilots.com">admin@estateautopilots.com</a>. <a href="/terms">Terms</a> · <a href="/developers">Developers</a></p>`); // tenant-neutral:allow: the provider's legal contact address that app directories require
