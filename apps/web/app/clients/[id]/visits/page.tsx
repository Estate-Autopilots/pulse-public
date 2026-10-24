import { SiteVisits } from "../../visits";
export default async function Visits({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SiteVisits key={id} customerId={id} />;
}
