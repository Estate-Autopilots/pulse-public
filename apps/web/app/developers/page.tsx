import { Panel } from '../ui';
import Reference from './reference';
import css from './developers.module.css';

export const metadata = { title: 'Pulse Developers · API v1', robots: { index: false, follow: false } };
export default function Developers() {
  // The root layout renders /developers bare, outside PulseShell (EST-1618), so this page gives itself the one <main>.
  return <main id="main-content" className={css.page}>
    <header><a href="/login">Pulse</a><p>DEVELOPERS / API v1.0</p><h1>Build with Pulse.</h1><p>Discover this install’s API. Try an operation with your own scoped key.</p>
      <nav aria-label="Developer sections"><a href="#reference">Reference & try-it</a><a href="#quickstarts">Claude, ChatGPT, Codex, CLI</a><a href="/api/v1/openapi.json">OpenAPI 3.1 JSON</a></nav></header>
    <Reference />
    {/* AGENT-API (owner, 4 Nov 2026: "the strongest possible API, MCP and CLI"): one obvious start for each way in. */}
    <section id="quickstarts" className={css.guides} aria-label="Quickstarts">
      <Panel title="1. Connect Claude, ChatGPT or Codex" sub="Remote MCP · Sign in with Pulse">
        <p>Pulse is a remote MCP server at <code>{'https://<your Pulse address>/mcp'}</code>. Each person signs in with their own Pulse account (OAuth 2.1, dynamic registration, PKCE) and the AI sees only what they see. Tools follow their roles: tasks and projects for everyone, clients, quotations, invoices and stock for leadership and Finance.</p>
        <pre>{'Claude:      Settings → Connectors → Add custom connector → URL https://pulse.example.com/mcp → Connect\nChatGPT:     Settings → Apps & Connectors → Advanced → Developer mode → Create → URL …/mcp, OAuth\nClaude Code: claude mcp add --transport http pulse https://pulse.example.com/mcp\nCodex:       codex mcp add pulse --url https://pulse.example.com/mcp   (or ~/.codex/config.toml)'}</pre>
        <p>Each organisation is its own connection: someone in two (Willow Lane and I-Solar) connects each one while signed in to it. <code>list_my_organisations</code> says which one a connection acts in.</p></Panel>
      <Panel title="2. Get a key for a script or a bot" sub="Settings → API keys">
        <p>In <a href="/settings?tab=api-keys">Settings → API keys</a>, make a <b>personal token</b> (it acts as you) or, as an admin, a <b>bot key</b> for an AI member such as Bhrata (it acts as that member, never as a person). Tick only the areas it needs; it is shown once; rotate or revoke it there.</p>
        <pre>{'curl https://pulse.example.com/api/v1/tasks -H "Authorization: Bearer $PULSE_TOKEN"\n\ncurl -X POST https://pulse.example.com/api/v1/companies/clients/find-or-create \\\n  -H "Authorization: Bearer $PULSE_TOKEN" -H "Idempotency-Key: $(uuidgen)" \\\n  -H "content-type: application/json" -d \'{"name":"Majestic Infra","phone":"+91 90000 00112"}\''}</pre></Panel>
      <Panel title="3. The money path, step by step" sub="What Bhrata does">
        <p>Find or add the client (<code>find_or_create_client</code>), pick the item (<code>search_catalogue</code>: case and spaces ignored), draft (<code>create_quotation</code>), ask for approval (<code>submit_quotation</code>: a task for the owner), and once a person has approved it, <code>send_quotation</code> returns the client&apos;s link to view and accept. Revise after negotiation with <code>revise_quotation</code>: the number stays, the approved copy is kept.</p>
        <p>Money is in paise (₹1 = 100). Approving and issuing are a person&apos;s click: AI members and bot keys draft, submit and send an approved quotation, and never record payments or stock, revise, cancel or change prices. Money and destructive calls need <code>confirm: true</code>; without it Pulse says what would happen, so you can ask first.</p></Panel>
      <Panel title="4. CLI" sub="Node 20 or later">
        <p>The <code>pulse</code> command acts as you and runs every operation. Tables by default, <code>--json</code> for scripts, <code>--help</code> on every command.</p>
        <pre>{'npm install -g https://pulse.example.com/downloads/pulse-cli.tgz\npulse login --host https://pulse.example.com      # browser\npulse login --device                              # a server or SSH: approve a code at /oauth/device\npulse tasks list\npulse tasks create "Call the dealer back" --due-on 2026-11-20\npulse clients find-or-create "Majestic Infra" --phone "+91 90000 00112"\npulse quotes create --data @quote.json --json\npulse stock in <itemId> 5\npulse auth status · pulse orgs use https://isolar.example.com'}</pre>
        <p>In CI, set <code>PULSE_TOKEN</code>. <code>pulse ops</code> lists every operation; <code>pulse api GET /api/v1/…</code> calls any path. <a href="/downloads/pulse-cli.tgz">Download pulse-cli.tgz</a></p></Panel>
      <Panel title="5. Rules every call follows">
        <p>One bearer key per call, nothing beside it. Every write takes an <code>Idempotency-Key</code> (MCP: <code>requestId</code>): the same key replays the first answer for 24 hours, a changed input is a 409. Refusals are <code>application/problem+json</code> with a request id. Every call is audited as its own token; every write names the app that sent it and most can be undone for 7 days (<code>list_my_changes</code>, <code>undo_change</code>). A token of one organisation never reads or writes another&apos;s.</p></Panel>
    </section>
    <footer>API v1.0. Webhook-signing guides arrive with their release. No account or company records are loaded to read this reference.</footer>
  </main>;
}
