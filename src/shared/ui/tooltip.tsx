import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

import { cn } from "@/shared/lib/cn";
import { TOOLTIP_DELAY } from "@/shared/ui/tooltip-delay";

const TooltipProviderPresenceContext = React.createContext(false);

type PointerPosition = { x: number; y: number };

type TooltipInteractionContextValue = {
  onPointerDown: (trigger: HTMLElement, position: PointerPosition) => void;
  onPointerMove: (trigger: HTMLElement, position: PointerPosition) => boolean;
  onPointerLeave: () => void;
  shouldSuppressFocus: (trigger: HTMLElement) => boolean;
};

const TooltipInteractionContext =
  React.createContext<TooltipInteractionContextValue | null>(null);

const EXPANDED_ATTRIBUTE = ["aria", "expanded"].join("-");

function triggerOwnsOpenOverlay(trigger: HTMLElement) {
  return trigger.getAttribute(EXPANDED_ATTRIBUTE) === "true";
}

function TooltipProvider({
  delayDuration = TOOLTIP_DELAY.standard,
  skipDelayDuration = TOOLTIP_DELAY.skip,
  disableHoverableContent = true,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  const hasProvider = React.useContext(TooltipProviderPresenceContext);
  if (hasProvider) {
    return children;
  }

  return (
    <TooltipProviderPresenceContext.Provider value>
      <TooltipPrimitive.Provider
        data-slot="tooltip-provider"
        delayDuration={delayDuration}
        skipDelayDuration={skipDelayDuration}
        disableHoverableContent={disableHoverableContent}
        {...props}
      >
        {children}
      </TooltipPrimitive.Provider>
    </TooltipProviderPresenceContext.Provider>
  );
}

function Tooltip({
  delayDuration,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const hasProvider = React.useContext(TooltipProviderPresenceContext);
  const suppressedTriggerRef = React.useRef<HTMLElement | null>(null);
  const pointerDownPositionRef = React.useRef<PointerPosition | null>(null);
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
  const open = controlledOpen ?? uncontrolledOpen;
  const allowNextOpenRef = React.useRef(false);
  const setOpen = React.useCallback(
    (nextOpen: boolean) => {
      const trigger = suppressedTriggerRef.current;
      const shouldSuppress =
        nextOpen && !allowNextOpenRef.current && trigger != null;
      if (shouldSuppress) return;
      allowNextOpenRef.current = false;

      if (controlledOpen === undefined) setUncontrolledOpen(nextOpen);
      onOpenChange?.(nextOpen);
    },
    [controlledOpen, onOpenChange],
  );
  const reopenTimerRef = React.useRef<number | null>(null);
  const effectiveDelayDuration = delayDuration ?? TOOLTIP_DELAY.standard;

  const clearReopenTimer = React.useCallback(() => {
    if (reopenTimerRef.current !== null) {
      window.clearTimeout(reopenTimerRef.current);
      reopenTimerRef.current = null;
    }
  }, []);

  React.useEffect(() => clearReopenTimer, [clearReopenTimer]);

  React.useEffect(() => {
    const trigger = suppressedTriggerRef.current;
    if (open && trigger != null && triggerOwnsOpenOverlay(trigger)) {
      if (controlledOpen === undefined) setUncontrolledOpen(false);
      onOpenChange?.(false);
    }
  });

  const interaction = React.useMemo<TooltipInteractionContextValue>(
    () => ({
      onPointerDown: (trigger, position) => {
        clearReopenTimer();
        pointerDownPositionRef.current = position;
        suppressedTriggerRef.current = trigger;
        setOpen(false);
      },
      onPointerMove: (trigger, position) => {
        const pointerDownPosition = pointerDownPositionRef.current;
        const pointerMoved =
          pointerDownPosition != null &&
          (pointerDownPosition.x !== position.x ||
            pointerDownPosition.y !== position.y);

        if (triggerOwnsOpenOverlay(trigger)) {
          clearReopenTimer();
          suppressedTriggerRef.current = trigger;
          setOpen(false);
          return true;
        }

        if (!suppressedTriggerRef.current || !pointerMoved) return false;

        clearReopenTimer();
        reopenTimerRef.current = window.setTimeout(() => {
          suppressedTriggerRef.current = null;
          pointerDownPositionRef.current = null;
          allowNextOpenRef.current = true;
          setOpen(true);
          reopenTimerRef.current = null;
        }, effectiveDelayDuration);
        return true;
      },
      onPointerLeave: () => {
        clearReopenTimer();
      },
      shouldSuppressFocus: (trigger) =>
        suppressedTriggerRef.current === trigger,
    }),
    [
      clearReopenTimer,
      controlledOpen,
      effectiveDelayDuration,
      onOpenChange,
      setOpen,
    ],
  );

  const root = (
    <TooltipInteractionContext.Provider value={interaction}>
      <TooltipPrimitive.Root
        data-slot="tooltip"
        delayDuration={delayDuration}
        open={open}
        onOpenChange={setOpen}
        {...props}
      />
    </TooltipInteractionContext.Provider>
  );

  // Product roots mount one provider so nearby tooltips share skip-delay state.
  // The fallback keeps isolated component tests and embeds safe by themselves.
  return hasProvider ? root : <TooltipProvider>{root}</TooltipProvider>;
}

function TooltipTrigger({
  onPointerDown,
  onPointerMove,
  onPointerLeave,
  onFocus,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  const interaction = React.useContext(TooltipInteractionContext);

  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      onPointerDown={(event) => {
        onPointerDown?.(event);
        if (!event.defaultPrevented) {
          interaction?.onPointerDown(event.currentTarget, {
            x: event.clientX,
            y: event.clientY,
          });
        }
      }}
      onPointerMove={(event) => {
        onPointerMove?.(event);
        interaction?.onPointerMove(event.currentTarget, {
          x: event.clientX,
          y: event.clientY,
        });
      }}
      onPointerLeave={(event) => {
        interaction?.onPointerLeave();
        onPointerLeave?.(event);
      }}
      onFocus={(event) => {
        if (!interaction?.shouldSuppressFocus(event.currentTarget)) {
          onFocus?.(event);
        }
      }}
      {...props}
    />
  );
}

type TooltipContentProps = React.ComponentProps<
  typeof TooltipPrimitive.Content
> & {
  /** Lets pointer input pass through the portaled tooltip to the surface below. */
  pointerEvents?: "auto" | "none";
  layer?: "default" | "modal";
};

function TooltipContent({
  className,
  side = "top",
  sideOffset = 0,
  children,
  pointerEvents = "auto",
  layer = "default",
  ...props
}: TooltipContentProps) {
  const content = (
    <TooltipPrimitive.Content
      data-slot="tooltip-content"
      data-preferred-side={side}
      side={side}
      sideOffset={sideOffset}
      className={cn(
        "bg-popover-inverse text-popover-inverse-foreground animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-fit origin-(--radix-tooltip-content-transform-origin) rounded-md px-3 py-1.5 text-xs text-balance",
        layer === "modal" && "z-[70]",
        className,
      )}
      {...props}
    >
      {children}
      <TooltipPrimitive.Arrow className="bg-popover-inverse fill-popover-inverse z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px]" />
    </TooltipPrimitive.Content>
  );

  return (
    <TooltipPrimitive.Portal>
      {pointerEvents === "none" ? (
        <div
          data-slot="tooltip-pointer-pass-through"
          className="contents pointer-events-none"
        >
          {content}
        </div>
      ) : (
        content
      )}
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
