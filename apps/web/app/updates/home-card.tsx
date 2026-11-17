import { orgZone } from "../lib/brand-server";
import { newestUpdate } from "./data";
import { HomeUpdate } from "./views";

export async function UpdatesHomeCard() {
  const update = await newestUpdate();
  return update ? <HomeUpdate update={update} zone={await orgZone()} /> : null;
}
