import type { ConnectionOptions } from "node:tls";

/**
 * TLS settings for Postgres. Hosted providers get full certificate verification. Providers that sign with their own
 * root CA (e.g. Supabase) need that CA in DATABASE_CA_CERT (PEM; "\n" escapes allowed) — verification is never disabled.
 */
export function pgSsl(url: string): ConnectionOptions | undefined {
  if (!/sslmode=require|neon\.tech|supabase\.co|supabase\.com|amazonaws\.com/.test(url)) return undefined;
  const ca = process.env.DATABASE_CA_CERT?.replace(/\\n/g, "\n").trim();
  return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
}
