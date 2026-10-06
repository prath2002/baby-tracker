/*
 * Clinical release gate (spec §19): changes a reference rule's or growth dataset's gate, recording two named reviewers.
 *   npm run reference:release -- --id FG_WHO_RESPONSIVE --gate CLEARED --clinician "Dr A. Name, MD Pediatrics" --checker "B. Name" --page "Key facts"
 *   npm run reference:release -- --dataset WFA_MALE_DAY --gate CLEARED --clinician "..." --checker "..."
 *   npm run reference:release -- --list            (show all gates)
 * Gates: CLEARED | HUMAN_RECHECK_REQUIRED | BLOCKED_UNTIL_PRIMARY_SOURCE_VERIFIED | REJECTED
 */
import "./load-env";
import { Client } from "pg";

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const c = new Client({ connectionString: (process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL), ssl: /sslmode=require|neon\.tech|supabase\.co/.test((process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL) ?? "") ? { rejectUnauthorized: true } : undefined });
  await c.connect();
  if (process.argv.includes("--list")) {
    const r = await c.query("SELECT id, bucket, release_gate FROM reference_rule ORDER BY bucket, id");
    for (const row of r.rows) console.log(`${row.release_gate.padEnd(48)} ${row.bucket.padEnd(42)} ${row.id}`);
    const d = await c.query("SELECT id, release_gate, validation_report->>'passed' AS passed FROM growth_reference_dataset ORDER BY id");
    for (const row of d.rows) console.log(`${row.release_gate.padEnd(48)} growth_dataset (validated=${row.passed})`.padEnd(92) + row.id);
    await c.end();
    return;
  }
  const id = arg("id"), dataset = arg("dataset"), gate = arg("gate"), clinician = arg("clinician"), checker = arg("checker"), page = arg("page"), note = arg("note");
  const GATES = ["CLEARED", "HUMAN_RECHECK_REQUIRED", "BLOCKED_UNTIL_PRIMARY_SOURCE_VERIFIED", "REJECTED"];
  if ((!id && !dataset) || !gate || !GATES.includes(gate)) throw new Error("Provide --id or --dataset and --gate (" + GATES.join("|") + ")");
  if (gate === "CLEARED" && (!clinician || !checker)) throw new Error("CLEARED requires --clinician and --checker (two named reviewers)");
  if (gate === "CLEARED" && clinician === checker) throw new Error("Clinician reviewer and source checker must be two different people");
  await c.query("BEGIN");
  if (id) {
    const r = await c.query("SELECT release_gate FROM reference_rule WHERE id = $1 FOR UPDATE", [id]);
    if (!r.rowCount) throw new Error(`Unknown rule ${id}`);
    await c.query("UPDATE reference_rule SET release_gate = $2 WHERE id = $1", [id, gate]);
    await c.query(`INSERT INTO reference_release_log(rule_id, previous_gate, new_gate, clinician_reviewer, source_checker, page_or_section, note) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, r.rows[0].release_gate, gate, clinician ?? "-", checker ?? "-", page ?? null, note ?? null]);
    console.log(`${id}: ${r.rows[0].release_gate} -> ${gate}`);
  } else {
    const r = await c.query("SELECT release_gate, validation_report FROM growth_reference_dataset WHERE id = $1 FOR UPDATE", [dataset]);
    if (!r.rowCount) throw new Error(`Unknown dataset ${dataset}`);
    if (gate === "CLEARED" && !r.rows[0].validation_report?.passed) throw new Error("Dataset failed internal validation; cannot clear");
    await c.query("UPDATE growth_reference_dataset SET release_gate = $2, validation_report = validation_report || $3::jsonb WHERE id = $1",
      [dataset, gate, JSON.stringify({ released_by: { clinician, checker, at: new Date().toISOString(), note } })]);
    console.log(`${dataset}: ${r.rows[0].release_gate} -> ${gate}`);
  }
  await c.query("COMMIT");
  await c.end();
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
