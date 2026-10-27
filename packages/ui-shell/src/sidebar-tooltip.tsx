"use client";

import React, { useId, useState } from "react";
import { createPortal } from "react-dom";

export type SidebarTooltipProps = {
  content: React.ReactNode;
  disabledReason?: string;
  active?: boolean;
  children?: React.ReactElement<{
    "aria-describedby"?: string;
    onMouseEnter?: (e: React.MouseEvent) => void;
    onMouseLeave?: (e: React.MouseEvent) => void;
    onFocus?: (e: React.FocusEvent) => void;
    onBlur?: (e: React.FocusEvent) => void;
  }>;
};

export function SidebarTooltip({
  content,
  disabledReason,
  active = false,
  children,
}: SidebarTooltipProps) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(
    null,
  );
  const tooltipId = useId();
  const visible = hovered || focused;

  if (!children) {
    return null;
  }

  if (!active) {
    return children;
  }

  const updatePosition = (element: HTMLElement) => {
    try {
      const rect = element.getBoundingClientRect();
      setCoords({
        top: Math.round(rect.top + rect.height / 2),
        left: Math.round(rect.right + 12),
      });
    } catch {
      // Fallback
    }
  };

  const handleMouseEnter = (e: React.MouseEvent) => {
    if (e.currentTarget instanceof HTMLElement) {
      updatePosition(e.currentTarget);
    }
    setHovered(true);
    children.props.onMouseEnter?.(e);
  };

  const handleMouseLeave = (e: React.MouseEvent) => {
    setHovered(false);
    children.props.onMouseLeave?.(e);
  };

  const handleFocus = (e: React.FocusEvent) => {
    if (e.currentTarget instanceof HTMLElement) {
      updatePosition(e.currentTarget);
    }
    setFocused(true);
    children.props.onFocus?.(e);
  };

  const handleBlur = (e: React.FocusEvent) => {
    setFocused(false);
    children.props.onBlur?.(e);
  };

  const existingDescribedBy = children.props["aria-describedby"];
  const describedBy = existingDescribedBy
    ? `${existingDescribedBy} ${tooltipId}`
    : tooltipId;

  const clonedChild = React.cloneElement(children, {
    "aria-describedby": describedBy,
    onMouseEnter: handleMouseEnter,
    onMouseLeave: handleMouseLeave,
    onFocus: handleFocus,
    onBlur: handleBlur,
  });

  const canUsePortal =
    typeof window !== "undefined" &&
    typeof document !== "undefined" &&
    Boolean(document.body);

  const tooltipPanel = visible ? (
    <div
      id={tooltipId}
      role="tooltip"
      className="sidebar-tooltip-panel"
      style={
        coords
          ? {
              position: "fixed",
              top: `${coords.top}px`,
              left: `${coords.left}px`,
              transform: "translateY(-50%)",
              zIndex: 99999,
              pointerEvents: "none",
            }
          : undefined
      }
    >
      <div className="sidebar-tooltip-content">{content}</div>
      {disabledReason ? (
        <div className="sidebar-tooltip-reason">{disabledReason}</div>
      ) : null}
    </div>
  ) : null;

  return (
    <div className="sidebar-tooltip-wrapper">
      {clonedChild}
      {visible && canUsePortal && coords
        ? createPortal(tooltipPanel, document.body)
        : tooltipPanel}
    </div>
  );
}
