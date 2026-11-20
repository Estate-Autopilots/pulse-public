// AC-CONTACTS (owner, 18 Nov 2026; 2397): the values a contact's status and device take (pulse.contact_profile checks).
// A leaf module with no imports: v1-money.ts reads them while it loads, inside the routes import cycle.
export const CONTACT_STATUS = ["new", "talking", "invited", "installed", "active", "stopped", "client", "not_now"] as const;
export const CONTACT_DEVICES = ["android", "iphone", "both", "other"] as const;
