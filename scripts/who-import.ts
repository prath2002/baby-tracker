/*
 * Imports the official WHO Child Growth Standards expanded tables (L, M, S + SD columns) into the database.
 * No values are typed by hand: files are downloaded from cdn.who.int (or read from --from-dir), hashed (sha256),
 * parsed, and validated internally (published SD columns must match values recomputed from L, M, S).
 * Datasets are imported with release_gate = HUMAN_RECHECK_REQUIRED; clear them with `npm run reference:release -- --dataset ...`
 * after comparing a sample against WHO Anthro (spec §15, Q9).
 *
 *   npm run who:import                       # download from WHO
 *   npm run who:import -- --from-dir ./who   # use files you downloaded manually (same file names as the WHO URLs)
 */
import "./load-env";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { Client } from "pg";
import { pgSsl } from "../src/lib/pg-ssl";
import { validateSdColumns, type Indicator } from "../src/lib/growth";

type Spec = { id: string; indicator: string; code: Indicator; sex: "MALE" | "FEMALE"; xAxis: "AGE_DAYS" | "LENGTH_CM" | "HEIGHT_CM"; page: string; keywords: string[]; url?: string };
const CDN = "https://cdn.who.int/media/docs/default-source/child-growth/child-growth-standards/indicators/";
const PAGES = {
  WFA: "https://www.who.int/tools/child-growth-standards/standards/weight-for-age",
  LHFA: "https://www.who.int/tools/child-growth-standards/standards/length-height-for-age",
  WFLH: "https://www.who.int/tools/child-growth-standards/standards/weight-for-length-height",
  BMI: "https://www.who.int/toolkits/child-growth-standards/standards/body-mass-index-for-age-bmi-for-age",
  HCFA: "https://www.who.int/tools/child-growth-standards/standards/head-circumference-for-age",
};
const SPECS: Spec[] = [
  { id: "WFA_MALE_DAY", indicator: "WEIGHT_FOR_AGE", code: "WFA", sex: "MALE", xAxis: "AGE_DAYS", page: PAGES.WFA, keywords: ["wfa", "boys", "zscore", "expanded"], url: CDN + "weight-for-age/expanded-tables/wfa-boys-zscore-expanded-tables.xlsx?sfvrsn=65cce121_10" },
  { id: "WFA_FEMALE_DAY", indicator: "WEIGHT_FOR_AGE", code: "WFA", sex: "FEMALE", xAxis: "AGE_DAYS", page: PAGES.WFA, keywords: ["wfa", "girls", "zscore", "expanded"], url: CDN + "weight-for-age/expanded-tables/wfa-girls-zscore-expanded-tables.xlsx?sfvrsn=f01bc813_10" },
  { id: "LHFA_MALE_DAY", indicator: "LENGTH_HEIGHT_FOR_AGE", code: "LHFA", sex: "MALE", xAxis: "AGE_DAYS", page: PAGES.LHFA, keywords: ["lhfa", "boys", "zscore", "expanded"], url: CDN + "length-height-for-age/expandable-tables/lhfa-boys-zscore-expanded-tables.xlsx?sfvrsn=7b4a3428_12" },
  { id: "LHFA_FEMALE_DAY", indicator: "LENGTH_HEIGHT_FOR_AGE", code: "LHFA", sex: "FEMALE", xAxis: "AGE_DAYS", page: PAGES.LHFA, keywords: ["lhfa", "girls", "zscore", "expanded"], url: CDN + "length-height-for-age/expandable-tables/lhfa-girls-zscore-expanded-tables.xlsx?sfvrsn=27f1e2cb_10" },
  { id: "HCFA_MALE_DAY", indicator: "HEAD_CIRCUMFERENCE_FOR_AGE", code: "HCFA", sex: "MALE", xAxis: "AGE_DAYS", page: PAGES.HCFA, keywords: ["hcfa", "boys", "zscore", "expanded"] },
  { id: "HCFA_FEMALE_DAY", indicator: "HEAD_CIRCUMFERENCE_FOR_AGE", code: "HCFA", sex: "FEMALE", xAxis: "AGE_DAYS", page: PAGES.HCFA, keywords: ["hcfa", "girls", "zscore", "expanded"] },
  { id: "BFA_MALE_DAY", indicator: "BMI_FOR_AGE", code: "BMI", sex: "MALE", xAxis: "AGE_DAYS", page: PAGES.BMI, keywords: ["bfa", "boys", "zscore", "expanded"] },
  { id: "BFA_FEMALE_DAY", indicator: "BMI_FOR_AGE", code: "BMI", sex: "FEMALE", xAxis: "AGE_DAYS", page: PAGES.BMI, keywords: ["bfa", "girls", "zscore", "expanded"] },
  { id: "WFL_MALE", indicator: "WEIGHT_FOR_LENGTH", code: "WFL", sex: "MALE", xAxis: "LENGTH_CM", page: PAGES.WFLH, keywords: ["wfl", "boys", "zscore", "expanded"] },
  { id: "WFL_FEMALE", indicator: "WEIGHT_FOR_LENGTH", code: "WFL", sex: "FEMALE", xAxis: "LENGTH_CM", page: PAGES.WFLH, keywords: ["wfl", "girls", "zscore", "expanded"] },
  { id: "WFH_MALE", indicator: "WEIGHT_FOR_HEIGHT", code: "WFH", sex: "MALE", xAxis: "HEIGHT_CM", page: PAGES.WFLH, keywords: ["wfh", "boys", "zscore", "expanded"] },
  { id: "WFH_FEMALE", indicator: "WEIGHT_FOR_HEIGHT", code: "WFH", sex: "FEMALE", xAxis: "HEIGHT_CM", page: PAGES.WFLH, keywords: ["wfh", "girls", "zscore", "expanded"] },
];

const pageCache = new Map<string, string[]>();
async function resolveUrl(s: Spec): Promise<string | null> {
  if (s.url) return s.url;
  if (!pageCache.has(s.page)) {
    const html = await (await fetch(s.page)).text();
    pageCache.set(s.page, [...html.matchAll(/href="([^"]+\.xlsx[^"]*)"/gi)].map((m) => m[1].replace(/&amp;/g, "&")));
  }
  const links = pageCache.get(s.page)!;
  return links.find((l) => s.keywords.every((k) => l.toLowerCase().replace(/[_-]/g, "").includes(k.replace(/[_-]/g, "")))) ?? null;
}

async function parse(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  let header: string[] | null = null;
  const rows: { x: number; l: number; m: number; s: number; sd: Record<string, number> }[] = [];
  ws.eachRow((row) => {
    const vals = (row.values as unknown[]).slice(1).map((v) => (v && typeof v === "object" && "result" in (v as object) ? (v as { result: unknown }).result : v));
    if (!header) {
      const h = vals.map((v) => String(v ?? "").trim());
      if (h.includes("L") && h.includes("M") && h.includes("S")) header = h;
      return;
    }
    const rec: Record<string, number> = {};
    header.forEach((k, i) => { const n = Number(vals[i]); if (k && Number.isFinite(n)) rec[k] = n; });
    const xKey = header[0];
    if (rec[xKey] === undefined || rec.L === undefined) return;
    const sd: Record<string, number> = {};
    for (const k of Object.keys(rec)) if (/^SD\d(neg)?$/i.test(k)) sd[k.replace(/^sd/i, "SD")] = rec[k];
    rows.push({ x: rec[xKey], l: rec.L, m: rec.M, s: rec.S, sd });
  });
  if (!header) throw new Error("Could not find a header row with L, M, S columns");
  return { header: header as string[], rows };
}

async function main() {
  const fromDir = process.argv.includes("--from-dir") ? process.argv[process.argv.indexOf("--from-dir") + 1] : null;
  const c = new Client({ connectionString: (process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL), ssl: pgSsl((process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL) ?? "") });
  await c.connect();
  for (const s of SPECS) {
    try {
      const url = await resolveUrl(s);
      if (!url) { console.warn(`! ${s.id}: could not find the expanded z-score table link on ${s.page}. Download it manually and use --from-dir.`); continue; }
      let buf: Buffer;
      const fname = decodeURIComponent(new URL(url).pathname.split("/").pop()!);
      if (fromDir) {
        const p = join(fromDir, fname);
        if (!existsSync(p)) { console.warn(`! ${s.id}: ${p} not found`); continue; }
        buf = readFileSync(p);
      } else {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        buf = Buffer.from(await res.arrayBuffer());
      }
      const sha = createHash("sha256").update(buf).digest("hex");
      const { header, rows } = await parse(buf);
      const v = validateSdColumns(rows, s.code);
      const report = { ...v, header, rows: rows.length, x_min: rows[0]?.x, x_max: rows[rows.length - 1]?.x, file: fname, method: "Published SD columns compared with values recomputed from L,M,S (|Δ| ≤ 0.051)", anthro_comparison: "PENDING" };
      await c.query("BEGIN");
      await c.query("DELETE FROM growth_reference_dataset WHERE id = $1", [s.id]);
      await c.query(`INSERT INTO growth_reference_dataset(id, indicator, sex, x_axis, source_file_url, file_sha256, row_count, validation_report, release_gate)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'HUMAN_RECHECK_REQUIRED')`, [s.id, s.indicator, s.sex, s.xAxis, url, sha, rows.length, JSON.stringify(report)]);
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        const vals: unknown[] = [];
        const ph = chunk.map((r, j) => { vals.push(s.id, r.x, r.l, r.m, r.s, JSON.stringify(r.sd)); const b = j * 6; return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6})`; });
        await c.query(`INSERT INTO growth_reference(dataset_id, x_value, l, m, s, sd) VALUES ${ph.join(",")}`, vals);
      }
      await c.query("COMMIT");
      console.log(`✓ ${s.id}: ${rows.length} rows, sha256 ${sha.slice(0, 12)}…, internal validation ${v.passed ? "PASSED" : "FAILED"} (max |Δ| ${v.maxAbsValueError})`);
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      console.error(`✗ ${s.id}: ${(e as Error).message}`);
    }
  }
  await c.end();
  console.log("\nDatasets are imported with release_gate=HUMAN_RECHECK_REQUIRED. Compare against WHO Anthro, then clear with:\n  npm run reference:release -- --dataset WFA_MALE_DAY --gate CLEARED --clinician \"...\" --checker \"...\"");
}
main().catch((e) => { console.error(e); process.exit(1); });
