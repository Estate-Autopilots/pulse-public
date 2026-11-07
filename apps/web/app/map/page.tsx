import { api, getMe } from "../lib/api";
import MapWorkspace from "./workspace";
import type { MapData } from "./geo";

export default async function MapPage() {
  const [result, me] = await Promise.all([api<MapData>("map"), getMe()]);
  if (!result.data) return <div style={{ padding: 24 }}><h1>Pulse Map</h1><p role="alert">{result.error}</p></div>;
  return <MapWorkspace initial={result.data} orgName={me.data?.orgName ?? "Pulse"} />;
}
