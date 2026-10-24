import type { Change, Delivery, Stage } from "../lib/api";

/** A key of one of the organisation's client types (Settings → Organisation; PEOPLE-CONTACTS 0213). */
export type ClientType = string;
/** A key of one of the organisation's contact types. */
export type ContactType = string;
export type ClientBase = { id: string; name: string; companyName: string | null; clientType: ClientType; typeBasis: string | null; status: string | null; city: string | null; source: string | null; contactId: string | null; contactName: string | null };
export type ClientRow = ClientBase & { engagements: number; projects: number; firstMonth: string | null; lastMonth: string | null; deliveries: number; lastDeliveredAt: string | null; locations: string[] | null };
export type ClientList = { clients: ClientRow[]; unassigned: number; types?: import("../record-types").RecordType[]; canEdit: boolean };
/** One engagement: a project folder. Engagements that share a `projectKey` are the same development, shot again. */
export type RecordProject = { projectId: string; title: string; folderName: string; status: string; kind: string; location: string | null; segment: string | null; startMonth: string | null; projectKey: string | null; registryNo: number | null; pod: string | null; clientId: string | null; clientName: string | null; total: number; lastDeliveredAt: string | null; stage: Stage; contactRole?: string | null };
export type ClientContact = { id: string; name: string; contactType: ContactType | null; designation: string | null; email: string | null; phone: string | null; primary: boolean };
export type Campaign = { id: string; name: string; platform: string | null; objective?: string | null; projectName: string };
export type ClientDetail = ClientBase & {editedBy?:string|null; website: string | null; email: string | null; phone: string | null; notes: string | null; locked: string[]; createdAt: string;
  contacts: ClientContact[]; projects: RecordProject[]; latest: Delivery[]; campaigns: Campaign[]; aliases: { raw: string; method: string; confidence: number }[];
  byYear: { year: number; engagements: number; deliveries: number }[]; history: Change[]; canEdit: boolean; custom?: Record<string, unknown>; types?: import("../record-types").RecordType[] };
export type ContactRow = { id: string; name: string; contactType: ContactType | null; designation: string | null; city: string | null; source: string | null; clientId: string | null; clientName: string | null; companyName: string | null; projects: number; lastMonth: string | null; photoAt?: string | null };
export type ContactList = { contacts: ContactRow[]; types: import("../record-types").RecordType[]; canEdit: boolean };
export type ContactDetail = {editedBy?:string|null; confidence?:number|null;typeStatus?:string|null; photoAt?: string | null; canPhoto?: boolean; id: string; name: string; createdAt: string; contactType: ContactType | null; designation: string | null; email: string | null; phone: string | null; city: string | null; notes: string | null; source: string | null; locked: string[];
  clients: { id: string; name: string; companyName: string | null; clientType: ClientType; primary: boolean }[]; projects: RecordProject[]; campaigns: Campaign[]; history: Change[]; canEdit: boolean;
  custom?: Record<string, unknown>; types?: import("../record-types").RecordType[] };
