import "server-only";
import { createHash } from "node:crypto";
import { z, ZodError, type ZodType } from "zod";
import { uuidv7 } from "@/lib/ids";
import { pool, withUser, withSystem, type Q } from "./db";
import { getSessionFromRequest, type SessionInfo } from "./auth/session";
import { env } from "./env";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public title: string,
    public detail?: string,
    public errors?: { field: string; code: string; message: string }[],
    public headers?: Record<string, string>,
  ) {
    super(title);
  }
}
export const notFound = (what = "Resource") => new ApiError(404, "NOT_FOUND", `${what} not found`);
export const forbidden = (detail?: string) => new ApiError(403, "FORBIDDEN_ROLE", "Your role does not permit this action", detail);
export const badRequest = (detail: string, errors?: ApiError["errors"]) => new ApiError(400, "VALIDATION_FAILED", "Validation failed", detail, errors);
export const ruleViolation = (code: string, detail: string) => new ApiError(422, code, "Business rule violated", detail);
export const conflict = (code: string, detail: string, extra?: Record<string, unknown>) => {
  const e = new ApiError(409, code, "Conflict", detail);
  (e as ApiError & { extra?: unknown }).extra = extra;
  return e;
};

const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

export function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...SECURITY_HEADERS, ...headers } });
}

export function problem(e: unknown, requestId: string) {
  if (e instanceof ApiError) {
    return new Response(
      JSON.stringify({
        type: `about:blank#${e.code}`, title: e.title, status: e.status, code: e.code, detail: e.detail, errors: e.errors,
        instance: requestId, ...((e as ApiError & { extra?: object }).extra ?? {}),
      }),
      { status: e.status, headers: { "Content-Type": "application/problem+json", ...SECURITY_HEADERS, ...(e.headers ?? {}) } },
    );
  }
  if (e instanceof ZodError) {
    return problem(badRequest("Request body is invalid", e.issues.map((i) => ({ field: i.path.join("."), code: i.code, message: i.message }))), requestId);
  }
  const pg = e as { code?: string; constraint?: string; message?: string };
  if (pg?.code === "23514" || pg?.code === "23503" || pg?.code === "23505" || pg?.code === "22P02" || pg?.code === "22007" || pg?.code === "22008") {
    const map: Record<string, [number, string]> = {
      "23514": [422, "CONSTRAINT_VIOLATION"], "23503": [422, "REFERENCE_INVALID"], "23505": [409, "CONFLICT"],
      "22P02": [400, "VALIDATION_FAILED"], "22007": [400, "VALIDATION_FAILED"], "22008": [400, "VALIDATION_FAILED"],
    };
    const [status, code] = map[pg.code];
    return problem(new ApiError(status, code, "Request rejected by data rules", pg.constraint ? `Constraint: ${pg.constraint}` : undefined), requestId);
  }
  if (pg?.code === "42501") return problem(new ApiError(404, "NOT_FOUND", "Resource not found"), requestId); // RLS denial => 404
  console.error(`[${requestId}]`, e);
  return problem(new ApiError(500, "INTERNAL", "Something went wrong", `Support code: ${requestId}`), requestId);
}

export type Ctx = {
  req: Request;
  url: URL;
  params: Record<string, string>;
  query: URLSearchParams;
  requestId: string;
  ip: string | null;
  session: SessionInfo | null;
  q: Q;
  body<T>(schema: ZodType<T>): Promise<T>;
  rawBody(): Promise<unknown>;
  setCookies: string[];
};

export type Handler = (ctx: Ctx) => Promise<Response | unknown>;
type RouteOpts = { auth?: "user" | "public" | "registered"; rateLimit?: { bucket: string; perMinute: number }; idempotent?: boolean };
type Route = { method: string; re: RegExp; keys: string[]; handler: Handler; opts: RouteOpts; pattern: string };

const MAX_BODY = 256 * 1024;

export class Router {
  routes: Route[] = [];
  add(method: string, pattern: string, handler: Handler, opts: RouteOpts = {}) {
    const keys: string[] = [];
    const re = new RegExp("^" + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "/?$");
    this.routes.push({ method, re, keys, handler, opts: { auth: "registered", ...opts }, pattern });
    return this;
  }
  get = (p: string, h: Handler, o?: RouteOpts) => this.add("GET", p, h, o);
  post = (p: string, h: Handler, o?: RouteOpts) => this.add("POST", p, h, o);
  put = (p: string, h: Handler, o?: RouteOpts) => this.add("PUT", p, h, o);
  patch = (p: string, h: Handler, o?: RouteOpts) => this.add("PATCH", p, h, o);
  delete = (p: string, h: Handler, o?: RouteOpts) => this.add("DELETE", p, h, o);

  async handle(req: Request, basePath: string): Promise<Response> {
    const requestId = uuidv7();
    try {
      const url = new URL(req.url);
      const path = url.pathname.slice(basePath.length) || "/";
      let route: Route | undefined, m: RegExpMatchArray | null = null, methodMismatch = false;
      for (const r of this.routes) {
        const mm = path.match(r.re);
        if (!mm) continue;
        if (r.method !== req.method) { methodMismatch = true; continue; }
        route = r; m = mm; break;
      }
      if (!route || !m) throw methodMismatch ? new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed") : notFound("Endpoint");
      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m![i + 1])));

      if (req.method !== "GET" && req.method !== "HEAD") checkOrigin(req, url);
      const ip = clientIp(req);
      if (route.opts.rateLimit) await rateLimit(`${route.opts.rateLimit.bucket}:ip:${ip}`, 60, route.opts.rateLimit.perMinute);

      const setCookies: string[] = [];
      const session = route.opts.auth === "public" ? await getSessionFromRequest(req, setCookies).catch(() => null) : await getSessionFromRequest(req, setCookies);
      if (route.opts.auth !== "public" && !session) throw new ApiError(401, "UNAUTHENTICATED", "Please sign in");
      if (route.opts.auth === "registered" && session && !session.registrationComplete)
        throw new ApiError(403, "REGISTRATION_INCOMPLETE", "Please complete registration first");
      if (session) await rateLimit(`api:user:${session.userId}`, 60, 600);

      let bodyCache: unknown = undefined, bodyText: string | null = null;
      const readText = async () => {
        if (bodyText !== null) return bodyText;
        const len = Number(req.headers.get("content-length") ?? 0);
        if (len > MAX_BODY) throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Request body too large");
        bodyText = await req.text();
        if (bodyText.length > MAX_BODY) throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Request body too large");
        return bodyText;
      };
      const rawBody = async () => {
        if (bodyCache !== undefined) return bodyCache;
        const t = await readText();
        if (!t) return (bodyCache = {});
        try { bodyCache = JSON.parse(t); } catch { throw badRequest("Body must be valid JSON"); }
        return bodyCache;
      };

      const run = async (q: Q) => {
        const ctx: Ctx = {
          req, url, params, query: url.searchParams, requestId, ip, session, q, setCookies,
          rawBody, body: async (schema) => schema.parse(await rawBody()),
        };
        // Idempotency for creates
        const idemKey = req.headers.get("idempotency-key");
        if (req.method === "POST" && session && idemKey) {
          if (idemKey.length < 8 || idemKey.length > 128) throw badRequest("Idempotency-Key must be 8-128 characters");
          const hash = createHash("sha256").update(req.method + path + (await readText())).digest("hex");
          const prev = await q.one<{ request_hash: string; status_code: number; response: unknown }>(
            "SELECT request_hash, status_code, response FROM idempotency_key WHERE user_id = $1 AND key = $2", [session.userId, idemKey]);
          if (prev) {
            if (prev.request_hash !== hash) throw ruleViolation("IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was used for a different request");
            return json(prev.response, prev.status_code, { "Idempotent-Replay": "true" });
          }
          const out = await route!.handler(ctx);
          const res = out instanceof Response ? out : json(out, req.method === "POST" ? 201 : 200);
          if (res.status < 300 && (res.headers.get("content-type") ?? "").includes("json")) {
            const clone = await res.clone().json();
            await q("INSERT INTO idempotency_key(key, user_id, request_hash, status_code, response) VALUES ($1,$2,$3,$4,$5)", [idemKey, session.userId, hash, res.status, clone]);
          }
          return res;
        }
        const out = await route!.handler(ctx);
        if (out instanceof Response) return out;
        if (out === undefined || out === null) return new Response(null, { status: 204, headers: SECURITY_HEADERS });
        return json(out, req.method === "POST" ? 201 : 200);
      };

      const res = session ? await withUser(session.userId, run) : await withSystem(run);
      for (const c of setCookies) res.headers.append("Set-Cookie", c);
      res.headers.set("X-Request-Id", requestId);
      return res;
    } catch (e) {
      return problem(e, requestId);
    }
  }
}

export function clientIp(req: Request): string | null {
  const xf = req.headers.get("x-forwarded-for");
  if (xf) return xf.split(",")[0].trim();
  return req.headers.get("x-real-ip");
}

/** CSRF defence for cookie-authenticated state-changing requests: Origin (or Referer) must match our host. */
function checkOrigin(req: Request, url: URL) {
  const origin = req.headers.get("origin") ?? (req.headers.get("referer") ? new URL(req.headers.get("referer")!).origin : null);
  if (!origin) return; // non-browser clients (no ambient cookies are sent cross-site without Origin in modern browsers)
  const allowed = new Set([url.origin, new URL(env.APP_URL).origin]);
  if (!allowed.has(origin)) throw new ApiError(403, "CSRF_ORIGIN_MISMATCH", "Cross-site request blocked");
}

export async function rateLimit(bucket: string, windowSeconds: number, limit: number) {
  const r = await pool.query<{ ok: boolean }>("SELECT rate_hit($1, $2, $3) AS ok", [bucket, windowSeconds, limit]);
  if (!r.rows[0].ok) throw new ApiError(429, "RATE_LIMITED", "Too many requests", "Please wait and try again.", undefined, { "Retry-After": String(windowSeconds) });
}

// ---------- validation helpers ----------
export const zUuid = z.string().uuid();
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");
export const zDateTime = z.string().datetime({ offset: true });
export const zTz = z.string().min(1).max(64);
export const zText = (max = 2000) => z.string().trim().max(max);
export const zOptText = (max = 2000) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));

export function pageParams(query: URLSearchParams) {
  const limit = Math.min(100, Math.max(1, Number(query.get("limit") ?? 50) || 50));
  const cursor = query.get("cursor");
  return { limit, cursor };
}
export function requireIfMatch(ctx: Ctx): number {
  const v = ctx.req.headers.get("if-match");
  if (!v) throw new ApiError(428, "PRECONDITION_REQUIRED", "If-Match header with the record version is required");
  const n = Number(v.replace(/"/g, ""));
  if (!Number.isInteger(n)) throw badRequest("If-Match must be the record version number");
  return n;
}
