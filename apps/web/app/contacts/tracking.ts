// AC-CONTACTS (owner, 18 Nov 2026; migration 2397): "Testers are potential clients; track who is testing." Where a
// contact is with you, the phone they test on, and the two tags every team starts with. Plain data, so the Add contact
// drawer (a client component) and the server pages read the same words.
export const CONTACT_STATUS: Record<string, { label: string; tone: "accent" | "success" | "warning" | "neutral" }> = {
  new: { label: "New", tone: "neutral" }, talking: { label: "In talks", tone: "accent" }, invited: { label: "Invited to test", tone: "accent" }, installed: { label: "Installed", tone: "accent" },
  active: { label: "Using it", tone: "success" }, stopped: { label: "Stopped", tone: "warning" }, client: { label: "Client now", tone: "success" }, not_now: { label: "Not now", tone: "neutral" },
};
export const DEVICES: Record<string, string> = { android: "Android", iphone: "iPhone", both: "Android and iPhone", other: "Other" };
export const STARTER_TAGS = ["tester", "prospect"] as const;
export const tagLabel = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
