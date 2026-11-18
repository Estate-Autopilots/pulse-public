// DE-EA: no address is an admin by its spelling. Callers pass the list they trust (the database's admins); the
// default is PULSE_OWNER_EMAILS (comma-separated, for the signed-out identity line only), empty when unset.
const organisationAdminEmails = (process.env.PULSE_OWNER_EMAILS ?? "").split(",").map((x) => x.trim()).filter(Boolean);

export function isPulseAdminEmail(emailHeader, allowedEmails = organisationAdminEmails) {
  const email = emailHeader?.trim().toLowerCase();
  return Boolean(email && allowedEmails.some((allowed) => email === allowed.toLowerCase()));
}
