import "server-only";
import { notFound, type Router } from "../http";
import { requireBaby } from "../core";
import { applicableReference } from "./feedings";
import { isDisplayable } from "../reference/engine";
import { referencePreview } from "../env";

export function registerReferences(r: Router) {
  r.get("/references/sources", async (ctx) => ctx.q("SELECT * FROM reference_source ORDER BY organization, source_id"));
  r.get("/references/sources/:id", async (ctx) => {
    const s = await ctx.q.one("SELECT * FROM reference_source WHERE source_id = $1", [ctx.params.id]);
    if (!s) throw notFound("Source");
    return s;
  });
  /** Only rules whose release gate is CLEARED (or preview mode outside production). */
  r.get("/references/rules", async (ctx) => {
    const rows = await ctx.q<{ release_gate: string; payload: Record<string, unknown> }>(
      "SELECT id, bucket, source_id, population, clinical_context, payload, release_gate FROM reference_rule WHERE ($1::text IS NULL OR population = $1) AND ($2::text IS NULL OR clinical_context = $2) ORDER BY bucket, id",
      [ctx.query.get("population"), ctx.query.get("context")]);
    return { preview_mode: referencePreview(), data: rows.filter((x) => isDisplayable(x.release_gate)) };
  });
  r.get("/references/status", async (ctx) =>
    ctx.q("SELECT bucket, release_gate, count(*)::int AS n FROM reference_rule GROUP BY bucket, release_gate ORDER BY bucket, release_gate"));
  r.get("/references/conflicts", async (ctx) => (await ctx.q<{ payload: unknown }>("SELECT payload FROM reference_conflict ORDER BY id")).map((x) => x.payload));
  r.get("/references/unsupported", async (ctx) => (await ctx.q<{ payload: unknown }>("SELECT payload FROM reference_unsupported ORDER BY id")).map((x) => x.payload));
  r.get("/references/metadata", async (ctx) => (await ctx.q.one<{ value: unknown }>("SELECT value FROM reference_meta WHERE key = 'metadata'"))?.value ?? {});
  r.get("/babies/:babyId/references/applicable", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "READ");
    return applicableReference(ctx, a, ctx.query.get("method") ?? "ANY");
  });
}
