"use client";
// LAYOUT-SWEEP: printed copies and saved PDFs (payslips, policies) carry the organisation's own logo at the top. With
// no logo set the space closes up.
export function PrintBrand() {
  // eslint-disable-next-line @next/next/no-img-element -- the organisation's logo, served by the app
  return <img src="/api/v0/brand/logo" alt="" aria-hidden="true" style={{ display: "block", height: 36, width: "auto", maxWidth: 240, margin: "0 0 14px" }} onError={(e) => { e.currentTarget.style.display = "none"; }} />;
}
