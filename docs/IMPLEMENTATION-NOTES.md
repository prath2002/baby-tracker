# Implementation notes: how this build maps to the specification

## Coverage

All 35 screens (§28/§33), all modules of roadmap phases 1–12 (§43), the normalised schema (§34), RLS (§32/§36), the reference engine (§19–20), age engine (§21), summaries (§22–24), timeline (§25), document vault (§26), prescriptions/medicines/allergies (§27–29), appointments (§30), notifications (§31), exports and share links (§35), audit (§36) and deletion (§36/§37).

## Deliberate deviations (security-equivalent or safer)

| Spec | This build | Why |
|---|---|---|
| JWT access token ≤ 15 min + refresh token (§35, §36) | Opaque, server-stored session token in an `HttpOnly; Secure; SameSite=Lax` cookie (`__Host-` prefix in production). It rotates daily with reuse detection, has a 14-day idle and 60-day absolute expiry, and can be revoked per device. Step-up OTP is required for sensitive actions within 5 minutes. | For a same-origin PWA, server sessions avoid exposing tokens to JavaScript and allow instant revocation. |
| API at `/v1/...` | Served at `/api/v1/...` (same contract as `docs/openapi.yaml`). | Next.js route convention. |
| Summary cache tables | Summaries are computed on read. | Always consistent with edits; add caching if load requires it. |
| Phone OTP via any provider | Email OTP (Resend) by default. SMS via Twilio is implemented; MSG91 is not yet. | Indian SMS needs DLT registration. |

## Not yet implemented / pending decisions (by design)

- **Clinical values:** all gated until reviewers clear them (`docs/CLINICAL-RELEASE.md`).
- **Growth velocity references:** pending the interval-matching rule (spec Q7). g/day change is shown instead.
- **Corrected age for preterm babies:** disabled pending pediatric review (Q5).
- **Clinician mode:** not built. Clinician-only rules (trophic feeding, WHO A.8) are never shown to parents.
- **Hindi and regional languages:** strings are centralised in components but not yet translated (they need reviewed medical translation, Q18).
- **ABDM / ABHA integration:** not included (Q16).
- **HEIC uploads:** accepted only if the server's image library can decode them. Otherwise the parent is asked to upload JPEG/PNG.
- **PDF fonts:** the bundled Work Sans is Latin-only. Names in Devanagari render as "?" in the PDF (the app itself is fine). Add a Noto Sans Devanagari TTF to `assets/fonts` to fix this.
- **Offline:** creating feeds, measurements and medicine doses works offline (exactly-once sync). Reading health data needs a connection, because health data is deliberately not cached on the device.
- **Scanner service (`scanner/`):** written and documented but not executed in the build environment. Test it with EICAR before go-live.
- **SMS/WhatsApp reminder delivery:** the consent is captured; outbound SMS/WhatsApp reminders are not yet sent (push + in-app only).

## Verification performed in the build environment

- `npm test`: 89 tests (unit + integration against PostgreSQL 16 with a NOBYPASSRLS role). They cover RLS isolation with the API layer bypassed, role matrix, wrong-baby move, duplicate/idempotency/version conflicts, breastfeeding-volume rule, the 410 ml example, reference gating (blocked → NOT_ESTABLISHED; cleared → "Clinical reference" without a per-baby target; conflicts), vaccine versioning (fIPV-3 from 2023-01-01, JE opt-in, no invented overdue), uploads (spoofed type, PDF JavaScript, EICAR, signed-URL TTL, document permission), summaries, PDF export single-use links, step-up, notification planning without health details, deletion purge, and a forbidden-copy lint.
- `npm run lint`, `npm run typecheck`, `npm run build`: clean.
- Playwright mobile journey (Pixel 7 profile) against a production build: onboarding → OTP sign-in → registration → two babies → explicit baby picker → breastfeed + 90 ml expressed → milk dashboard shows "90 ml measurable milk recorded" and no target → weight → growth/vaccines correctly gated → allergy banner → weekly summary → unified timeline. No console or CSP errors.
