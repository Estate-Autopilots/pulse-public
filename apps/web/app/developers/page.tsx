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
      <Panel title="2. CLI" sub="Node 20+"><p><a href="/developers/pulse.mjs" download>Download the Pulse CLI</a>, or install the single file from your company’s address:</p><pre>{'curl -fS https://pulse.example.com/developers/pulse.mjs -o pulse.mjs\nexport PULSE_URL=https://pulse.example.com\nnode pulse.mjs auth login\nnode pulse.mjs auth status\nnode pulse.mjs ops\nnode pulse.mjs <operationId> --param limit=10'}</pre><p>Choose an operation id from <code>ops</code>. Login uses a hidden prompt and saves the key privately for this company address. <code>auth status</code> reports the local key id without checking scopes or expiry; manage the key in Settings → Integrations. Legacy person-token operations read <code>PULSE_PERSON_TOKEN</code>. Writes accept <code>--data @file.json</code> and <code>--idempotency-key</code>; cursor lists accept <code>--all</code> up to 100 pages, with no partial output at the cap.</p></Panel>
      <Panel title="3. MCP and AI apps" sub="Claude, ChatGPT"><p>Pulse is a remote MCP server at your install’s <code>/mcp</code> with “Sign in with Pulse” (OAuth 2.1). In Claude: Settings → Connectors → Add custom connector; in ChatGPT: Settings → Apps &amp; Connectors (developer mode). The app acts as you: everyone gets whoami, search and fetch; HR and admins also get people, onboarding, password and group tools. Changes show the app’s name and most can be undone for 7 days. <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></p><pre>{'claude mcp add --transport http pulse https://pulse.example.com/mcp\nnode pulse.mjs auth connect   # the CLI, signed in as you'}</pre></Panel>
    </section>
    <footer>API v1.0 only. Connect and webhook-signing guides arrive with their release. No account or company records are loaded to read this reference.</footer>
  </main>;
}
