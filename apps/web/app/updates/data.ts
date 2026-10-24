import { cache } from "react";
import { apiV1 } from "../lib/api";
import type { UpdateList } from "./types";

// Shared by the navigation and Home; request-local only, never shared between viewers.
export const newestUpdate = cache(async () => (await apiV1<UpdateList>("/api/v1/updates?limit=1")).data?.items[0] ?? null);
