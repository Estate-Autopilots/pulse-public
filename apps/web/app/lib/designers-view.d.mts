import type { DesignerDay, DesignerSummary, DesignTypeCounts } from "../designers/types";
export const DESIGNER_DETAIL_ROLES: ReadonlySet<string>;
export function normalizeDesignerRows(rows: DesignerSummary[]): DesignerSummary[];
export function designerRowsForViewer(rows: DesignerSummary[], viewerPersonId: string | null | undefined, role: string): DesignerSummary[];
export function canOpenDesignerDetails(viewerPersonId: string | null | undefined, designer: DesignerSummary, role: string): boolean;
export function designerWeeklyTotals(days: DesignerDay[]): DesignTypeCounts;
export function hasDesignCounts(types: Record<string, number> | null | undefined): boolean;
