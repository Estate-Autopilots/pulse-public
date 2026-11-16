"use client";
// UX-TENANT: the company's code (ACR, …) that starts every employee ID. The root layout provides it per request,
// so a server render never borrows another company's code. R51: the company's time zone rides along (useOrgZone).
import { createContext, useContext, type ReactNode } from "react";
import { userId } from "./lib/format";
import { FALLBACK_ZONE } from "./lib/zone.mjs";
import { NEUTRAL_VOCABULARY } from "./lib/words.mjs";
type Vocabulary = typeof NEUTRAL_VOCABULARY;

const OrgCode = createContext(""); // DE-EA: no fallback company code
const OrgZone = createContext(FALLBACK_ZONE);
const OrgWords = createContext<Vocabulary>(NEUTRAL_VOCABULARY);
export function OrgCodeProvider({ code, zone, words, children }: { code: string; zone: string; words?: Partial<Vocabulary> | null; children: ReactNode }) {
  return <OrgCode.Provider value={code}><OrgZone.Provider value={zone}><OrgWords.Provider value={{ ...NEUTRAL_VOCABULARY, ...(words ?? {}) }}>{children}</OrgWords.Provider></OrgZone.Provider></OrgCode.Provider>;
}
/** DE-EA: the company's one vocabulary (team, client, project …) for a client component. */
export const useWords = () => useContext(OrgWords);
export const useOrgCode = () => useContext(OrgCode);
/** The company's IANA time zone: days, "today" and due times on the web count in it (lib/zone.mjs). */
export const useOrgZone = () => useContext(OrgZone);
/** An employee ID in the company's own code, for server components too. */
export function StaffId({ no }: { no: number | null }) { return <>{userId(no, useOrgCode())}</>; }
