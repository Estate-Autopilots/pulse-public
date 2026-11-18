// The refusals that name their own fix, and the one button that opens it (ui.tsx Message). NO-DEAD-ENDS (owner, 30 Oct
// 2026: "if this screen arrives no one knows what to do; what needs doing must already be prompted"). Each key is one of
// Pulse's own sentences (notices.mjs); next-step.test.mjs checks them.
export const NEXT_STEP = {
  "This account is not active in this company's Pulse": { title: "You're not set up in this Pulse yet", text: "Ask the person who runs Pulse for your team to add you, or sign in with the account they invited.", action: { href: "/login", label: "Use another account" } },
  "Sign in to Pulse to see your workspace.": { title: "Sign in to continue", text: "Sign in to Pulse to see your workspace.", action: { href: "/login", label: "Sign in" } },
  "Change your issued password before opening your workspace": { title: "Set your own password first", text: "Your account still has the password you were given. Choose your own, then Pulse opens.", action: { href: "/login?change=1", label: "Set your password" } },
  "Change your issued password before opening client work": { title: "Set your own password first", text: "Your account still has the password you were given. Choose your own, then Pulse opens.", action: { href: "/login?change=1", label: "Set your password" } },
  // CA-ACCESS: the CA check page shows its own "One more step" card for this, so the old page sentence is gone; the API's
  // refusal (0137 finance_desk: a CA without a live two-step session) is what ERP, quotes and pay totals show a CA instead.
  "Accountant access requires unexpired membership and a two-step session": { title: "Turn on two-step to open Finance", text: "Finance needs two-step verification. It takes about 2 minutes: a code from your phone as well as your password. Then sign out and sign in again.", action: { href: "/account?tab=two-step", label: "Set up two-step" } },
};
