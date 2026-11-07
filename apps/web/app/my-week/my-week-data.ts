import { apiV1, type ApiResult, type ClaimableDeliveriesResponse, type ClaimableDesignsResponse } from "../lib/api";
import { currentIsoWeek, normalizePersonalWeek, type EditorWeekResponse, type PersonalWeek } from "./normalize-personal-week.mjs";

export type { PersonalWeek, TypeProgress, OpenTask } from "./normalize-personal-week.mjs";

export type PersonalWeekResult = { data: PersonalWeek; error?: never } | { error: string; data?: never };

export async function getPersonalWeek(personId: string, week?: string): Promise<PersonalWeekResult> {
  const requestedWeek = week || currentIsoWeek();
  const query = new URLSearchParams({ week: requestedWeek });
  const result = await apiV1<EditorWeekResponse>(
    `/v1/editors/${encodeURIComponent(personId)}/week?${query}`,
  );
  if (result.data === undefined) return { error: result.error ?? "Your personal week is unavailable." };
  return { data: normalizePersonalWeek(result.data) };
}

export async function getClaimableDeliveries(week: string): Promise<ApiResult<ClaimableDeliveriesResponse>> {
  const query = new URLSearchParams({ week });
  return apiV1<ClaimableDeliveriesResponse>(`/v1/deliveries/claimable?${query}`);
}

export async function getClaimableDesigns(week: string): Promise<ApiResult<ClaimableDesignsResponse>> {
  const query = new URLSearchParams({ week });
  return apiV1<ClaimableDesignsResponse>(`/v1/designs/claimable?${query}`);
}
