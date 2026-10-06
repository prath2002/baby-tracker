"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Splash (screen 1): restores the session and routes in ≤ 1.5 s. */
export default function Splash() {
  const router = useRouter();
  useEffect(() => {
    let done = false;
    const timeout = setTimeout(() => { if (!done) router.replace("/welcome"); }, 4000);
    fetch("/api/v1/me", { credentials: "same-origin" }).then(async (r) => {
      done = true;
      if (r.status === 401) {
        let seen = false;
        try { seen = localStorage.getItem("bh_onboarded") === "1"; } catch {}
        router.replace(seen ? "/login" : "/welcome");
      } else if (r.ok) {
        const me = await r.json();
        router.replace(me.registration_complete ? "/home" : "/register");
      } else router.replace("/home");
    }).catch(() => router.replace("/home"));
    return () => clearTimeout(timeout);
  }, [router]);
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4" aria-busy="true" aria-label="Loading Baby Health">
      <Logo size={96} />
      <p className="font-display text-3xl font-extrabold">Baby Health</p>
      <p className="text-ink-2">record gently · invent nothing</p>
    </main>
  );
}

function Logo({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden>
      <circle cx="50" cy="50" r="48" fill="var(--sage-soft)" />
      <circle cx="44" cy="50" r="24" fill="var(--apricot)" />
      <circle cx="54" cy="44" r="22" fill="var(--sage-soft)" />
      <circle cx="50" cy="50" r="3" fill="var(--ink)" />
    </svg>
  );
}
