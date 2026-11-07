export type DesignDeliveryType = "single_image_ad" | "carousel" | "brochure" | "logo" | "pitch_deck" | "other";
export type DesignTypeCounts = Record<DesignDeliveryType, number>;

export type DesignerSummary = {
  personId: string | null;
  name: string;
  sharedLogin: boolean;
  types: DesignTypeCounts;
  claimed?: DesignTypeCounts;
};

export type DesignerDay = { day: string; types: DesignTypeCounts };
export type DesignersData = { week: string; designers: DesignerSummary[] };
export type DesignerProfileData = { week: string; days: DesignerDay[] };
