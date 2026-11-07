/** Return a company label only when branding names a configured organisation. */
export function organizationDisplayName(name: string | null | undefined): string | undefined {
  const normalized = name?.trim();
  return normalized && normalized !== "Pulse" ? normalized : undefined;
}
