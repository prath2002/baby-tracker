# Deploying Baby Health (Vercel + managed Postgres, India region)

These steps take about 45 minutes the first time. Everything is created under **your** accounts. Keep all resources in Mumbai (`ap-south-1` / `bom1`) unless counsel advises otherwise.

> **Before real families use it:** complete the clinical release (`docs/CLINICAL-RELEASE.md`), have the privacy notice reviewed by counsel, and run a security review. Until then, deploy to a *preview/staging* environment.

## 1. Postgres (Neon or Supabase, Mumbai)

**Neon:** create a project in *AWS Asia Pacific (Mumbai)*. **Supabase:** create a project in *South Asia (Mumbai)*.

Row-level security only protects you if the app does **not** connect as a superuser or a `BYPASSRLS` role. Create a dedicated role and database in the SQL editor:

```sql
CREATE ROLE babyapp LOGIN PASSWORD '<long-random-password>' NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
CREATE DATABASE babytracker OWNER babyapp;
-- connect to babytracker, then:
CREATE EXTENSION IF NOT EXISTS citext;   -- if your provider requires an admin to create it
```

Connection strings (both use `babyapp`):

- `DATABASE_URL`: the **pooled** connection (Neon "pooled" host; Supabase "transaction pooler", port 6543), with `sslmode=require`.
- `MIGRATION_DATABASE_URL`: the **direct** (non-pooled) connection.

The app checks its own role at startup. In production it **refuses to serve** if the role bypasses RLS (`/api/v1/health` reports `rls_enforced`).

## 2. Private document storage (AWS S3, ap-south-1)

1. Create a bucket, e.g. `baby-health-docs-prod`, in **ap-south-1**. Keep **Block all public access ON**. Turn on default encryption (SSE-S3 or SSE-KMS) and versioning.
2. Add a lifecycle rule: expire objects under `quarantine/` after 1 day and under `exports/` after 2 days.
3. CORS, so browsers can upload directly with presigned URLs:

```json
[{ "AllowedOrigins": ["https://your-domain.example"], "AllowedMethods": ["PUT", "GET"], "AllowedHeaders": ["content-type", "x-amz-server-side-encryption"], "MaxAgeSeconds": 300 }]
```

4. Create an IAM user (or role) limited to that bucket:

```json
{ "Version": "2012-10-17", "Statement": [{ "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], "Resource": "arn:aws:s3:::baby-health-docs-prod/*" },
  { "Effect": "Deny", "Action": "s3:*", "Resource": ["arn:aws:s3:::baby-health-docs-prod", "arn:aws:s3:::baby-health-docs-prod/*"], "Condition": { "Bool": { "aws:SecureTransport": "false" } } }] }
```

Set `S3_BUCKET`, `S3_REGION=ap-south-1`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`.

## 3. Malware scanner (required for documents)

Uploads stay locked ("scan pending") until a scanner says they're clean. Deploy `scanner/` (ClamAV plus a token-protected HTTPS wrapper):

```bash
cd scanner
fly launch --copy-config --no-deploy        # uses fly.toml, region bom (Mumbai)
fly secrets set SCANNER_TOKEN=$(openssl rand -hex 32)
fly deploy
```

Set `SCANNER=http`, `SCANNER_URL=https://<app>.fly.dev`, and `SCANNER_TOKEN` (the same token) in Vercel. Any host that runs Docker over HTTPS works.

*The scanner container was written for this release but not run end-to-end in the build environment. Test it with an EICAR file before go-live.*

## 4. Email sign-in codes (Resend)

Create a Resend account, verify your sending domain, then set `EMAIL_PROVIDER=resend`, `RESEND_API_KEY` and `EMAIL_FROM`. For SMS codes, set `SMS_PROVIDER=twilio` and the `TWILIO_*` variables. For Indian SMS, DLT template registration applies.

## 5. Web push

```bash
npm run vapid:generate   # copy the two lines into Vercel env vars
```

Set `VAPID_SUBJECT=mailto:you@your-domain.example`. Push works on Android/desktop browsers, and on iPhone once the app is added to the Home Screen (iOS 16.4+).

## 6. Vercel

1. Push this folder to a private GitHub repo and import it in Vercel. The framework is detected as Next.js, and `vercel.json` pins the region to **bom1 (Mumbai)**.
2. Add the environment variables from `.env.example` to **Production** and **Preview**:
   - `APP_SECRET` and `CRON_SECRET`: `openssl rand -hex 32` each.
   - `APP_URL`: your production URL.
   - Leave `REFERENCE_PREVIEW_MODE=false` in Production. You may set it `true` for Preview to review gated content with UNVERIFIED banners.
3. Deploy. The build command runs `db:migrate` → `reference:seed` → `next build`. Migrations are append-only and checksum-protected. Reference seeding keeps reviewer clearances unless the underlying data changed.
4. **Cron:** `vercel.json` schedules `/api/cron/dispatch` every 5 minutes (reminders) and `/api/cron/daily` once a day (purge/housekeeping). Every-5-minute crons need a Vercel **Pro** plan. On Hobby, keep the daily cron and trigger `/api/cron/dispatch` from an external scheduler (e.g. a GitHub Actions `schedule` or cron-job.org) with `Authorization: Bearer $CRON_SECRET`.
5. Add your domain. HSTS is sent automatically.

## 7. After the first deploy

```bash
# from your machine, with MIGRATION_DATABASE_URL pointing at production
npm run who:import                          # WHO growth datasets (validated, gated HUMAN_RECHECK_REQUIRED)
npm run reference:release -- --list         # see what is gated
```

Then follow `docs/CLINICAL-RELEASE.md`.

## Production checklist

- [ ] `GET /api/v1/health` → `{"ok":true,"rls_enforced":true}`
- [ ] Sign in with email OTP; register; add a baby; log a feed; open the PDF.
- [ ] Upload a PDF → "Ready". Upload the EICAR test file → "Blocked".
- [ ] Push test from Settings.
- [ ] Database backups/PITR enabled on your Postgres plan (aim for ≥ 7 days; 35 recommended). Do a restore drill.
- [ ] S3 versioning + lifecycle on; public access blocked.
- [ ] Privacy notice, consent text and grievance contact reviewed by counsel (`PRIVACY_NOTICE_VERSION` bumped when the text changes; users re-consent).
- [ ] Clinical release completed for everything you intend to show.
- [ ] Penetration test / security review (spec §36, §43 Phase 12).
