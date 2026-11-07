import { Quote } from "./quote";

export default async function QuotationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Quote key={id} id={id} />;
}
