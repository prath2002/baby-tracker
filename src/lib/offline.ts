"use client";
import { openDB, type IDBPDatabase } from "idb";

/**
 * Offline write queue (spec §32.8, T-OFF-01). Each queued write carries its baby_id in the path, captured when the
 * form was opened, plus an Idempotency-Key, so replays are exactly-once and never re-targeted to another baby.
 * Only writes are queued; health data is never cached for reads.
 */
type Item = { id?: number; method: string; path: string; body: unknown; idempotencyKey: string; createdAt: number; attempts: number; lastError?: string };
let dbp: Promise<IDBPDatabase> | null = null;
const db = () => (dbp ??= openDB("baby-health-offline", 1, { upgrade(d) { d.createObjectStore("queue", { keyPath: "id", autoIncrement: true }); } }));
const listeners = new Set<(n: number) => void>();

export async function enqueue(i: Omit<Item, "createdAt" | "attempts">) {
  await (await db()).add("queue", { ...i, createdAt: Date.now(), attempts: 0 });
  notify();
  registerSync();
}
export async function pendingCount() { try { return await (await db()).count("queue"); } catch { return 0; } }
export async function pendingItems(): Promise<Item[]> { try { return await (await db()).getAll("queue"); } catch { return []; } }
export function onQueueChange(fn: (n: number) => void) { listeners.add(fn); return () => listeners.delete(fn); }
async function notify() { const n = await pendingCount(); listeners.forEach((f) => f(n)); }

let flushing = false;
export async function flushQueue(): Promise<{ sent: number; failed: number }> {
  if (flushing || typeof navigator !== "undefined" && !navigator.onLine) return { sent: 0, failed: 0 };
  flushing = true;
  let sent = 0, failed = 0;
  try {
    const d = await db();
    const items: Item[] = await d.getAll("queue");
    items.sort((a, b) => a.createdAt - b.createdAt);
    for (const it of items) {
      try {
        const res = await fetch(`/api/v1${it.path}`, {
          method: it.method, credentials: "same-origin",
          headers: { "Content-Type": "application/json", "Idempotency-Key": it.idempotencyKey },
          body: JSON.stringify({ ...(it.body as object), force: true }),
        });
        if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 429)) {
          // 4xx other than auth/rate: permanent problem — drop but remember for the user
          if (!res.ok) { failed++; const p = await res.json().catch(() => ({})); rememberFailure(it, p?.detail ?? p?.title ?? `HTTP ${res.status}`); }
          else sent++;
          await d.delete("queue", it.id!);
        } else {
          await d.put("queue", { ...it, attempts: it.attempts + 1, lastError: `HTTP ${res.status}` });
          break;
        }
      } catch { break; }
    }
  } finally { flushing = false; notify(); }
  return { sent, failed };
}

function rememberFailure(it: Item, why: string) {
  try {
    const prev = JSON.parse(localStorage.getItem("bh_sync_failures") ?? "[]");
    prev.push({ path: it.path, why, at: Date.now() });
    localStorage.setItem("bh_sync_failures", JSON.stringify(prev.slice(-20)));
  } catch { /* storage may be unavailable */ }
}

function registerSync() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.ready.then((r) => (r as unknown as { sync?: { register(t: string): Promise<void> } }).sync?.register("bh-flush").catch(() => {})).catch(() => {});
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => { flushQueue(); });
  navigator.serviceWorker?.addEventListener?.("message", (e) => { if (e.data === "bh-flush") flushQueue(); });
}
