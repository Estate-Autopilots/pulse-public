import { forward } from "../forward";

// PULSE-ID: who a bearer access token speaks for.
export const GET = (request: Request) => forward(request, "/oauth/userinfo");
export const POST = (request: Request) => forward(request, "/oauth/userinfo", { maxBody: 16384 });
