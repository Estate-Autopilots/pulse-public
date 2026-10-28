import { Message } from "../ui";
import { api } from "../lib/api";
import { TABS, type ListData, type MapData, type Tab } from "./model";
import { ProductMap } from "./workbench";

export const dynamic = "force-dynamic";

/** PRODUCT-MAP (owner, 25 Oct 2026): the Product map (?product= picks an app, ?tab= a view). */
export default async function ProductMapPage({ searchParams }: { searchParams: Promise<{ product?: string; tab?: string }> }) {
  const { product, tab } = await searchParams;
  const list = await api<ListData>("product-map");
  if (list.error || !list.data) return <Message text={list.error ?? "The Product map is unavailable."} />;
  const pid = product && list.data.products.some((p) => p.id === product) ? product : list.data.products[0]?.id ?? null;
  let data: MapData | null = null;
  if (pid) {
    const r = await api<MapData>(`product-map/products/${pid}`);
    if (r.error || !r.data) return <Message text={r.error ?? "This app’s map is unavailable."} />;
    data = r.data;
  }
  const t = (TABS.some((x) => x.key === tab) ? tab : "overview") as Tab;
  return <ProductMap key={pid ?? "none"} list={list.data} data={data} tab={t} />;
}
