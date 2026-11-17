import { html } from "../lib/oauth-web.mjs";

// EST-2811: the public terms that app directories link for the Pulse connector.
export const dynamic = "force-static";
export const GET = () => html("Pulse terms of use", `<h1>Pulse terms of use</h1>
<p>Updated 28 October 2026. Pulse is provided by Estate Autopilots to the companies that use it and their people.</p>
<p>Use Pulse, its API, CLI and connected apps (Claude, ChatGPT and others) only for your company's work and only as your company allows. You are responsible for what an app does with your sign-in; connect only apps you trust, and disconnect them when you no longer need them.</p>
<p>Do not try to reach another company's data, share your sign-in or tokens, or use Pulse to send unlawful or harmful content. We may suspend a connection or an account that does.</p>
<p>Pulse is provided as is. Estate Autopilots works to keep it available and correct but cannot guarantee uninterrupted service; your company's agreement with Estate Autopilots takes precedence over these terms.</p>
<p>Questions: <a href="mailto:admin@estateautopilots.com">admin@estateautopilots.com</a>. <a href="/privacy">Privacy policy</a> · <a href="/developers">Developers</a></p>`); // tenant-neutral:allow: the provider's legal contact address that app directories require
