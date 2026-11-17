export type Branding = { name: string };

const fallback: Branding = { name: "Pulse" };

/** Public install branding; an uninitialised or unavailable install uses the neutral Pulse name. */
export async function getBranding(): Promise<Branding> {
  try {
    const response = await fetch(`${process.env.PULSE_API_URL ?? "http://127.0.0.1:8081"}/api/v0/auth/branding`, {
      cache: "no-store",
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return fallback;
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("name" in body) || typeof body.name !== "string") return fallback;
    return { name: body.name.trim() || fallback.name };
  } catch {
    return fallback;
  }
}
