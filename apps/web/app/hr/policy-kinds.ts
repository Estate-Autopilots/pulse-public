/** The six company policies; each has its own versions and acknowledgements (migration 0029). */
/** HR-PEOPLE (migration 2041): "pay" is written from People & pay → Pay policy's five answers (people/pay/policy-doc.mjs). */
export const KINDS = [["pay", "Pay"], ["leave", "Leave"], ["wfh", "Work from home"], ["attendance", "Attendance"], ["expenses", "Expenses"], ["travel", "Travel"], ["conduct", "Code of conduct"]] as const;
/** Where a kind's words come from when it is not typed here (the pay policy is written from its answers). */
export const WRITTEN_FROM: Partial<Record<string, { href: string; label: string }>> = { pay: { href: "/people/pay/settings", label: "Change the answers in Pay policy" } };
