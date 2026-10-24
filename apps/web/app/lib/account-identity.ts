import type { PulseIdentity } from "@pulse/ui-shell";
import { isPulseAdminEmail } from "./admin-access.mjs";
export { isPulseAdminEmail } from "./admin-access.mjs";

export const CF_ACCESS_EMAIL_HEADER = "Cf-Access-Authenticated-User-Email";

const localDevelopmentIdentity: PulseIdentity = {
  displayName: "Alex Morgan",
  email: "alex.morgan@pulse.local",
  roleLabel: "Local account",
  isFixture: true,
};


function displayNameFromEmail(email: string) {
  const local = email.slice(0, email.indexOf("@"));
  const words = local.replace(/[._+-]+/g, " ").trim().split(/\s+/).filter(Boolean);
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ") || "Your account";
}

export function resolveAccountIdentity(emailHeader: string | null, nodeEnv: string): PulseIdentity | null {
  const email = emailHeader?.trim();
  if (!email) return nodeEnv === "development" ? localDevelopmentIdentity : null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  const isOrganisationOwner = isPulseAdminEmail(email);
  return {
    displayName: displayNameFromEmail(email),
    email,
    roleLabel: isOrganisationOwner ? "Organisation owner/admin" : email.toLowerCase() === "hr@estateautopilots.com" ? "HR" : "Member",
  };
}
