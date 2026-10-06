"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { cx, ToastProvider } from "./ui";
import { useApi, useOnline } from "@/lib/useApi";
import { flushQueue, onQueueChange, pendingCount } from "@/lib/offline";
import { BabyPicker } from "./baby";

export function ServiceWorker() {
  useEffect(() => {
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
    flushQueue();
  }, []);
  return null;
}

function OfflineBanner() {
  const online = useOnline();
  const [pending, setPending] = useState(0);
  useEffect(() => { pendingCount().then(setPending); const off = onQueueChange(setPending); return () => { off(); }; }, []);
  if (online && !pending) return null;
  return (
    <div role="status" className="sticky top-0 z-30 bg-caution-bg px-4 py-2 text-center text-sm font-semibold text-caution">
      {!online ? "You're offline. Feeds, weights and doses you log will sync automatically." : `${pending} item${pending === 1 ? "" : "s"} waiting to sync…`}
      {online && pending > 0 && <button className="ml-2 underline" onClick={() => flushQueue()}>Sync now</button>}
    </div>
  );
}

const I = (d: string) => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d} /></svg>;
const NAV: [string, string, React.ReactNode][] = [
  ["/home", "Home", I("M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z")],
  ["/timeline", "Timeline", I("M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01")],
  ["__log", "Log", "+"],
  ["/notifications", "Alerts", I("M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0")],
  ["/settings", "More", I("M5 12h.01M12 12h.01M19 12h.01")],
];

function BottomNav() {
  const path = usePathname();
  const router = useRouter();
  const [pick, setPick] = useState(false);
  const { data } = useApi<{ unread: number }>("/notifications", { refreshMs: 120_000 });
  return (
    <>
      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 backdrop-blur safe-bottom">
        <ul className="mx-auto flex max-w-xl items-stretch justify-around">
          {NAV.map(([href, label, icon]) => href === "__log" ? (
            <li key={href}><button onClick={() => setPick(true)} aria-label="Log for a baby" className="-mt-5 flex h-16 w-16 flex-col items-center justify-center rounded-full bg-sage text-3xl font-bold text-white shadow-lg dark:text-[#10201A]">{icon}</button></li>
          ) : (
            <li key={href} className="flex-1">
              <Link href={href} aria-current={path.startsWith(href) ? "page" : undefined}
                className={cx("relative flex min-h-16 flex-col items-center justify-center text-xs font-semibold", path.startsWith(href) ? "text-sage" : "text-ink-2")}>
                {icon}{label}
                {href === "/notifications" && (data?.unread ?? 0) > 0 && <span className="absolute right-[28%] top-2 rounded-full bg-allergy px-1.5 text-[10px] text-white">{data!.unread}<span className="sr-only"> unread</span></span>}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <QuickLog open={pick} onClose={() => setPick(false)} onGo={(href) => { setPick(false); router.push(href); }} />
    </>
  );
}

/** Quick actions always require an explicit baby choice when there is more than one baby (spec §26, §32.1). */
function QuickLog({ open, onClose, onGo }: { open: boolean; onClose: () => void; onGo: (href: string) => void }) {
  const [action, setAction] = useState<string | null>(null);
  const { data } = useApi<{ data: { id: string }[] }>(open ? "/babies" : null);
  const ACTIONS: [string, string][] = [["feedings/new", "Add feeding"], ["weight?add=1", "Add weight"], ["vaccinations/new", "Add vaccine"], ["appointments/new", "Add appointment"], ["documents/upload", "Upload report"]];
  useEffect(() => { if (!open) setAction(null); }, [open]);
  const only = data?.data.length === 1 ? data.data[0].id : null;
  useEffect(() => { if (action && only) onGo(`/babies/${only}/${action}`); }, [action, only, onGo]);
  if (!open) return null;
  if (action) {
    if (only || !data) return null;
    if (!data.data.length) return <div role="dialog" className="fixed inset-0 z-50 flex items-end bg-black/40" onClick={onClose}><div className="w-full rounded-t-[28px] bg-surface p-5"><p className="mb-3">Add a baby first.</p><Link href="/babies/new" className="font-bold text-sage underline">Add baby</Link></div></div>;
    return <BabyPicker open onClose={onClose} onPick={(b) => onGo(`/babies/${b.id}/${action}`)} />;
  }
  return (
    <div role="dialog" aria-modal="true" aria-label="Quick actions" className="fixed inset-0 z-50 flex items-end bg-black/40" onClick={onClose}>
      <div className="w-full rounded-t-[28px] bg-surface p-5 safe-bottom" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-3 text-lg font-bold">What would you like to log?</h2>
        <ul className="grid grid-cols-2 gap-2">
          {ACTIONS.map(([a, l]) => <li key={a}><button onClick={() => setAction(a)} className="flex min-h-16 w-full items-center justify-center rounded-2xl bg-sunken px-3 font-semibold">{l}</button></li>)}
        </ul>
        <button onClick={onClose} className="mt-3 min-h-12 w-full rounded-full font-semibold text-ink-2">Cancel</button>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { error } = useApi("/me");
  return (
    <ToastProvider>
      <OfflineBanner />
      <ServiceWorker />
      <main id="main" className="mx-auto w-full max-w-xl px-4 pb-32 pt-4">{error && error.status === 0 ? null : children}</main>
      <BottomNav />
    </ToastProvider>
  );
}
