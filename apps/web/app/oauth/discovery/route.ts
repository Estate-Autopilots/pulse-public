import { forward } from "../forward";

// PULSE-ID: OpenID Connect discovery for "Sign in with Pulse" (public), served at /.well-known/openid-configuration
// through next.config.ts's rewrite (like assetlinks.json).
export const GET = (request: Request) => forward(request, "/.well-known/openid-configuration", { credential: false });
