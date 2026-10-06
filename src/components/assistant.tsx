"use client";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiProblem, errorText } from "@/lib/api";
import { invalidate, useApi } from "@/lib/useApi";
import { cx } from "./ui";
import { BabyChip, type Baby } from "./baby";

type Step = { method: "POST"; path: string; body: Record<string, unknown> };
type Proposal = { id: string; kind: string; baby_id: string | null; title: string; details: string[]; steps: Step[]; blocked?: string; offline_ok: boolean };
type ChatResponse = { reply: string; proposals: Proposal[]; ask: { question: string; options: string[] } | null; transcript: string };
type Msg = { role: "user" | "assistant"; text: string; transcript?: string; proposals?: Proposal[]; options?: string[] };
type CardState = { status: "pending" | "saving" | "saved" | "queued" | "confirm" | "error" | "dismissed"; message?: string; done: { id?: string }[] };

const OPEN_EVENT = "assistant:open";
/** Opens the chat from anywhere (e.g. the quick-log sheet). */
export const openAssistant = () => window.dispatchEvent(new Event(OPEN_EVENT));

const CONFIRMABLE = (e: ApiProblem) => e.code === "CONFIRMATION_REQUIRED" || e.code.includes("DUPLICATE");

type SpeechRec = { lang: string; interimResults: boolean; onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void; onend: () => void; onerror: () => void; start: () => void; stop: () => void };
function speechRecognition(): (new () => SpeechRec) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function Assistant() {
  const { data: status } = useApi<{ enabled: boolean }>("/assistant/status");
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener(OPEN_EVENT, on);
    return () => window.removeEventListener(OPEN_EVENT, on);
  }, []);
  if (!status?.enabled) return null;
  return (
    <>
      {!open && (
        <button onClick={() => setOpen(true)} aria-label="Quick log by chat"
          className="fixed bottom-24 right-4 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-ink text-canvas shadow-lg safe-bottom">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
        </button>
      )}
      {open && <ChatPanel onClose={() => setOpen(false)} />}
    </>
  );
}

function ChatPanel({ onClose }: { onClose: () => void }) {
  const path = usePathname();
  const currentBabyId = path.match(/^\/babies\/([0-9a-f-]{36})/)?.[1] ?? null;
  const { data: babies } = useApi<{ data: Baby[] }>("/babies");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [cards, setCards] = useState<Record<string, CardState>>({});
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const recRef = useRef<SpeechRec | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, cards, busy]);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); recRef.current?.stop(); };
  }, [onClose]);

  const send = useCallback(async (raw: string) => {
    const content = raw.trim();
    if (!content || busy) return;
    const next: Msg[] = [...msgs, { role: "user", text: content }];
    setMsgs(next);
    setText("");
    setBusy(true);
    try {
      const history = next.slice(-20).map((m) => ({ role: m.role, content: (m.role === "assistant" ? m.transcript ?? m.text : m.text).slice(0, 2000) }));
      const res = await api<ChatResponse>("POST", "/assistant/chat", { body: { messages: history, baby_id: currentBabyId }, idempotent: false });
      setMsgs((m) => [...m, { role: "assistant", text: res.reply, transcript: res.transcript, proposals: res.proposals, options: res.ask?.options }]);
      setCards((c) => ({ ...c, ...Object.fromEntries(res.proposals.map((p) => [p.id, { status: "pending", done: [] } as CardState])) }));
    } catch (e) {
      setMsgs((m) => [...m, { role: "assistant", text: errorText(e) }]);
    } finally { setBusy(false); }
  }, [busy, msgs, currentBabyId]);

  const save = useCallback(async (p: Proposal, force = false) => {
    const prev = cards[p.id] ?? { status: "pending", done: [] };
    const done = [...prev.done];
    setCards((c) => ({ ...c, [p.id]: { ...prev, status: "saving", message: undefined } }));
    try {
      for (let i = done.length; i < p.steps.length; i++) {
        const s = p.steps[i];
        const path = s.path.replace(/\{\{(\d+)\.id\}\}/g, (_, n) => String(done[Number(n)]?.id ?? ""));
        const body = force ? { ...s.body, force: true, confirm: true, confirm_quantity: true } : s.body;
        done.push(await api<{ id?: string }>(s.method, path, { body, offline: p.offline_ok && p.steps.length === 1 }) ?? {});
      }
      setCards((c) => ({ ...c, [p.id]: { status: "saved", done } }));
      for (const k of ["/babies", "/home", "/timeline", "/appointments", "/households"]) invalidate(k);
    } catch (e) {
      if (e instanceof ApiProblem && e.code === "QUEUED_OFFLINE") setCards((c) => ({ ...c, [p.id]: { status: "queued", done } }));
      else if (e instanceof ApiProblem && CONFIRMABLE(e) && !force) setCards((c) => ({ ...c, [p.id]: { status: "confirm", message: errorText(e), done } }));
      else setCards((c) => ({ ...c, [p.id]: { status: "error", message: errorText(e), done } }));
    }
  }, [cards]);

  const toggleMic = () => {
    if (listening) { recRef.current?.stop(); return; }
    const Rec = speechRecognition();
    if (!Rec) return;
    const rec = new Rec();
    rec.lang = navigator.language || "en-IN";
    rec.interimResults = true;
    rec.onresult = (e) => setText(Array.from(e.results).map((r) => r[0].transcript).join(" "));
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    setListening(true);
    rec.start();
  };

  const babyById = (id: string | null) => babies?.data.find((b) => b.id === id);
  const multi = (babies?.data.length ?? 0) > 1;

  return (
    <div role="dialog" aria-modal="true" aria-label="Quick log chat" className="fixed inset-0 z-50 flex flex-col bg-canvas">
      <header className="flex items-center gap-2 border-b border-line bg-surface px-4 py-2">
        <div className="flex-1">
          <h2 className="text-lg font-bold">Quick log</h2>
          <p className="text-xs text-ink-2">Type or speak. Nothing is saved until you tap Save.</p>
        </div>
        <button onClick={onClose} className="min-h-12 min-w-12 rounded-full text-2xl" aria-label="Close">×</button>
      </header>

      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-3 overflow-y-auto px-4 py-4" aria-live="polite">
        {!msgs.length && (
          <div className="flex flex-col gap-2 text-sm text-ink-2">
            <p>Tell me what happened, for example:</p>
            {["60 ml formula 10 minutes ago", "Breastfed left side 15 min", "Gave paracetamol 2.5 ml at 8pm", "Weight 4.2 kg at the clinic today", "Rash after cow's milk, suspected allergy", "Checkup with the doctor next Tuesday 11am"].map((ex) => (
              <button key={ex} onClick={() => send(ex)} className="self-start rounded-full bg-sunken px-3 py-2 text-left text-ink">{ex}</button>
            ))}
          </div>
        )}

        {msgs.map((m, i) => (
          <div key={i} className={cx("flex flex-col gap-2", m.role === "user" ? "items-end" : "items-start")}>
            <p className={cx("max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2", m.role === "user" ? "bg-sage text-white dark:text-[#10201A]" : "bg-surface text-ink")}>{m.text}</p>
            {m.proposals?.map((p) => (
              <ProposalCard key={p.id} p={p} state={cards[p.id]} baby={multi ? babyById(p.baby_id) : undefined}
                onSave={(force) => save(p, force)} onDismiss={() => setCards((c) => ({ ...c, [p.id]: { ...(c[p.id] ?? { done: [] }), status: "dismissed" } }))} />
            ))}
            {m.proposals && m.proposals.filter((p) => !p.blocked && cards[p.id]?.status === "pending").length > 1 && (
              <button onClick={() => m.proposals!.filter((p) => !p.blocked && cards[p.id]?.status === "pending").forEach((p) => save(p))}
                className="min-h-12 rounded-full bg-sage px-5 font-semibold text-white dark:text-[#10201A]">Save all</button>
            )}
            {i === msgs.length - 1 && m.options && (
              <div className="flex flex-wrap gap-2">
                {m.options.map((o) => <button key={o} onClick={() => send(o)} className="min-h-12 rounded-full border-2 border-sage px-4 font-semibold text-sage">{o}</button>)}
              </div>
            )}
          </div>
        ))}
        {busy && <p className="self-start rounded-2xl bg-surface px-4 py-2 text-ink-2" role="status">Reading…</p>}
        <div ref={endRef} />
      </div>

      <form onSubmit={(e) => { e.preventDefault(); send(text); }} className="mx-auto flex w-full max-w-xl items-end gap-2 border-t border-line bg-surface px-3 py-3 safe-bottom">
        {speechRecognition() && (
          <button type="button" onClick={toggleMic} aria-label={listening ? "Stop listening" : "Speak"} aria-pressed={listening}
            className={cx("flex h-12 w-12 shrink-0 items-center justify-center rounded-full", listening ? "animate-pulse bg-allergy text-white" : "bg-sunken text-ink")}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3" /></svg>
          </button>
        )}
        <label htmlFor="assistant-input" className="sr-only">Message</label>
        <textarea id="assistant-input" ref={inputRef} value={text} onChange={(e) => setText(e.target.value)} rows={1} maxLength={2000}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(text); } }}
          placeholder={listening ? "Listening…" : "e.g. fed 90 ml formula at 3pm"}
          className="max-h-32 min-h-12 flex-1 resize-none rounded-2xl border border-line bg-canvas px-4 py-3 text-ink" />
        <button type="submit" disabled={!text.trim() || busy} aria-label="Send"
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-sage text-white disabled:opacity-50 dark:text-[#10201A]">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M22 2 11 13M22 2l-7 20-4-9-9-4z" /></svg>
        </button>
      </form>
    </div>
  );
}

function ProposalCard({ p, state, baby, onSave, onDismiss }: { p: Proposal; state?: CardState; baby?: Baby; onSave: (force: boolean) => void; onDismiss: () => void }) {
  const s = state?.status ?? "pending";
  if (s === "dismissed") return <p className="text-sm text-ink-2 line-through">{p.title}</p>;
  return (
    <article className={cx("card w-full max-w-[92%] p-4", s === "saved" && "opacity-80")}>
      <div className="mb-1 flex items-center gap-2">
        {baby && <BabyChip name={baby.first_name} colour={baby.colour_token} />}
        <h3 className="font-bold">{p.title}</h3>
      </div>
      {p.details.length > 0 && <ul className="mb-3 text-sm text-ink-2">{p.details.map((d, i) => <li key={i}>{d}</li>)}</ul>}
      {p.blocked ? <p className="text-sm font-semibold text-caution">{p.blocked}</p>
        : s === "saved" ? <p className="font-semibold text-sage">✓ Saved</p>
        : s === "queued" ? <p className="font-semibold text-caution">Saved offline. Will sync automatically.</p>
        : (
          <>
            {state?.message && <p role="alert" className={cx("mb-2 text-sm", s === "confirm" ? "text-caution" : "text-allergy")}>{state.message}</p>}
            <div className="flex gap-2">
              <button onClick={() => onSave(s === "confirm")} disabled={s === "saving"}
                className="min-h-12 flex-1 rounded-full bg-sage px-4 font-semibold text-white disabled:opacity-50 dark:text-[#10201A]">
                {s === "saving" ? "Saving…" : s === "confirm" ? "Save anyway" : s === "error" ? "Try again" : "Save"}
              </button>
              <button onClick={onDismiss} disabled={s === "saving"} className="min-h-12 rounded-full border border-line px-4 font-semibold text-ink-2">Discard</button>
            </div>
          </>
        )}
    </article>
  );
}
