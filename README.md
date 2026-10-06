# Baby Health

A calm, private, multi-baby health record for Indian families. It's an installable web app (PWA) built from the *Baby Health — Medical and Product Specification* (in `docs/`).

> **Medical safety first.** The app records what happened and shows sourced reference guidance. It never invents medical numbers. Every reference value comes from `reference/medical_reference_data.json` with full provenance, and **nothing reaches a parent's screen until a pediatrician and a source-checker clear it** (see [`docs/CLINICAL-RELEASE.md`](docs/CLINICAL-RELEASE.md)). Healthy breastfed babies see "No universal milk amount applies", never a millilitre target.

## What's in the box

| Area | Highlights |
|---|---|
| Babies | Multiple babies per family. Twins and siblings get distinct colours. Explicit baby picker, a "For {name}" identity bar on every form, move-to-another-baby with audit. Exact age in weeks + days, leap-year safe, uses the household timezone. |
| Feeding | Breastfeed / expressed / formula / other. Breastfeeding stores **no volume** (enforced in the database). ml or oz. Duplicate detection. Undo. Works offline with an exactly-once sync queue. |
| Reference engine | Population × context × release-gate resolution. `NO_AUTHORITATIVE_UNIVERSAL_VALUE_FOUND` / `NOT_ESTABLISHED` / `CLINICAL_REFERENCE` / `CARE_TEAM_PLAN` / `CONFLICT_REQUIRES_REVIEW`. Never multiplies ml/kg/day into a personal target. |
| Growth | WHO Child Growth Standards imported from official files (sha256-pinned, self-validated), LMS z-scores and percentiles, "Growth reference" wording only. |
| Vaccines | GoI UIP and IAP kept as separate, versioned schedules. JE is opt-in. No invented overdue thresholds. Doses are recorded verbatim. |
| Care | Appointments with visit prep, prescriptions stored verbatim (doses are never inferred), medicines with user-set reminders, allergies shown everywhere they matter. |
| Documents | Private S3, presigned uploads to a quarantine area, magic-byte checks, PDF active-content rejection, EXIF stripping, ClamAV scan, ≤5-minute signed view links. |
| Summaries | Daily / weekly / monthly views with NO_DATA vs RECORDED and stated denominators. Pediatrician PDF (allergies on page 1, sources appendix). |
| Notifications | In-app inbox + Web Push with no health details in payloads. Quiet hours. Cron-driven. |
| Security | Postgres row-level security (FORCE) on every PHI table plus API authorization, append-only hash-chained audit log, CSP with nonces, HSTS, rate limits, step-up re-auth, idempotency, optimistic concurrency. |
| Privacy | Layered notice (draft), granular consents, export (PDF/JSON/CSV/zip), 30-day recoverable deletion then hard purge. Legal text requires counsel review. |

## Run locally

```bash
# Postgres 16 in Docker on localhost:5434, with the NON-superuser role "babyapp" (RLS must apply)
npm run db:up                             # databases babytracker + babytracker_test
npm install
npm run db:migrate && npm run reference:seed   # local settings come from .env.development
npm run dev                               # sign-in codes are printed in the terminal (console provider)
```

Optional:

- `npm run who:import` imports the WHO growth datasets.
- `REFERENCE_PREVIEW_MODE=true` shows gated reference data with **UNVERIFIED** banners. It is refused in production.

## Tests

```bash
# once: migrate the test database (the Docker container creates it)
DATABASE_URL=postgres://babyapp:babyapp@localhost:5434/babytracker_test sh -c 'npm run db:migrate && npm run reference:seed'
npm test          # 89 unit + integration tests against a real Postgres (RLS isolation, roles, milk math, gating, uploads, jobs)
npm run test:e2e  # Playwright mobile journey (needs a running server; see e2e/smoke.spec.ts)
npm run lint && npm run typecheck
```

## Deploy

See [`docs/DEPLOY.md`](docs/DEPLOY.md). It covers Vercel (Mumbai `bom1`), managed Postgres in Mumbai, S3 `ap-south-1`, the scanner service, cron and push keys.

## Project layout

```
db/migrations/         SQL schema, RLS policies, audit hash chain, rate limiter
reference/             medical_reference_data.json (the single source of medical values)
scripts/               migrate, reference seed/release, WHO import, VAPID keys
scanner/               ClamAV HTTP companion service (Docker / Fly.io)
src/server/            API router, auth, authz, engines, storage, notifications, PDF
src/app/               Next.js pages (35 screens) and route handlers
src/components, src/lib  UI kit (Cradle Calm), client API, offline queue, pure engines
tests/, e2e/           Vitest + Playwright
docs/                  Specification, deployment, clinical release process
```
