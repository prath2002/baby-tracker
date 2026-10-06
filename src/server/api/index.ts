import "server-only";
import { Router } from "../http";
import { assertSafeConfig } from "../env";
import { checkDbRole } from "../dbcheck";
import { registerAuth } from "./auth";
import { registerBabies } from "./babies";
import { registerFeedings } from "./feedings";
import { registerReferences } from "./references";
import { registerGrowth } from "./growth";
import { registerVaccinations } from "./vaccinations";
import { registerCare } from "./care";
import { registerMeds } from "./meds";
import { registerDocuments } from "./documents";
import { registerTimeline } from "./timeline";
import { registerSummaries } from "./summaries";
import { registerExports } from "./exports";

let router: Router | null = null;
export function apiRouter() {
  if (router) return router;
  assertSafeConfig();
  const r = new Router();
  registerAuth(r);
  registerBabies(r);
  registerFeedings(r);
  registerReferences(r);
  registerGrowth(r);
  registerVaccinations(r);
  registerCare(r);
  registerMeds(r);
  registerDocuments(r);
  registerTimeline(r);
  registerSummaries(r);
  registerExports(r);
  r.get("/health", async () => { const db = await checkDbRole(); return { ok: true, rls_enforced: db.rls_enforced }; }, { auth: "public" });
  router = r;
  return r;
}
