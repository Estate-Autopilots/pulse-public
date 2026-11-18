// FIN-AGENT-2: synthetic GST portal returns for the tests (sandbox.test.mjs, services/api/test/fin-agent-2-runner.mjs):
// GSTINs are the leak gate's reviewed synthetic values only; every figure is made up, with one of each problem the GST
// check looks for (GSTR-1 above GSTR-3B, credit above GSTR-2B, an invoice missing on each side, one with other amounts,
// a supplier bill with no payment).
export const GST_OWN = "27AAAAA0000A1Z5", GST_CLIENT = "27BBBBB1111B1Z6", GST_FAR = "29AAACN1234F1ZT", GST_SUPPLIER = "27ABCDE1234F1Z5";
export function gstFixtures() {
  const gstr1 = { gstin: GST_OWN, fp: "102026",
    b2b: [{ ctin: GST_CLIENT, inv: [{ inum: "EA/26-27/041", idt: "05-10-2026", val: 118000, pos: "27", itms: [{ num: 1, itm_det: { rt: 18, txval: 100000, camt: 9000, samt: 9000, iamt: 0, csamt: 0 } }] },
      { inum: "EA/26-27/042", idt: "12-10-2026", val: 59000, pos: "27", itms: [{ num: 1, itm_det: { rt: 18, txval: 50000, camt: 4500, samt: 4500 } }] }] },
    { ctin: GST_FAR, inv: [{ inum: "EA/26-27/044", idt: "20-10-2026", val: 236000, pos: "29", itms: [{ num: 1, itm_det: { rt: 18, txval: 200000, iamt: 36000 } }] }] }],
    b2cs: [{ sply_ty: "INTRA", pos: "27", typ: "OE", txval: 10000, rt: 18, camt: 900, samt: 900 }] };
  const gstr3b = { gstin: GST_OWN, ret_period: "102026", sup_details: { osup_det: { txval: 350000, iamt: 10000, camt: 18000, samt: 18000, csamt: 0 } },
    itc_elg: { itc_net: { iamt: 0, camt: 5400, samt: 5400, csamt: 0 } } };
  const gstr2b = { data: { gstin: GST_OWN, rtnprd: "102026", docdata: { b2b: [{ ctin: GST_SUPPLIER, trdnm: "Synthetic Lens Rentals", inv: [
    { inum: "SLR-881", dt: "03-10-2026", val: 35400, itcavl: "Y", rev: "N", items: [{ txval: 30000, cgst: 2700, sgst: 2700, igst: 0, cess: 0 }] },
    { inum: "SLR-902", dt: "18-10-2026", val: 23600, itcavl: "Y", rev: "N", items: [{ txval: 20000, cgst: 1800, sgst: 1800, igst: 0, cess: 0 }] }] }] } } };
  const inv = (no, date, taxable, cgst, sgst, igst, gstin) => ({ no, date, taxable: taxable * 100, cgst: cgst * 100, sgst: sgst * 100, igst: igst * 100, gst: (cgst + sgst + igst) * 100,
    amount: (taxable + cgst + sgst + igst) * 100, gstin, client: "Synthetic Client", status: "issued" });
  const invoices = [inv("EA/26-27/041", "2026-10-05", 100000, 9000, 9000, 0, GST_CLIENT), inv("EA-26-27-42", "2026-10-12", 55000, 4950, 4950, 0, GST_CLIENT),
    inv("EA/26-27/043", "2026-10-15", 40000, 3600, 3600, 0, GST_CLIENT)];
  // SLR-881 paid less 2% TDS on its taxable value; SLR-902 not paid.
  const payments = [{ date: "2026-10-10", amount: 3480000, who: "SYNTHETIC LENS RENTALS", narration: "NEFT/SYNTHETIC LENS RENTALS/SLR 881" },
    { date: "2026-10-11", amount: 999900, who: "SOMEONE ELSE", narration: "UPI/SOMEONE ELSE" }];
  return { gstr1, gstr3b, gstr2b, invoices, payments };
}

