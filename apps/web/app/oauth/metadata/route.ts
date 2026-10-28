import type { NextRequest } from "next/server";
import { authorizationServer, discovery, preflight, publicOrigin } from "../../lib/oauth-web.mjs";

// RFC 8414, served at /.well-known/oauth-authorization-server and /.well-known/openid-configuration (next.config.ts).
export const GET = (request: NextRequest) => discovery(authorizationServer(publicOrigin(request.headers)));
export const OPTIONS = preflight;
