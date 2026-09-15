"use client";

import { useRef, useCallback } from "react";

interface ResizeHandleProps {
  onResize: (delta: number) => void;
  side: "left" | "right" | "top" | "bottom";
  orientation?: "horizontal" | "vertical";
}

export default function ResizeHandle({
  onResize,
  side,
  orientation = "horizontal",
}: ResizeHandleProps) {
  const dragging = useRef(false);
  const lastPos = useRef(0);

  const isVertical = orientation === "vertical";
  const cursorStyle = isVertical ? "row-resize" : "col-resize";

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      lastPos.current = isVertical ? e.clientY : e.clientX;

      const onMouseMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        const current = isVertical ? ev.clientY : ev.clientX;
        const delta = current - lastPos.current;
        lastPos.current = current;
        onResize(
          side === "left" || side === "top" ? delta : -delta
        );
      };

      const onMouseUp = () => {
        dragging.current = false;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      document.body.style.cursor = cursorStyle;
      document.body.style.userSelect = "none";
    },
    [onResize, side, isVertical, cursorStyle]
  );

  if (isVertical) {
    return (
      <div
        onMouseDown={onMouseDown}
        className="h-1 flex-shrink-0 cursor-row-resize hover:bg-accent/30 active:bg-accent/50 transition-colors relative group"
        title="Drag to resize"
      >
        <div className="absolute inset-x-0 -top-1 -bottom-1" />
      </div>
    );
  }

  return (
    <div
      onMouseDown={onMouseDown}
      className="w-1 flex-shrink-0 cursor-col-resize hover:bg-accent/30 active:bg-accent/50 transition-colors relative group"
      title="Drag to resize"
    >
      <div className="absolute inset-y-0 -left-1 -right-1" />
    </div>
  );
}
