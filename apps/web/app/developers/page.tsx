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
      <Panel title="2. CLI" sub="Planned"><p>Once the CLI download ships here, install it with Node 20 or later. This install does not publish a CLI download yet.</p><pre>{'curl -fS https://pulse.example.com/developers/pulse.mjs -o pulse.mjs\nexport PULSE_URL=https://pulse.example.com\nnode pulse.mjs auth login\nnode pulse.mjs ops\nnode pulse.mjs <operationId> --param limit=10'}</pre><p>Choose an operation id from <code>ops</code>. Login uses a hidden prompt; <code>auth status</code> shows key metadata. Writes accept <code>--idempotency-key</code>; list commands accept <code>--all</code> with a page cap.</p></Panel>
      <Panel title="3. MCP" sub="Planned"><p>When MCP is released, use Streamable HTTP at your install’s <code>/api/v1/mcp</code>. Only tools permitted by your key will be listed. OAuth sign-in is a later release.</p><pre>{'{\n  "url": "https://pulse.example.com/api/v1/mcp",\n  "headers": { "Authorization": "Bearer ${PULSE_API_KEY}" }\n}'}</pre><p>Adapt this connection fragment to your client’s config. Environment substitution must be supported by that client; otherwise use its private token-file or secret-store setting. Never save a real key in shared configuration.</p></Panel>
    </section>
    <footer>API v1.0 only. Connect and webhook-signing guides arrive with their release. No account or company records are loaded to read this reference.</footer>
  </main>;
}
