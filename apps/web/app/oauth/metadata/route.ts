import type { NextRequest } from "next/server";
import { authorizationServer, discovery, oauthAddresses, preflight } from "../../lib/oauth-web.mjs";

// RFC 8414, served at /.well-known/oauth-authorization-server and /.well-known/openid-configuration (next.config.ts).
// VITALS-HOSTS: the issuer is the family's (id.vitalsos.ai when configured), whichever of its hosts is asked.
export const GET = (request: NextRequest) => { const at = oauthAddresses(request.headers); return discovery(authorizationServer(at.issuer, at.docs)); };
export const OPTIONS = preflight;
