import { hostHeader } from "../../../../../lib/host-mode.mjs";
// CONTRACTS-2: the agreement as a PDF through the signing link (signed out): the words, the signatures and the audit page.
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return new Response("This link is not valid", { status: 404 });
  try {
    // CONTRACTS-PRO: ?inline=1 opens the printed document in the browser ("Read it as the printed document").
    const inline = new URL(request.url).searchParams.get("inline") === "1" ? "?inline=1" : "";
    const r = await fetch(`${process.env.PULSE_API_URL ?? "http://127.0.0.1:8081"}/api/v0/accept/sign/${token}/pdf${inline}`, { cache: "no-store", signal: AbortSignal.timeout(20000), headers: { ...hostHeader(request.headers) } });
    if (!r.ok) return new Response("This link is not valid or has expired", { status: r.status === 404 ? 404 : 502 });
    return new Response(await r.arrayBuffer(), { status: 200, headers: { "content-type": "application/pdf", "cache-control": "private, no-store",
      "content-disposition": r.headers.get("content-disposition") ?? 'attachment; filename="agreement.pdf"' } });
  } catch { return new Response("The service is busy. Try again in a moment", { status: 503 }); }
}
