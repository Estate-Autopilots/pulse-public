"use client";
// CONTRACTS-3: a GET from the browser with the API's own plain sentence on a refusal (orgs/client.ts has the POST).
export async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`/api/v0/${path}`, { cache: "no-store" });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof data?.error === "string" ? data.error : "Could not load this. Try again.");
  return data as T;
}
