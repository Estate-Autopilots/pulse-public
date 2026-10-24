// CHAT-V4: a small, lifelike group for screenshots and checks, as synthetic people only (nobody real is messaged).
//   node tests/e2e/chat-v4-seed.mjs [api base]   → prints {"channel": id}
// Seeds once: "Brochure launch (test)" with Kedab, Asha, Neha and Meera: talk with replies, reactions, a link, mentions
// and a thread, so bubbles, grouping and the side columns can be looked at.
const [apiBase = "http://127.0.0.1:3203"] = process.argv.slice(2);
const P = { kedab: "kedab.mifos@synthetic.invalid", asha: "asha.kireteso@synthetic.invalid", neha: "neha.soniba@synthetic.invalid", meera: "meera.jivop@synthetic.invalid" };
const NAME = "Brochure launch (test)";
async function api(as, path, body) {
  const r = await fetch(`${apiBase}/api/v0/${path}`, { method: body ? "POST" : "GET", headers: { "cf-access-authenticated-user-email": P[as], ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${as} ${path}: ${d.error ?? r.status}`); return d;
}
const ids = {}; for (const k of Object.keys(P)) ids[k] = (await api(k, "me")).person;
let list = await api("kedab", "chats"), ch = list.channels.find((c) => c.name === NAME);
if (!ch) {
  const { id } = await api("kedab", "chats/groups", { name: NAME, memberIds: [ids.asha, ids.neha, ids.meera] });
  const say = async (who, body, extra = {}) => (await api(who, `chats/${id}/messages`, { body, attachments: [], clientId: crypto.randomUUID(), ...extra })).message;
  const a = await say("kedab", "Morning all. The Skyline brochure goes to the client on Friday, so let's lock the cover today.");
  await say("kedab", "Draft 3 is in the shared folder.");
  const b = await say("asha", "Looked at draft 3. The cover photo is lovely but the logo is too small on the phone view.", { quoteId: a.id });
  await api("kedab", `chats/messages/${b.id}/react`, { emoji: "👍" });
  await api("neha", `chats/messages/${b.id}/react`, { emoji: "👍" });
  await say("neha", "Agreed. I can make it 20% bigger and move the tagline under it.");
  const c = await say("meera", "Budget check: the print run is 500 copies at ₹38 each, inside what Skyline approved.");
  await api("asha", `chats/messages/${c.id}/react`, { emoji: "🙏" });
  await say("kedab", "@Neha please send v4 by 3 pm, then @Asha reviews before it goes out.");
  const d = await say("neha", "On it. Reference for the layout: https://www.behance.net/search/projects?search=real%20estate%20brochure");
  await say("asha", "Thanks! One more thing: the floor plan page needs the carpet area in sq ft, not sq m.", { parentId: d.id });
  await say("neha", "Noted, fixing both.", { parentId: d.id });
  await say("neha", "v4 is up. Logo bigger, tagline under it, floor plan in sq ft.");
  await say("asha", "Looks great 🎉 Approving from my side.");
  await say("meera", "Same here. Kedab, all yours.");
  list = await api("kedab", "chats"); ch = list.channels.find((c) => c.id === id);
}
// A link whose page has a title, for the preview card (added once, also to a group seeded before it).
const recent = (await api("kedab", `chats/${ch.id}/messages`)).messages;
if (!recent.some((m) => m.body.includes("wikipedia.org"))) await api("meera", `chats/${ch.id}/messages`, { body: "For the copy, this is a good primer on brochure layouts: https://en.wikipedia.org/wiki/Brochure", attachments: [], clientId: crypto.randomUUID() });
console.log(JSON.stringify({ channel: ch.id }));
