import type { Destination } from "../destinations/registry.mjs";

type Page = { label: string; href: string };
export type PaletteGoItem<P extends Page> = {
  key: string; group: "go"; kind: string; label: string; href: string;
  path?: readonly string[]; synonyms?: readonly string[]; sub?: string; coach?: string;
  page?: P; destination?: Destination;
};
export declare function paletteGoItems<P extends Page>(options: {
  pages: readonly P[]; places?: readonly P[]; financeOnly?: boolean; role?: string | null;
  modulesOff?: readonly string[]; hidden?: readonly string[]; isSwitchedOff?: (href: string) => boolean;
}): PaletteGoItem<P>[];
