// DE-EA: the modules an industry pack brings (flow/packs.ts `modules`), kept apart from packs.ts so modules.ts reads them
// without loading the pack templates. A company on a pack has these unless it switches one off or its plan does not allow it.
export const PACK_MODULES: Record<string, readonly string[]> = {
  real_estate_marketing: ["creative", "sales_xray"],
  marketing_agency: ["creative"],
  real_estate_developer: ["sales_xray"],
};
export const packModulesOf = (pack: unknown): readonly string[] => (typeof pack === "string" && PACK_MODULES[pack]) || [];
