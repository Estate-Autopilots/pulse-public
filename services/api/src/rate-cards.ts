// KAZUK-REST (6 Nov 2026, migration 1710; Kazuk's Quotation Builder v2, A8): rate cards in Billing.
//   GET  /api/v0/erp/rate-cards            every card (archived ones too), the services a card can be for, and whether
//                                          this person may edit (leadership and admins: they approve prices)
//   POST /api/v0/erp/rate-cards            a new card {itemId, name, base, xLabel, xMin, xMax, talents, periods, addOns}
//   POST /api/v0/erp/rate-cards/:id        change a card, or {status: "archived" | "active"}
// The composer reads the active cards with the document (activeRateCards) and builds quotation lines from them; the
// database prices each line from its card (erp_line.rate_card → catalogue_rate) and gates a price away from it.
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { fail, type Tx } from "./routes.js";
import { cleanCard, hiddenCard, type Period, type Talent } from "./rate-card-model.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COLS = `r.id,r.item_id "itemId",r.name,r.base::float8 base,r.x_label "xLabel",r.x_min::float8 "xMin",r.x_max::float8 "xMax",r.talents,r.periods,r.add_ons "addOns",
  r.status,r.version,r.updated_at "updatedAt",i.name "serviceName",i.sac,i.unit,i.gst_rate::float8 "gstRate",i.status "serviceStatus"`;

/** QUOTE-STRUCT: a seat that does not see cost reads no base price or factors (the guide's critical check), only prices. */
const forSeat = async (c: PoolClient, cards: { base: number; talents: Talent[]; periods: Period[] }[]) =>
  (await c.query("select pulse.erp_sees_cost() s")).rows[0].s ? cards : cards.map(hiddenCard);
/** The active rate cards, with their service's tax details, for the composer. */
export async function activeRateCards(c: PoolClient) {
  return forSeat(c, (await c.query(`select ${COLS} from pulse.erp_rate_card r join pulse.erp_item i on i.id=r.item_id where r.status='active' and i.status<>'archived' order by r.name`)).rows);
}

const editor = async (c: PoolClient) => {
  await c.query("select pulse.erp_require(true)");
  if (!(await c.query("select pulse.viewer_is('leadership','admin') ok")).rows[0].ok) fail(403, "Only leadership or an admin changes rate cards: their prices are approved prices");
};

export function registerRateCardRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get("/api/v0/erp/rate-cards", (req) => tx(req, async (c) => {
    await c.query("select pulse.erp_require(false)");
    const cards = await forSeat(c, (await c.query(`select ${COLS} from pulse.erp_rate_card r join pulse.erp_item i on i.id=r.item_id order by r.status='archived',r.name`)).rows);
    const services = (await c.query(`select id,name,price::float8 price,unit from pulse.erp_item where kind='service' and status<>'archived' order by name`)).rows;
    const canEdit = (await c.query("select pulse.erp_can(true) and pulse.viewer_is('leadership','admin') ok")).rows[0].ok as boolean;
    return { cards, services, canEdit, seesCost: (await c.query("select pulse.erp_sees_cost() s")).rows[0].s as boolean };
  }));
  app.post<{ Body: unknown }>("/api/v0/erp/rate-cards", (req) => tx(req, async (c, v) => {
    await editor(c);
    const k = cleanCard(req.body);
    if (!(await c.query("select 1 from pulse.erp_item where id=$1 and kind='service'", [k.itemId])).rows[0]) fail(400, "Choose a service from the catalogue");
    const r = (await c.query(`insert into pulse.erp_rate_card(org_id,item_id,name,base,x_label,x_min,x_max,talents,periods,add_ons,created_by,updated_by)
      values(pulse.current_org(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) returning id,version`,
      [k.itemId, k.name, k.base, k.xLabel, k.xMin, k.xMax, JSON.stringify(k.talents), JSON.stringify(k.periods), JSON.stringify(k.addOns), v.person])).rows[0];
    return { ok: true, id: r.id, version: r.version };
  }));
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/v0/erp/rate-cards/:id", (req) => tx(req, async (c, v) => {
    await editor(c);
    const cardId = UUID.test(req.params.id) ? req.params.id : fail(404, "Rate card not found");
    const b = req.body ?? {};
    if (!(await c.query("select 1 from pulse.erp_rate_card where id=$1", [cardId])).rows[0]) fail(404, "Rate card not found");
    // QUOTE-STRUCT (Kazuk's bug list: "saving an existing card bumps its version but drops the change"): only a request
    // that is just a status archives or restores; a whole card that carries its status is saved as edited.
    if ((b.status === "archived" || b.status === "active") && b.itemId === undefined && b.talents === undefined && b.periods === undefined) {
      const r = (await c.query("update pulse.erp_rate_card set status=$2,updated_by=$3 where id=$1 returning version", [cardId, b.status, v.person])).rows[0];
      return { ok: true, version: r.version };
    }
    const k = cleanCard(b);
    if (!(await c.query("select 1 from pulse.erp_item where id=$1 and kind='service'", [k.itemId])).rows[0]) fail(400, "Choose a service from the catalogue");
    const r = (await c.query(`update pulse.erp_rate_card set item_id=$2,name=$3,base=$4,x_label=$5,x_min=$6,x_max=$7,talents=$8,periods=$9,add_ons=$10,updated_by=$11 where id=$1 returning version`,
      [cardId, k.itemId, k.name, k.base, k.xLabel, k.xMin, k.xMax, JSON.stringify(k.talents), JSON.stringify(k.periods), JSON.stringify(k.addOns), v.person])).rows[0];
    return { ok: true, version: r.version };
  }));
}
