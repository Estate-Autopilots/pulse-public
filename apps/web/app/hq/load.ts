import { api } from "../lib/api";
import type { Hq } from "./model";

/** PULSE-HQ: everything Pulse HQ shows, in one read (the catalogue, ideas, offers and brand are small). */
export async function loadHq() {
  return api<Hq>("hq");
}
