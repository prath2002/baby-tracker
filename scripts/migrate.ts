/* Applies db/migrations/*.sql in order, once each. Usage: npm run db:migrate */
import "./load-env";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Client } from "pg";
import { pgSsl } from "../src/lib/pg-ssl";

async function main() {
  const url = (process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL);
  if (!url) throw new Error("DATABASE_URL is not set");
  const ssl = pgSsl(url);
  const c = new Client({ connectionString: url, ssl });
  await c.connect();
  await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, sha256 char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const dir = join(process.cwd(), "db", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const done = new Map((await c.query("SELECT name, sha256 FROM schema_migrations")).rows.map((r) => [r.name, r.sha256]));
  for (const f of files) {
    const sql = readFileSync(join(dir, f), "utf8");
    const sha = createHash("sha256").update(sql).digest("hex");
    if (done.has(f)) {
      if (done.get(f) !== sha) throw new Error(`Migration ${f} was modified after being applied. Create a new migration instead.`);
      continue;
    }
    process.stdout.write(`Applying ${f} ... `);
    await c.query("BEGIN");
    try {
      await c.query(sql);
      await c.query("INSERT INTO schema_migrations(name, sha256) VALUES ($1, $2)", [f, sha]);
      await c.query("COMMIT");
      console.log("ok");
    } catch (e) {
      await c.query("ROLLBACK");
      console.log("FAILED");
      throw e;
    }
  }
  await c.end();
  console.log("Migrations up to date.");
}
main().catch((e) => { console.error(e); process.exit(1); });
