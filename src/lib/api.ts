"use client";
import { uuidv7 } from "./ids";
import { enqueue } from "./offline";

export type Problem = { status: number; code: string; title: string; detail?: string; errors?: { field: string; message: string }[]; [k: string]: unknown };
export class ApiProblem extends Error {
  constructor(public problem: Problem) { super(problem.detail ?? problem.title); }
  get code() { return this.problem.code; }
  get status() { return this.problem.status; }
}

type Opts = { body?: unknown; ifMatch?: number; idempotent?: boolean; offline?: boolean; signal?: AbortSignal };

/** Same-origin JSON client. Cookies carry the session (httpOnly). */
export async function api<T = any>(method: string, path: string, opts: Opts = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.ifMatch !== undefined) headers["If-Match"] = String(opts.ifMatch);
  const idem = method === "POST" && opts.idempotent !== false ? uuidv7() : null;
  if (idem) headers["Idempotency-Key"] = idem;
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), credentials: "same-origin", signal: opts.signal });
  } catch (e) {
    if (opts.offline && method !== "GET") {
      await enqueue({ method, path, body: opts.body, idempotencyKey: idem ?? uuidv7() });
      throw new ApiProblem({ status: 0, code: "QUEUED_OFFLINE", title: "Saved offline", detail: "You're offline. This will sync automatically." });
    }
    throw new ApiProblem({ status: 0, code: "NETWORK", title: "No connection", detail: "Check your internet connection and try again." });
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    if (res.status === 401 && data?.code === "UNAUTHENTICATED" && typeof window !== "undefined" && !location.pathname.startsWith("/login")) {
      location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    }
    if (res.status === 403 && data?.code === "REGISTRATION_INCOMPLETE" && typeof window !== "undefined" && !location.pathname.startsWith("/register")) {
      location.href = "/register";
    }
    throw new ApiProblem({ status: res.status, code: data?.code ?? "ERROR", title: data?.title ?? "Something went wrong", ...data });
  }
  return data as T;
}

export const errorText = (e: unknown) => (e instanceof ApiProblem ? (e.problem.detail ? `${e.problem.title}. ${e.problem.detail}` : e.problem.title) : "Something went wrong. Please try again.");
export const fieldErrors = (e: unknown): Record<string, string> => {
  if (!(e instanceof ApiProblem) || !e.problem.errors) return {};
  return Object.fromEntries(e.problem.errors.map((x) => [x.field, x.message]));
};
