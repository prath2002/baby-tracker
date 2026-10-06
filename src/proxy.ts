import { NextResponse, type NextRequest } from "next/server";

/** Security headers + per-request CSP nonce (spec §36). Session check happens in the API; pages redirect client-side on 401. */
function storageOrigins() {
  const out: string[] = [];
  if (process.env.S3_ENDPOINT) { try { out.push(new URL(process.env.S3_ENDPOINT).origin); } catch { /* ignore */ } }
  if (process.env.S3_BUCKET) out.push(`https://${process.env.S3_BUCKET}.s3.${process.env.S3_REGION ?? "ap-south-1"}.amazonaws.com`, `https://s3.${process.env.S3_REGION ?? "ap-south-1"}.amazonaws.com`);
  return out.join(" ");
}

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const dev = process.env.NODE_ENV === "development";
  const st = storageOrigins();
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' blob: data: ${st}`,
    "font-src 'self' data:",
    `connect-src 'self' ${st}`,
    `frame-src 'self' ${st}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    dev ? "" : "upgrade-insecure-requests",
  ].filter(Boolean).join("; ");
  const reqHeaders = new Headers(request.headers);
  reqHeaders.set("x-nonce", nonce);
  reqHeaders.set("Content-Security-Policy", csp);
  const res = NextResponse.next({ request: { headers: reqHeaders } });
  res.headers.set("Content-Security-Policy", csp);
  return res;
}

export const config = {
  matcher: [{ source: "/((?!api|_next/static|_next/image|favicon.ico|sw.js|icons).*)", missing: [{ type: "header", key: "next-router-prefetch" }, { type: "header", key: "purpose", value: "prefetch" }] }],
};
