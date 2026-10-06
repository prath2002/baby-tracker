import "server-only";

/** Centralised, validated environment. Fails fast in production for unsafe configurations. */
const BUILD_PHASE = process.env.NEXT_PHASE === "phase-production-build";
function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback ?? (BUILD_PHASE ? `__build_placeholder_${name}__` : undefined);
  if (v === undefined || v === "") throw new Error(`Missing required environment variable ${name}`);
  return v;
}
function bool(name: string, def = false) {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

const NODE_ENV = process.env.NODE_ENV ?? "development";
/** VERCEL_ENV is 'production' | 'preview' | 'development' on Vercel; APP_ENV overrides for other hosts. */
export const APP_ENV = process.env.APP_ENV ?? process.env.VERCEL_ENV ?? (NODE_ENV === "production" ? "production" : "development");
export const IS_PROD = APP_ENV === "production";
export const IS_TEST = NODE_ENV === "test" || process.env.VITEST === "true";

export const env = {
  DATABASE_URL: req("DATABASE_URL", IS_TEST ? "postgres://babyapp:babyapp@localhost:5434/babytracker_test" : undefined),
  APP_URL: process.env.APP_URL ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000"),
  /** 32+ byte secret for HMAC (OTP hashing, local signed URLs, share tokens). */
  APP_SECRET: req("APP_SECRET", IS_PROD ? undefined : "dev-only-secret-change-me-dev-only-secret-change-me"),
  CRON_SECRET: process.env.CRON_SECRET ?? (IS_PROD ? "" : "dev-cron-secret"),

  // Auth delivery
  EMAIL_PROVIDER: (process.env.EMAIL_PROVIDER ?? (IS_PROD ? "resend" : "console")) as "resend" | "console",
  RESEND_API_KEY: process.env.RESEND_API_KEY ?? "",
  EMAIL_FROM: process.env.EMAIL_FROM ?? "Baby Health <no-reply@example.in>",
  SMS_PROVIDER: (process.env.SMS_PROVIDER ?? "none") as "none" | "twilio" | "msg91" | "console",
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID ?? "",
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN ?? "",
  TWILIO_FROM: process.env.TWILIO_FROM ?? "",

  // Storage
  STORAGE_DRIVER: (process.env.STORAGE_DRIVER ?? (IS_PROD ? "s3" : "local")) as "s3" | "local",
  S3_REGION: process.env.S3_REGION ?? "ap-south-1",
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? "",
  S3_BUCKET: process.env.S3_BUCKET ?? "",
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID ?? "",
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY ?? "",
  S3_FORCE_PATH_STYLE: bool("S3_FORCE_PATH_STYLE"),
  LOCAL_STORAGE_DIR: process.env.LOCAL_STORAGE_DIR ?? ".data/storage",

  // Malware scanning
  SCANNER: (process.env.SCANNER ?? (IS_PROD ? "http" : "dev-allow")) as "clamd" | "http" | "dev-allow" | "none",
  SCANNER_URL: process.env.SCANNER_URL ?? "",
  SCANNER_TOKEN: process.env.SCANNER_TOKEN ?? "",
  CLAMD_HOST: process.env.CLAMD_HOST ?? "",
  CLAMD_PORT: Number(process.env.CLAMD_PORT ?? 3310),

  // Web push
  VAPID_PUBLIC_KEY: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "",
  VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY ?? "",
  VAPID_SUBJECT: process.env.VAPID_SUBJECT ?? "mailto:privacy@example.in",

  // Chat assistant (OpenRouter). Disabled when no key is set.
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? "",
  OPENROUTER_MODEL: process.env.OPENROUTER_MODEL ?? "anthropic/claude-haiku-4.5",
  OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",

  /** Shows non-CLEARED reference data with an UNVERIFIED banner. Refused in production. */
  REFERENCE_PREVIEW_MODE: bool("REFERENCE_PREVIEW_MODE"),
  PRIVACY_NOTICE_VERSION: process.env.PRIVACY_NOTICE_VERSION ?? "2026-10-draft-1",
  GRIEVANCE_CONTACT: process.env.GRIEVANCE_CONTACT ?? "grievance@example.in",
};

export function assertSafeConfig() {
  const problems: string[] = [];
  if (IS_PROD) {
    if (env.REFERENCE_PREVIEW_MODE) problems.push("REFERENCE_PREVIEW_MODE must be off in production");
    if (env.SCANNER === "dev-allow") problems.push("SCANNER=dev-allow is not permitted in production");
    if (env.STORAGE_DRIVER === "local") problems.push("STORAGE_DRIVER=local is not permitted in production");
    if (env.EMAIL_PROVIDER === "console") problems.push("EMAIL_PROVIDER=console is not permitted in production");
    if (env.APP_SECRET.length < 32) problems.push("APP_SECRET must be at least 32 characters");
    if (!env.CRON_SECRET) problems.push("CRON_SECRET is required in production");
    if (env.SCANNER === "http" && (!env.SCANNER_URL.startsWith("https://") || env.SCANNER_TOKEN.length < 24)) problems.push("SCANNER=http needs an https SCANNER_URL and a SCANNER_TOKEN of 24+ characters");
    if (env.STORAGE_DRIVER === "s3" && !env.S3_BUCKET) problems.push("S3_BUCKET is required");
  }
  if (problems.length) throw new Error("Unsafe configuration: " + problems.join("; "));
}

/** Effective preview flag — never true in production even if misconfigured. */
export const referencePreview = () => env.REFERENCE_PREVIEW_MODE && !IS_PROD;
