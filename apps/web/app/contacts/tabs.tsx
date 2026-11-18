import { SegmentedNav } from "../kit/segmented";

/** COMPANIES-MODEL: the one address book. People and companies are records; clients are the ones you sell to. */
export function BookTabs({ current, counts, clients = "Clients" }: { current: "people" | "companies" | "clients"; counts?: { people?: number; companies?: number; clients?: number }; clients?: string }) {
  return <SegmentedNav label="Address book" items={[
    { key: "people", href: "/contacts", label: "Contacts", count: counts?.people, current: current === "people" },
    { key: "companies", href: "/contacts/companies", label: "Companies", count: counts?.companies, current: current === "companies" },
    { key: "clients", href: "/clients", label: clients, count: counts?.clients, current: current === "clients" },
  ]} />;
}
