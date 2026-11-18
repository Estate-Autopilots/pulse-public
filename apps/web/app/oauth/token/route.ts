import { forward } from "../forward";

// PULSE-ID: the token endpoint (an app's server, with its client secret).
export const POST = (request: Request) => forward(request, "/oauth/token", { maxBody: 16384 });
