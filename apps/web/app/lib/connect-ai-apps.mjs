// AI-CONNECT (owner, 8 Nov 2026): Settings → Connect your AI. Each AI app is one card: ONE thing to copy and three short
// steps. Apps that sign in (Claude, ChatGPT, Gemini CLI, Cursor, VS Code, most MCP apps) get the address only: the person
// presses Connect, signs in and presses Allow (OAuth 2.1 with dynamic registration, services/api/src/oauth.ts). The API
// key card is for scripts and apps that cannot sign in. Pure, so the words are tested (connect-ai-apps.test.mjs).

/** A step's small picture: a menu path with the button to press, fields to fill, a terminal line, or the Allow screen. */
const menu = (path, button) => ({ kind: "menu", path, button });
const fields = (rows) => ({ kind: "fields", rows });
const term = (line) => ({ kind: "terminal", line });
const ALLOW = Object.freeze({ kind: "allow" });
const b64 = (s) => (typeof btoa === "function" ? btoa(s) : Buffer.from(s, "utf8").toString("base64"));

/** One-click installs that Cursor and VS Code handle themselves (no key: they sign in on first use). */
export function installLinks(url, slug) {
  return {
    cursor: `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(slug)}&config=${encodeURIComponent(b64(JSON.stringify({ url })))}`,
    vscode: `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: slug, type: "http", url }))}`,
  };
}

/**
 * @param {{ url: string, brand: string, key?: string | null }} o  url: the MCP address; brand: Vitals or Pulse; key: a key just made.
 * @returns {{ key: string, name: string, sub: string, signIn: boolean, ways: { key: string, label: string, copy: { label: string, text: string }, steps: string[], note?: string, link?: { href: string, label: string } }[] }[]}
 */
export function aiApps({ url, brand, key = null }) {
  const slug = brand.toLowerCase(), links = installLinks(url, slug);
  const allow = `Sign in to ${brand} when it asks, and press Allow.`;
  const address = { label: "Copy address", text: url };
  return [
    { key: "claude", name: "Claude", sub: "Website, app and Claude Code", signIn: true, ways: [
      { key: "web", label: "Website and app", copy: address, steps: [
        "In Claude, open Settings → Connectors and press Add custom connector.",
        `Name it ${brand}, paste the address and press Add.`,
        `Press Connect. ${allow}`],
        shots: [menu(["Settings", "Connectors"], "Add custom connector"), fields([["Name", brand], ["URL", url]]), ALLOW],
        note: "On a Team or Enterprise plan, an owner adds it first in Organization settings → Connectors. Then turn it on in a chat from the tools menu." },
      { key: "code", label: "Claude Code", copy: { label: "Copy command", text: `claude mcp add --transport http ${slug} ${url}` }, steps: [
        "Copy this command and run it in your terminal.",
        `Start claude, type /mcp, pick ${slug} and press Authenticate.`,
        allow], shots: [term(`claude mcp add --transport http ${slug} …`), term(`/mcp  →  ${slug}  →  Authenticate`), ALLOW] },
    ] },
    { key: "chatgpt", name: "ChatGPT", sub: "Plus, Pro, Business or Enterprise", signIn: true, ways: [
      { key: "web", label: "ChatGPT", copy: address, steps: [
        "In ChatGPT, open Settings → Apps & Connectors → Advanced and turn on Developer mode.",
        `Press Create, name it ${brand}, paste the address and pick OAuth.`,
        `Press Connect. ${allow}`],
        shots: [menu(["Advanced"], "Developer mode: on"), fields([["Name", brand], ["MCP server URL", url], ["Authentication", "OAuth"]]), ALLOW],
        note: `To use it: in a new chat press +, then Developer mode, then ${brand}. On Business or Enterprise, an admin may need to allow it first.` },
    ] },
    { key: "gemini", name: "Gemini CLI", sub: "Google Gemini, in a terminal window", signIn: true, ways: [
      { key: "cli", label: "Gemini CLI", copy: { label: "Copy command", text: `gemini mcp add --transport http ${slug} ${url}` }, steps: [
        "Copy this command and run it in your terminal.",
        `Start gemini and type /mcp auth ${slug}.`,
        allow], shots: [term(`gemini mcp add --transport http ${slug} …`), term(`/mcp auth ${slug}`), ALLOW] },
    ] },
    { key: "editor", name: "Cursor or VS Code", sub: "AI in your code editor", signIn: true, ways: [
      { key: "cursor", label: "Cursor", copy: { label: "Copy settings", text: JSON.stringify({ mcpServers: { [slug]: { url } } }, null, 2) }, link: { href: links.cursor, label: "Add to Cursor" }, steps: [
        "Press Add to Cursor. Or open Cursor Settings → MCP, add a new server and paste these settings.",
        `${brand} shows in the list with a Connect (or Needs login) button. Press it.`,
        allow], shots: [menu(["Cursor Settings", "MCP"], "Add new MCP server"), menu([slug], "Connect"), ALLOW] },
      { key: "vscode", label: "VS Code", copy: address, link: { href: links.vscode, label: "Add to VS Code" }, steps: [
        "Press Add to VS Code. Or run MCP: Add Server from the Command Palette, pick HTTP and paste the address.",
        `Name it ${slug} and keep it for your user.`,
        `When VS Code asks to sign in, say yes. ${allow}`], shots: [menu(["Command Palette"], "MCP: Add Server"), fields([["Type", "HTTP"], ["Name", slug]]), ALLOW] },
    ] },
    { key: "any", name: "Any MCP app", sub: "Any other AI app that takes an MCP server", signIn: true, ways: [
      { key: "any", label: "Any app", copy: address, steps: [
        "Add a new MCP server. Pick the type HTTP (it may say Streamable HTTP).",
        `Paste the address and name it ${brand}.`,
        `${allow} If the app cannot sign in, make an API key below instead.`], shots: [fields([["Type", "HTTP"]]), fields([["Name", brand], ["URL", url]]), ALLOW] },
    ] },
    { key: "key", name: "API key", sub: "For scripts, servers and apps that cannot sign in", signIn: false, ways: [
      { key: "key", label: "API key", copy: { label: key ? "Copy key" : "Make a key first", text: key ?? "" }, steps: [
        "Choose what the key may do and press Make a key.",
        `Copy the key now. ${brand} shows it only once. Keep it secret, like a password.`,
        `Send it as the header “Authorization: Bearer <key>” to the address, or to ${url.replace(/\/mcp$/, "")}/api/v1.`],
        shots: [menu(["What it may do"], "Make a key"), menu(["Shown once"], "Copy key"), term("Authorization: Bearer …")],
        note: key ? `Claude Code with this key: claude mcp add --transport http ${slug} ${url} --header "Authorization: Bearer ${key}"` : undefined },
    ] },
  ];
}
