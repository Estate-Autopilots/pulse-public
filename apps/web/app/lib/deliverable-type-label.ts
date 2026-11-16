import { designTypeLabel, DESIGN_TYPE_ORDER } from "../designers/type-labels";
import { creativeTypeLabels } from "../my-week/normalize-personal-week.mjs";

export function deliverableTypeLabel(value: string | null | undefined): string | null {
  const type = value?.trim();
  if (!type) return null;

  if (type in creativeTypeLabels) {
    return creativeTypeLabels[type as keyof typeof creativeTypeLabels];
  }

  const designType = DESIGN_TYPE_ORDER.find((candidate) => candidate === type);
  return designType ? designTypeLabel(designType) : type.replaceAll("_", " ");
}
