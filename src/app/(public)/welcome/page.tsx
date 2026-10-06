"use client";
import { useState } from "react";
import Link from "next/link";
import { Button, LinkButton } from "@/components/ui";

const CARDS = [
  { t: "Log calmly", b: "Feeds, weights, vaccines and visits in a few taps — even offline at 3 a.m.", i: "🌙" },
  { t: "Every baby, separately", b: "Twins and siblings each get their own colour, photo and record. We make it hard to log for the wrong baby.", i: "👶" },
  { t: "Sources you can see", b: "Reference information shows where it comes from. We record; your pediatrician advises.", i: "📖" },
];

/** Onboarding (screen 2). */
export default function Welcome() {
  const [i, setI] = useState(0);
  const c = CARDS[i];
  const finish = () => { try { localStorage.setItem("bh_onboarded", "1"); } catch {} };
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-between px-6 py-10">
      <div className="flex justify-end"><Link href="/login" onClick={finish} className="min-h-12 px-3 py-3 font-semibold text-sage">Skip</Link></div>
      <section aria-live="polite" className="flex flex-col items-center gap-4 text-center">
        <span aria-hidden className="flex h-28 w-28 items-center justify-center rounded-full bg-sage-soft text-5xl">{c.i}</span>
        <h1 className="text-3xl font-extrabold">{c.t}</h1>
        <p className="text-lg text-ink-2">{c.b}</p>
        <div className="flex gap-2" aria-label={`Step ${i + 1} of ${CARDS.length}`}>{CARDS.map((_, j) => <span key={j} className={`h-2 w-6 rounded-full ${j === i ? "bg-sage" : "bg-line"}`} />)}</div>
      </section>
      <div className="flex flex-col gap-3">
        {i < CARDS.length - 1 ? <Button block onClick={() => setI(i + 1)}>Next</Button> : <LinkButton block href="/login">Get started</LinkButton>}
        <Link href="/login" onClick={finish} className="min-h-12 py-3 text-center font-semibold text-sage">I already have an account</Link>
      </div>
    </main>
  );
}
