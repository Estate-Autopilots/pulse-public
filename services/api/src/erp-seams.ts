// ERP-INVOICE seams for later: a mirror into another accounting system (Zoho Books while EA keeps it) and an e-sign
// provider. Neither sends anything today: the mirror is off unless configured and has no implementation yet; the only
// signing provider is Pulse's own acceptance link (a typed name, time, IP digest and browser, kept with the document).

/** What a mirror receives for an issued document. */
export type MirrorDocument = { id: string; docType: string; number: string; issueDate: string; buyer: Record<string, unknown>; total: number; lines: unknown[] };
export interface ErpMirror {
  readonly name: string;
  /** Creates or updates the document in the other system; returns its id there. */
  pushDocument(doc: MirrorDocument): Promise<{ externalId: string }>;
}
/** PULSE_ERP_MIRROR names the mirror (e.g. "zoho-books"). None is implemented yet, so this always reports why. */
export function mirrorStatus(env: NodeJS.ProcessEnv = process.env): { enabled: false; name: string | null; note: string } {
  const name = env.PULSE_ERP_MIRROR?.trim() || null;
  return { enabled: false, name, note: name
    ? `A ${name} mirror is configured but not built yet; use the Zoho Books CSV export meanwhile.`
    : "No mirror: export the Zoho Books CSV or Tally XML from ERP → Exports. A Zoho Books API mirror plugs in here later." };
}

export type SignRequest = { documentId: string; number: string; pdf: Uint8Array; signer: { name: string; email?: string | null }; days: number };
export interface ESignProvider {
  readonly key: string;
  readonly label: string;
  /** Starts a signing request; returns the URL the client opens. */
  request(r: SignRequest): Promise<{ url: string; reference: string }>;
}
/** The options for a proper e-sign provider, for the owner's choice (also in the ERP report). */
export const ESIGN_OPTIONS = [
  { key: "click", label: "Pulse acceptance link (built in)", kind: "Click-to-accept with typed name", note: "In use now: valid for quotations and commercial acceptance; not an Aadhaar or DSC signature." },
  { key: "leegality", label: "Leegality", kind: "Aadhaar eSign, DSC, virtual sign", note: "Indian, API and webhooks, stamp paper (e-stamping) in many states." },
  { key: "digio", label: "Digio", kind: "Aadhaar eSign, DSC, e-stamp, e-mandate", note: "Indian, API-first; also NACH mandates for instalments." },
  { key: "signdesk", label: "SignDesk", kind: "Aadhaar eSign, DSC, e-stamp", note: "Indian, API; document workflows and e-stamping." },
  { key: "emudhra", label: "eMudhra emSigner", kind: "Aadhaar eSign, DSC", note: "Licensed CA and ESP; enterprise." },
  { key: "zoho-sign", label: "Zoho Sign", kind: "Aadhaar eSign, e-signature", note: "Fits if EA stays on Zoho." },
  { key: "docusign", label: "DocuSign / Adobe Acrobat Sign", kind: "e-signature (Aadhaar via partners)", note: "Global; costlier per envelope." },
] as const;
