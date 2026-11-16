export type PulseIdentity = Readonly<{
  displayName: string;
  email: string;
  roleLabel: string;
  isFixture?: boolean;
  /** The signed-in person's own profile page and photo, when Pulse has a record for them. */
  profileHref?: string;
  /** The person's own record in this company (/people/<id>). ACCOUNT-META made profileHref the account's /profile, so
   *  the shell keeps this one apart: a hidden Team screen still leaves the person's own record in Recents. */
  recordHref?: string;
  photoUrl?: string;
  /** Signed in with a Pulse session (password sign-in or Google), which the account menu can end on this device. */
  signOut?: boolean;
}>;

export type PulseWorkspace = Readonly<{
  tenant_id: string;
  name: string;
  kind: "personal" | "organisation";
}>;

/** ORG: the organisations of the signed-in Pulse account, for the switcher (the app performs the switch: the shell
 *  sends `pulse:org-switch` with the organisation's id, and `pulse:orgs-open` to open the app's switcher). */
export type PulseOrgChoice = Readonly<{ id: string; name: string; handle?: string | null; role: string; current: boolean;
  /** ORG-SWITCHER-UX: this organisation's own square logo (an address the signed-in account may load), when it has one. */
  mark?: string | null;
  /** Its brand colour (#rrggbb), for its initials tile when it has no logo. */
  color?: string | null;
  /** CA-ACCESS: what waits there for this person, in a few words ("12 to verify"). */
  note?: string | null;
  /** FIX-SHELL (1947): the organisation-only modules switched on there (Focus and Funding link to it from other companies). */
  orgOnly?: readonly string[] }>;
export type PulseOrgs = Readonly<{ handle: string | null; list: readonly PulseOrgChoice[]; invites: number }>;

/** The organisation's own logo (LAYOUT-SWEEP, Settings → Organisation): the square mark heads the rail, the lock-up
 *  (light and dark) titles the phone's page list. Addresses carry the logo's version, so a change shows at once. */
/** LOGIN-VITALS: the product an address wears: "Vitals OS" and its icon on the platform's own addresses. */
export type PulseProduct = Readonly<{ name: string; icon?: string | null }>;

export type PulseOrg = Readonly<{
  name: string;
  mark?: string | null;
  logo?: string | null;
  logoDark?: string | null;
}>;
