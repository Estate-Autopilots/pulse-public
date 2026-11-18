// SETTINGS-APPLE: what both the Settings layout (the list) and its page (the section) read, once per request.
import { cache } from "react";
import { api } from "../lib/api";
import { canOpenSection } from "../lib/settings-access.mjs";
import type { CompanySetup } from "../companies/types";
import { TABS, type AccessData } from "./types";

export const getAccess = cache(() => api<AccessData>("admin/access"));
export const getHrSetup = cache(async () => (await api<CompanySetup>("company-setup")).data);
/** The sections this person may open, in TABS order (Roles & permissions is a part of Who can do what, not a row). */
export const settingsAvailable = (role: string, hrSetup: boolean) => TABS.filter((t) => t.key !== "roles" && canOpenSection(role, t.key, { hrSetup }));
