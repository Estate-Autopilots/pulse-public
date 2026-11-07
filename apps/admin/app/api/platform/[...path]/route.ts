import { NextResponse, type NextRequest } from "next/server";

import { write } from "@/app/lib/api";
import { sameOrigin } from "@/app/lib/guard";

/**
 * The console's changes (PULSE-ADMIN): a page's form posts here and it goes on to Pulse's platform API as the
 * signed-in person. Only /api/v0/platform/* is reachable; Pulse checks the person and the change again.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Changes come from the admin site itself." }, { status: 403 });
  const { path } = await context.params;
  if (!path.length || path.some((part) => !/^[A-Za-z0-9_-]{1,64}$/.test(part))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = await request.json().catch(() => ({}));
  const r = await write<unknown>(`platform/${path.join("/")}`, body);
  return r.error ? NextResponse.json({ error: r.error }, { status: r.status }) : NextResponse.json(r.data);
}
