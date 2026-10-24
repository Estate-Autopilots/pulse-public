"use client";
// UX-TENANT: the company's code (EA, ACR, …) that starts every employee ID. The root layout provides it per request,
// so a server render never borrows another company's code. R51: the company's time zone rides along (useOrgZone).
import { createContext, useContext, type ReactNode } from "react";
import { userId } from "./lib/format";
import { FALLBACK_ZONE } from "./lib/zone.mjs";

const OrgCode = createContext("EA");
const OrgZone = createContext(FALLBACK_ZONE);
export function OrgCodeProvider({ code, zone, children }: { code: string; zone: string; children: ReactNode }) {
  return <OrgCode.Provider value={code}><OrgZone.Provider value={zone}>{children}</OrgZone.Provider></OrgCode.Provider>;
}
export const useOrgCode = () => useContext(OrgCode);
/** The company's IANA time zone: days, "today" and due times on the web count in it (lib/zone.mjs). */
export const useOrgZone = () => useContext(OrgZone);
/** An employee ID in the company's own code, for server components too. */
export function StaffId({ no }: { no: number | null }) { return <>{userId(no, useOrgCode())}</>; }
