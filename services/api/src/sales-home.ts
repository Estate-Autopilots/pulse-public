// EST-1240: the sales home's summary for the signed-in person (0650 sales_home_summary): their urgent tasks, today's
// calls and their five most recent quotations, each section on its own (?section=urgent|calls|quotes, default all) so
// the page loads and retries them separately. Everything is the viewer's own; the organisation and person come from the
// session. `eligible` is the discriminator the web reads: true when the organisation's admin chose the sales home for
// this person's role (Settings → Modules → Screens and menu; screens.ts). Other roles keep their configured home.
import type { FastifyInstance } from "fastify";
import { viewerHome } from "./screens.js";
import { fail, work, type Tx } from "./routes.js";
import { roleScreens } from "./flow/setup.js";

export const SALES_HOME_SECTIONS = ["all", "urgent", "calls", "quotes"] as const;

export function registerSalesHomeRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get<{ Querystring: { section?: string } }>("/api/v0/sales-home", (req) => tx(req, async (c, v) => {
    work(v);
    if (!v.person || v.role === "accountant") fail(403, "A sales home belongs to a staff person");
    const section = req.query.section ?? "all";
    if (!(SALES_HOME_SECTIONS as readonly string[]).includes(section)) fail(400, "Choose urgent, calls or quotes");
    const summary = (await c.query("select pulse.sales_home_summary($1) s", [section])).rows[0].s as Record<string, unknown>;
    // FLOW-E: a work role whose home is the sales home (Settings → Industry & roles) lands there too.
    const roleHome = (await roleScreens(c, v.person)).home;
    return { eligible: (roleHome ?? await viewerHome(c, v.role)) === "sales", person: { id: v.person, name: v.name }, ...summary };
  }));
}
