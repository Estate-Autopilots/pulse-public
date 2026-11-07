// EST-1363: the apps a company can add to Pulse, kept as repo data (company-neutral). Each names what it reads in plain
// words and the module that switches it on (services/api/src/modules.ts). Sales X-Ray is the first; each person then
// connects their own account, so nothing here is a company-wide credential.
export type PulseApp = {
  id: "sales-xray";
  name: string;
  maker: string;
  purpose: string;
  reads: readonly string[];
  promises: readonly string[];
  href: string;
  module: "sales_xray";
};

export const APPS: readonly PulseApp[] = [
  {
    id: "sales-xray",
    name: "Sales X-Ray",
    maker: "Atlas Crest",
    purpose: "Your sales calls with their reports, and your leads, from your own Sales X-Ray account. Ask Pulse about them.",
    reads: ["Your calls and whether their report is ready", "The facts Sales X-Ray found in your calls", "Your leads and their stage",
      "For leadership and admins: your workflow step names go to Sales X-Ray as lead-stage suggestions"],
    promises: ["Pulse changes Sales X-Ray only as you: a client you send, its company or city you edit, a recording you send (it waits for you to add it)", "Nothing is copied into Pulse: each list is read when you open it", "Disconnect any time; Sales X-Ray forgets Pulse at once"],
    href: "/apps/sales-xray",
    module: "sales_xray",
  },
];
