/*
 * Loads reference/medical_reference_data.json into the database (spec §19 "reference release").
 * Gates are taken from the file. A gate previously CLEARED by reviewers is preserved only when the
 * rule's content is byte-identical; any content change resets it to the file's gate (and is logged).
 * Usage: npm run reference:seed
 */
import "./load-env";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Client } from "pg";
import { pgSsl } from "../src/lib/pg-ssl";

type Rec = Record<string, unknown> & { id: string; release_gate?: string; provenance?: Record<string, string>; population?: string; clinical_context?: string };

function canonical(o: unknown): string {
  if (Array.isArray(o)) return "[" + o.map(canonical).join(",") + "]";
  if (o && typeof o === "object") return "{" + Object.keys(o).sort().filter((k) => k !== "release_gate").map((k) => JSON.stringify(k) + ":" + canonical((o as Record<string, unknown>)[k])).join(",") + "}";
  return JSON.stringify(o);
}

export async function seedReferences(databaseUrl: string, file = "reference/medical_reference_data.json", log = console.log) {
  const raw = readFileSync(file, "utf8");
  const fileSha = createHash("sha256").update(raw).digest("hex");
  const data = JSON.parse(raw);
  const ssl = pgSsl(databaseUrl);
  const c = new Client({ connectionString: databaseUrl, ssl });
  await c.connect();
  try {
    await c.query("BEGIN");
    for (const s of data.sources) {
      await c.query(
        `INSERT INTO reference_source(source_id, organization, document_title, document_type, country, tier, source_url, publication_date, version, retrieved_at, verified_at, verification_status, access_note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (source_id) DO UPDATE SET organization=EXCLUDED.organization, document_title=EXCLUDED.document_title, document_type=EXCLUDED.document_type,
           country=EXCLUDED.country, tier=EXCLUDED.tier, source_url=EXCLUDED.source_url, publication_date=EXCLUDED.publication_date, version=EXCLUDED.version,
           retrieved_at=EXCLUDED.retrieved_at, verified_at=EXCLUDED.verified_at, verification_status=EXCLUDED.verification_status, access_note=EXCLUDED.access_note`,
        [s.source_id, s.organization, s.document_title, s.document_type, s.country, s.tier, s.source_url, s.publication_date, s.version, s.retrieved_at, s.verified_at, s.verification_status, s.access_note ?? null]);
    }
    const buckets = ["feeding_guidelines", "clinical_feeding_rules", "breastfeeding_adequacy_indicators", "growth_references", "complementary_feeding"];
    const records: [string, Rec][] = [];
    for (const b of buckets) for (const r of data[b] as Rec[]) records.push([b, r]);
    for (const sched of data.vaccination_schedules) for (const item of sched.items as Rec[]) records.push([`vaccination:${sched.schedule_id}`, item]);

    let preserved = 0, reset = 0, inserted = 0;
    for (const [bucket, r] of records) {
      const sourceId = r.provenance?.source_id;
      if (!sourceId) throw new Error(`Record ${r.id} has no provenance.source_id`);
      const contentHash = createHash("sha256").update(canonical(r)).digest("hex");
      const payload = { ...r, content_sha256: contentHash };
      const existing = await c.query("SELECT release_gate, payload->>'content_sha256' AS h FROM reference_rule WHERE id = $1", [r.id]);
      let gate = r.release_gate ?? "BLOCKED_UNTIL_PRIMARY_SOURCE_VERIFIED";
      if (existing.rowCount) {
        const prev = existing.rows[0];
        if (prev.release_gate === "CLEARED" && prev.h === contentHash) { gate = "CLEARED"; preserved++; }
        else if (prev.release_gate === "CLEARED") {
          reset++;
          await c.query(`INSERT INTO reference_release_log(rule_id, previous_gate, new_gate, clinician_reviewer, source_checker, note)
                         VALUES ($1,'CLEARED',$2,'SYSTEM','SYSTEM','Content changed in data file; clearance reset')`, [r.id, gate]);
        }
      } else inserted++;
      await c.query(
        `INSERT INTO reference_rule(id, bucket, source_id, population, clinical_context, payload, release_gate, data_file_sha256)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO UPDATE SET bucket=EXCLUDED.bucket, source_id=EXCLUDED.source_id, population=EXCLUDED.population,
           clinical_context=EXCLUDED.clinical_context, payload=EXCLUDED.payload, release_gate=EXCLUDED.release_gate, data_file_sha256=EXCLUDED.data_file_sha256`,
        [r.id, bucket, sourceId, String(r.population ?? r.provenance?.population ?? "UNSPECIFIED"), String(r.clinical_context ?? r.provenance?.clinical_context ?? "UNSPECIFIED"), payload, gate, fileSha]);
    }
    for (const cf of data.conflicts) await c.query("INSERT INTO reference_conflict(id, payload) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload", [cf.id, cf]);
    for (const u of data.unsupported_claims) await c.query("INSERT INTO reference_unsupported(id, payload) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload", [u.id, u]);
    const schedMeta = data.vaccination_schedules.map((s: Rec & { items: unknown[] }) => ({ ...s, items: undefined }));
    await c.query("INSERT INTO reference_meta(key, value) VALUES ('vaccination_schedules', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [JSON.stringify(schedMeta)]);
    await c.query("INSERT INTO reference_meta(key, value) VALUES ('metadata', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [JSON.stringify({ ...data.metadata, data_file_sha256: fileSha })]);
    await c.query("COMMIT");
    log(`Reference data loaded (sha256 ${fileSha.slice(0, 12)}…): ${records.length} rules, ${inserted} new, ${preserved} clearances preserved, ${reset} clearances reset.`);
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    await c.end();
  }
}

if (process.argv[1]?.endsWith("reference-seed.ts")) {
  seedReferences((process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL)!).catch((e) => { console.error(e); process.exit(1); });
}
