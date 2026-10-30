import type { NextRequest } from "next/server";
import { discovery, preflight, protectedResource, publicOrigin } from "../../lib/oauth-web.mjs";

// RFC 9728, served at /.well-known/oauth-protected-resource(/mcp) (next.config.ts): it describes /mcp.
export const GET = (request: NextRequest) => discovery(protectedResource(publicOrigin(request.headers)));
export const OPTIONS = preflight;
