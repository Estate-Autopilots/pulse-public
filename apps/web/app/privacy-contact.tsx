"use client";
// NO-DATA-LOSS-5 (owner, 20 Nov 2026, 18:15 UTC): the approved notices say "ask your company's privacy contact"; this
// names them, without changing the approved words: the e-mail an admin set in Settings → Privacy, else the company
// owner's or an admin's e-mail (migration 2497 seeds the platform's own company). Read from GET /api/v0/telemetry/settings.
import { useEffect, useState } from "react";

/** The company's privacy contact, or null until it is known (or when the company has none). */
export function usePrivacyContact(): string | null {
  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    fetch("/api/v0/telemetry/settings", { cache: "no-store", signal: ctl.signal }).then((r) => (r.ok ? r.json() : null))
      .then((s: { privacyContact?: unknown } | null) => setEmail(typeof s?.privacyContact === "string" ? s.privacyContact : null)).catch(() => {});
    return () => ctl.abort();
  }, []);
  return email;
}

/** An approved text with the contact's e-mail after its "privacy contact" (the words stay as approved). */
export function withPrivacyContact(text: string, email: string | null): string {
  return email ? text.replace(/privacy contact(?=[.,;)]|$)/, `privacy contact (${email})`) : text;
}

/** Inline after "ask your company's privacy contact" in a note: " (name@company.com)" once known. */
export function PrivacyContactEmail() {
  const email = usePrivacyContact();
  return email ? <> (<a href={`mailto:${email}`} data-testid="privacy-contact-email">{email}</a>)</> : null;
}
