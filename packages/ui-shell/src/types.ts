export type PulseIdentity = Readonly<{
  displayName: string;
  email: string;
  roleLabel: string;
  isFixture?: boolean;
  /** The signed-in person's own profile page and photo, when Pulse has a record for them. */
  profileHref?: string;
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
export type PulseOrgChoice = Readonly<{ id: string; name: string; handle?: string | null; role: string; current: boolean }>;
export type PulseOrgs = Readonly<{ handle: string | null; list: readonly PulseOrgChoice[]; invites: number }>;

/** The organisation's own logo (LAYOUT-SWEEP, Settings → Organisation): the square mark heads the rail, the lock-up
 *  (light and dark) titles the phone's page list. Addresses carry the logo's version, so a change shows at once. */
export type PulseOrg = Readonly<{
  name: string;
  mark?: string | null;
  logo?: string | null;
  logoDark?: string | null;
}>;
