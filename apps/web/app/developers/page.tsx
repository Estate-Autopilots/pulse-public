import { Panel } from '../ui';
import Reference from './reference';
import css from './developers.module.css';

export const metadata = { title: 'Pulse Developers · API v1', robots: { index: false, follow: false } };
export default function Developers() {
  // The root layout renders /developers bare, outside PulseShell (EST-1618), so this page gives itself the one <main>.
  return <main id="main-content" className={css.page}>
    <header><a href="/login">Pulse</a><p>DEVELOPERS / API v1.0</p><h1>Build with Pulse.</h1><p>Discover this install’s API. Try an operation with your own scoped key.</p>
      <nav aria-label="Developer sections"><a href="#reference">Reference & try-it</a><a href="#quickstarts">Quickstarts</a><a href="/api/v1/openapi.json">OpenAPI 3.1 JSON</a></nav></header>
    <Reference />
    <section id="quickstarts" className={css.guides} aria-label="Quickstarts">
      <Panel title="1. Create an API key"><p>In <a href="/settings?tab=integrations">Settings → Integrations</a>, a company admin creates a connected-app key with an expiry and only the scopes the app needs. Copy the secret once; revoke it there when finished.</p><pre>{'curl https://pulse.example.com/api/v1/catalog/items \\\n  -H "Authorization: Bearer $PULSE_API_KEY"'}</pre><p>Use your company’s Pulse address. Set the key privately in your local environment; examples use placeholders. Key management requires its own sign-in and is separate from this page.</p></Panel>
      <Panel title="2. CLI" sub="Node 20 or later"><p>The <code>pulse</code> command signs in as you with “Sign in with Pulse” (your roles; Pulse checks every call) and runs every API v1 operation. Tables by default, <code>--json</code> for scripts, <code>--help</code> on every command.</p><pre>{'npm install -g https://pulse.example.com/downloads/pulse-cli.tgz\npulse login --host https://pulse.example.com\npulse whoami\npulse people search asha\npulse hr onboarding --stuck true\npulse changes list --json'}</pre><p>Without installing: <code>npx -y https://pulse.example.com/downloads/pulse-cli.tgz whoami</code>. Use your company’s Pulse address. On a server, <code>pulse login --no-browser</code>; in CI, set <code>PULSE_TOKEN</code>. <code>pulse ops</code> lists every operation and its command; <code>pulse api GET /api/v1/…</code> calls any path. <a href="/downloads/pulse-cli.tgz">Download pulse-cli.tgz</a></p></Panel>
      <Panel title="3. MCP and AI apps" sub="Claude, ChatGPT"><p>Pulse is a remote MCP server at your install’s <code>/mcp</code> with “Sign in with Pulse” (OAuth 2.1). In Claude: Settings → Connectors → Add custom connector; in ChatGPT: Settings → Apps &amp; Connectors (developer mode). The app acts as you: everyone gets whoami, search and fetch; HR and admins also get people, onboarding, password and group tools. Changes show the app’s name and most can be undone for 7 days. <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></p><pre>{'claude mcp add --transport http pulse https://pulse.example.com/mcp'}</pre></Panel>
    </section>
    <footer>API v1.0 only. Connect and webhook-signing guides arrive with their release. No account or company records are loaded to read this reference.</footer>
  </main>;
}
