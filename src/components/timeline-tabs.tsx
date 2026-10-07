"use client";
import { useEffect, useState } from "react";
import { Segmented } from "@/components/ui";
import { ICON, excretionCountText } from "@/components/timeline-icons";

export type TimelineTab = "highlights" | "feeds" | "excretions" | "all";
const TABS: TimelineTab[] = ["highlights", "feeds", "excretions", "all"];
const KEY = "timeline-tab";

/** Highlights = everything except the high-volume routine logs (feeds, excretions). */
export const HIGHLIGHT_TYPES = Object.keys(ICON).filter((t) => t !== "FEEDING" && t !== "EXCRETION");

export function tabTypes(tab: TimelineTab): string[] | null {
  return tab === "feeds" ? ["FEEDING"] : tab === "excretions" ? ["EXCRETION"] : tab === "highlights" ? HIGHLIGHT_TYPES : null;
}

/** Selected tab: `?tab=` wins (deep links), then the last tab this viewer used. */
export function useTimelineTab(): [TimelineTab, (t: TimelineTab) => void] {
  const [tab, setTab] = useState<TimelineTab>("highlights");
  useEffect(() => {
    let t: string | null = new URLSearchParams(window.location.search).get("tab");
    if (!t) try { t = localStorage.getItem(KEY); } catch { /* storage unavailable */ }
    if (t && TABS.includes(t as TimelineTab)) setTab(t as TimelineTab);
  }, []);
  return [tab, (t) => {
    setTab(t);
    try { localStorage.setItem(KEY, t); } catch { /* storage unavailable */ }
    const u = new URL(window.location.href); u.searchParams.set("tab", t); window.history.replaceState(null, "", u);
  }];
}

export function TimelineTabBar({ tab, onChange }: { tab: TimelineTab; onChange: (t: TimelineTab) => void }) {
  return (
    <div className="mb-3">
      <Segmented<TimelineTab> label="Timeline view" value={tab} onChange={onChange} options={[
        { value: "highlights", label: "Highlights", icon: <span aria-hidden>⭐</span> }, { value: "feeds", label: "Feeds", icon: <span aria-hidden>🍼</span> },
        { value: "excretions", label: "Excretions", icon: <span aria-hidden>💧</span> }, { value: "all", label: "All", icon: <span aria-hidden>☰</span> }]} />
    </div>
  );
}

/** Per-day count shown next to the date in the Feeds / Excretions tabs. */
export function dayCountText(tab: TimelineTab, list: { event_type: string; source_detail?: string | null }[]) {
  if (tab === "feeds") return `${list.length} feed${list.length === 1 ? "" : "s"}`;
  if (tab === "excretions") return excretionCountText(list.map((e) => e.source_detail));
  return null;
}
