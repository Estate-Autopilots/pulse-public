import type { NextRequest } from "next/server";
import { discovery, oauthAddresses, preflight, protectedResource } from "../../lib/oauth-web.mjs";

// RFC 9728, served at /.well-known/oauth-protected-resource(/mcp) (next.config.ts): it describes /mcp.
// VITALS-HOSTS: on a platform family the resource is its MCP address and the authorization server its one issuer.
export const GET = (request: NextRequest) => { const at = oauthAddresses(request.headers); return discovery(protectedResource(at.mcp, at.issuer, at.docs)); };
export const OPTIONS = preflight;
