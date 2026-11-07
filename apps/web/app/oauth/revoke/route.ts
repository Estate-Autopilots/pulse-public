import { forward } from "../forward";

// PULSE-ID: RFC 7009 revocation (an app's server, with its client secret).
export const POST = (request: Request) => forward(request, "/oauth/revoke", { maxBody: 16384 });
