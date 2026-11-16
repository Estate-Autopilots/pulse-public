import { forward } from "../../forward";

// PULSE-ID: a registered app's logo for the consent screen (public).
export async function GET(request: Request, { params }: { params: Promise<{ client: string }> }) {
  const { client } = await params;
  if (!/^papp_[a-z0-9]{20}$/.test(client)) return new Response(null, { status: 404 });
  return forward(request, `/oauth/app-logo/${client}`, { credential: false });
}
