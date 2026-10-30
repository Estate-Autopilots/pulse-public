// CHAT-V6: a long conversation for the long-chat checks (drawing only what is near the screen, find and jump far
// back), as synthetic people only. Seeds once: "Long history (test)" with Kedab and Asha, 1,500 messages (short and
// long, some on several lines), muted for Kedab so nothing rings. Message 40 carries a word found nowhere else
// ("zebracrossing"), far beyond 600 messages back.
//   node tests/e2e/chat-v6-seed.mjs [api base]   → prints {"channel": id, "far": message id}
// Spread over days: afterwards run the SQL it prints (as the dev DB owner) so the day chips change along the way.
const [apiBase = "http://127.0.0.1:3203"] = process.argv.slice(2);
const P = { kedab: "kedab.mifos@synthetic.invalid", asha: "asha.kireteso@synthetic.invalid" };
const NAME = "Long history (test)", N = 1500;
async function api(as, path, body) {
  const r = await fetch(`${apiBase}/api/v0/${path}`, { method: body ? "POST" : "GET", headers: { "cf-access-authenticated-user-email": P[as], ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${as} ${path}: ${d.error ?? r.status}`); return d;
}
const WORDS = ["site visit", "floor plan", "brochure proof", "client call", "drone shoot", "print run", "carpet area", "possession date", "site photos", "booking form"];
const text = (i) => {
  const w = WORDS[i % WORDS.length];
  if (i === 40) return "Note for later: the zebracrossing outside the site gate needs repainting before the shoot (test)";
  if (i % 17 === 0) return `Update ${i} on the ${w} (test):\n- first, the ${w} is confirmed\n- second, the team meets at 10\n- third, photos by evening\nThanks all.`;
  if (i % 5 === 0) return `Message ${i}: a longer note about the ${w}, so this bubble wraps over two or three lines on a phone and shows how the list keeps its place while it is drawn (test).`;
  return `Message ${i}: ${w} (test)`;
};
const ids = {}; for (const k of Object.keys(P)) ids[k] = (await api(k, "me")).person;
let list = await api("kedab", "chats"), ch = list.channels.find((c) => c.name === NAME);
if (!ch) {
  const { id } = await api("kedab", "chats/groups", { name: NAME, memberIds: [ids.asha] });
  await api("kedab", `chats/${id}/mute`, { until: "always" });
  await api("asha", `chats/${id}/mute`, { until: "always" });
  for (let i = 1; i <= N; i++) await api(i % 3 ? "kedab" : "asha", `chats/${id}/messages`, { body: text(i), attachments: [], clientId: crypto.randomUUID() });
  list = await api("kedab", "chats"); ch = list.channels.find((c) => c.id === id);
}
const far = (await api("kedab", `chats/search?q=zebracrossing&channel=${ch.id}`)).messages[0];
console.log(JSON.stringify({ channel: ch.id, far: far?.id ?? null }));
console.error(`-- spread over days (dev DB owner): update pulse.chat_message m set created_at = now() - ((select count(*) from pulse.chat_message x where x.channel_id = m.channel_id and x.created_at > m.created_at) * interval '37 minutes') where m.channel_id = '${ch.id}';`);
