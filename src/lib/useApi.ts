"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api, ApiProblem } from "./api";

/** Minimal stale-while-revalidate cache (in memory only — health data is never persisted to browser storage). */
const cache = new Map<string, { data: unknown; at: number }>();
const subs = new Map<string, Set<() => void>>();
function emit(key: string) { subs.get(key)?.forEach((f) => f()); }
export function invalidate(prefix: string) {
  for (const k of [...cache.keys()]) if (k.startsWith(prefix)) { cache.delete(k); emit(k); }
  for (const k of subs.keys()) if (k.startsWith(prefix)) emit(k);
}

export function useApi<T = any>(path: string | null, opts: { refreshMs?: number } = {}) {
  const [error, setError] = useState<ApiProblem | null>(null);
  const [loading, setLoading] = useState(!!path && !cache.has(path));
  const [, force] = useState(0);
  const mounted = useRef(true);
  const load = useCallback(async () => {
    if (!path) return;
    setLoading(!cache.has(path));
    try {
      const d = await api<T>("GET", path);
      cache.set(path, { data: d, at: Date.now() });
      if (mounted.current) { setError(null); force((x) => x + 1); }
    } catch (e) {
      if (mounted.current) setError(e instanceof ApiProblem ? e : new ApiProblem({ status: 0, code: "ERROR", title: "Something went wrong" }));
    } finally { if (mounted.current) setLoading(false); }
  }, [path]);
  useEffect(() => {
    mounted.current = true;
    if (!path) return;
    const set = subs.get(path) ?? new Set();
    const fn = () => load();
    set.add(fn); subs.set(path, set);
    load();
    const t = opts.refreshMs ? setInterval(load, opts.refreshMs) : null;
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => { mounted.current = false; set.delete(fn); if (t) clearInterval(t); window.removeEventListener("focus", onFocus); };
  }, [path, load, opts.refreshMs]);
  const data = path ? (cache.get(path)?.data as T | undefined) : undefined;
  return { data, error, loading: loading && data === undefined, reload: load };
}

export function useOnline() {
  return useSyncExternalStore(
    (cb) => { window.addEventListener("online", cb); window.addEventListener("offline", cb); return () => { window.removeEventListener("online", cb); window.removeEventListener("offline", cb); }; },
    () => navigator.onLine,
    () => true,
  );
}
