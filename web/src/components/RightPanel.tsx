"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import dynamic from "next/dynamic";
import ResizeHandle from "./ResizeHandle";
import PlanPanel from "./PlanPanel";

const FilePreview = dynamic(() => import("@/components/FilePreview"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-full bg-bg-secondary text-text-muted">
      <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
    </div>
  ),
});

const UPPER_MIN = 150;
const LOWER_MIN = 120;
const DEFAULT_RATIO = 0.6;

export default function RightPanel() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [splitRatio, setSplitRatio] = useState(DEFAULT_RATIO);
  const [containerHeight, setContainerHeight] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerHeight(entry.contentRect.height);
      }
    });
    ro.observe(el);
    setContainerHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const handleVerticalResize = useCallback(
    (delta: number) => {
      if (containerHeight <= 0) return;
      setSplitRatio((prev) => {
        const handleHeight = 4; // h-1 = 0.25rem = 4px
        const available = containerHeight - handleHeight;
        const newUpperPx = prev * available + delta;
        // Enforce min heights
        const clampedUpper = Math.max(UPPER_MIN, Math.min(available - LOWER_MIN, newUpperPx));
        return clampedUpper / available;
      });
    },
    [containerHeight]
  );

  const handleHeight = 4;
  const available = containerHeight - handleHeight;
  const upperHeight = Math.max(UPPER_MIN, splitRatio * available);
  const lowerHeight = Math.max(LOWER_MIN, available - upperHeight);

  return (
    <div ref={containerRef} className="flex flex-col h-full overflow-hidden">
      {/* Upper: File Preview */}
      <div style={{ height: upperHeight }} className="flex-shrink-0 overflow-hidden">
        <FilePreview />
      </div>

      {/* Vertical resize handle */}
      <ResizeHandle onResize={handleVerticalResize} side="top" orientation="vertical" />

      {/* Lower: Plan / Results / Subagents */}
      <div style={{ height: lowerHeight }} className="flex-shrink-0 overflow-hidden">
        <PlanPanel />
      </div>
    </div>
  );
}
