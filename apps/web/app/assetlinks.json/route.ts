// Android App Links: links to this Pulse host open in the Pulse phone app (package and signing certificate of
// the durable Pulse key). Served at /.well-known/assetlinks.json through a rewrite (next.config.ts): Next does not
// serve dot-folders from public/.
import links from "../lib/assetlinks.json";

export const dynamic = "force-static";
export function GET() {
  return Response.json(links, { headers: { "cache-control": "public, max-age=3600" } });
}
