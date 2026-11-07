// R44: Google's Drive push notification for a channel, signed out. It only wakes the changes poller; the body is always
// empty. This route passes on just the channel id, token and resource state (no cookie, session, Access identity or
// body), and the API answers 404 unless the feed is on and the pair is a live channel of this organisation.
const api = () => process.env.PULSE_API_URL ?? "http://127.0.0.1:8081";
const HEADERS = ["x-goog-channel-id", "x-goog-channel-token", "x-goog-resource-state"];

export async function POST(request: Request) {
  const headers: Record<string, string> = {};
  for (const name of HEADERS) {
    const value = request.headers.get(name);
    if (value && value.length <= 256) headers[name] = value;
  }
  try {
    const r = await fetch(`${api()}/api/v0/drive-changes/hook`, { method: "POST", cache: "no-store", signal: AbortSignal.timeout(10000), headers });
    return new Response(null, { status: r.status === 204 ? 204 : 404, headers: { "cache-control": "no-store" } });
  } catch { return new Response(null, { status: 503, headers: { "cache-control": "no-store" } }); }
}
