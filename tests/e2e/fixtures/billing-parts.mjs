// Synthetic catalogue only; saves are intercepted by billing-parts.spec.ts.
const common = { code: null, description: "", sac: null, unit: "month", price: 100000, gstRate: 18, cost: null,
  trackStock: false, reorderLevel: null, status: "active", version: 1, source: {}, updatedAt: "2026-10-18T00:00:00Z" };
const service = { ...common, id: "synthetic-service", kind: "service", name: "Synthetic Design" };
const pkg = { ...common, id: "synthetic-package", kind: "package", name: "Synthetic Package", parts: 1 };
const freePkg = { ...pkg, id: "synthetic-free-package", name: "Synthetic Free Package" };
const part = { itemId: service.id, label: service.name, quantity: 1, unit: "month", deliverables: [service.name],
  where: "", setup: "", derives: "", price: 100000, cost: null };

export function billingPartsAnswer(path, method) {
  if (method !== "GET") return null;
  if (path === "/api/v0/erp/items") return { items: [pkg, freePkg, service], inventoryEnabled: false, canWrite: true };
  if (path === "/api/v0/erp/items/synthetic-package") return { item: pkg, parts: [part] };
  if (path === "/api/v0/erp/items/synthetic-free-package") return { item: freePkg, parts: [{ ...part, itemId: null }] };
  return null;
}
