import type { NextRequest } from "next/server";
import { forwardOAuth } from "../../../lib/oauth-web.mjs";

// EST-2811: dynamic client registration, token and revocation endpoints (rules live in services/api/src/oauth.ts).
const handle = async (request: NextRequest, context: { params: Promise<{ action: string }> }) => {
  const { action } = await context.params;
  if (!["register", "token", "revoke"].includes(action)) return new Response(null, { status: 404 });
  return forwardOAuth(request, action);
};
export const POST = handle;
export const OPTIONS = handle;
export const GET = handle;
