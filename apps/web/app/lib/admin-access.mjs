const organisationAdminEmails = ["admin@estateautopilots.com", "user-668d21b6@estateautopilots.com"];

export function isPulseAdminEmail(emailHeader, allowedEmails = organisationAdminEmails) {
  const email = emailHeader?.trim().toLowerCase();
  return Boolean(email && allowedEmails.some((allowed) => email === allowed.toLowerCase()));
}
