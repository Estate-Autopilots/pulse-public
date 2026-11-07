import { SiteVisits } from "../../../visits";
export default async function Visit({ params }: { params: Promise<{ id: string; visitId: string }> }) {
  const { id, visitId } = await params;
  return <SiteVisits key={`${id}:${visitId}`} customerId={id} visitId={visitId} />;
}
