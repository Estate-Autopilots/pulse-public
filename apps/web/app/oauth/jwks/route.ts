import { forward } from "../forward";

// PULSE-ID: the public keys that sign Pulse's ID tokens.
export const GET = (request: Request) => forward(request, "/oauth/jwks", { credential: false });
