import type { NextRequest } from "next/server";
import { runnerProxy, type ApiProxyContext } from "../../../api/proxy.mjs";

// SERVERS-AI: Pulse Runner's API (docs/runner/PROTOCOL.md): a paired server's calls go to the API as they are.
// The runner itself installs from its npm package (`sudo npx --yes @vitalsos/pulse-runner connect --code …`, the
// command Settings → Servers & AI shows); Pulse serves no installer.
const proxy = (request: NextRequest, context: ApiProxyContext) => runnerProxy(request, context);
export const POST = proxy;
export const PUT = proxy;
export const dynamic = "force-dynamic";
