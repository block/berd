import type { PointerEvent } from "react";

export const AVATAR_CUSTOMIZE_SURFACE_CLASS =
  "group relative aspect-square w-full [--avatar-customize-x:calc(100%-5.5rem)] [--avatar-customize-y:82%]";

export const AVATAR_CUSTOMIZE_TRIGGER_CLASS =
  "absolute inset-0 z-10 !h-full !w-full cursor-pointer rounded-[inherit] bg-transparent p-0 text-transparent outline-none hover:bg-transparent focus-visible:bg-transparent";

export const AVATAR_CUSTOMIZE_AFFORDANCE_CLASS =
  "pointer-events-none absolute left-[var(--avatar-customize-x)] top-[var(--avatar-customize-y)] z-20 inline-flex h-9 -translate-y-1/2 scale-90 items-center justify-center gap-2 whitespace-nowrap rounded-full bg-surface-agent-profile-control-bg px-4 text-sm font-normal text-surface-agent-profile-fg opacity-0 shadow-agent-profile-affordance transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)] group-hover:scale-100 group-hover:opacity-100 group-focus-within:scale-100 group-focus-within:opacity-100";

const CURSOR_OFFSET_X = 16;
const CURSOR_OFFSET_Y = 12;
const DEFAULT_BUTTON_WIDTH = 112;
const DEFAULT_BUTTON_HEIGHT = 36;
const EDGE_PADDING = 8;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function updateAvatarCustomizePosition(
  event: PointerEvent<HTMLElement>,
) {
  const rect = event.currentTarget.getBoundingClientRect();
  const maxX = Math.max(EDGE_PADDING, rect.width - DEFAULT_BUTTON_WIDTH);
  const maxY = Math.max(EDGE_PADDING, rect.height - EDGE_PADDING);
  event.currentTarget.style.setProperty(
    "--avatar-customize-x",
    `${clamp(event.clientX - rect.left + CURSOR_OFFSET_X, EDGE_PADDING, maxX)}px`,
  );
  event.currentTarget.style.setProperty(
    "--avatar-customize-y",
    `${clamp(
      event.clientY - rect.top + CURSOR_OFFSET_Y,
      DEFAULT_BUTTON_HEIGHT / 2 + EDGE_PADDING,
      maxY,
    )}px`,
  );
}
