import type { DesignDeliveryType } from "./types";

export const DESIGN_TYPE_ORDER: readonly DesignDeliveryType[] = [
  "single_image_ad", "carousel", "brochure", "logo", "pitch_deck", "other",
];

const labels: Record<DesignDeliveryType, string> = {
  single_image_ad: "Single image ad",
  carousel: "Carousel",
  brochure: "Brochure",
  logo: "Logo",
  pitch_deck: "Pitch deck",
  other: "Other",
};

export function designTypeLabel(type: DesignDeliveryType): string {
  return labels[type];
}

export function orderedDesignTypes(keys: Iterable<string>): DesignDeliveryType[] {
  const present = new Set(keys);
  return DESIGN_TYPE_ORDER.filter((type) => present.has(type));
}
