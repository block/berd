import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { motion, useReducedMotion } from "motion/react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

import { cn } from "@/shared/lib/cn";
import { getDesignSystemMetadata } from "@/shared/ui/design-system/metadata";

const tabsListVariants = cva(
  "text-muted-foreground inline-flex w-fit items-center justify-center",
  {
    variants: {
      variant: {
        default: "h-9 rounded-md bg-muted p-[3px]",
        segmented: "h-9 rounded-full bg-muted p-[3px]",
        buttons: "h-auto gap-1 bg-transparent p-0",
        weight: "h-auto gap-6 bg-transparent p-0",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

const tabsTriggerVariants = cva(
  "inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap transition-[color,box-shadow,background-color,border-color] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "data-[state=active]:bg-background dark:data-[state=active]:text-foreground dark:data-[state=active]:border-input dark:data-[state=active]:bg-muted/30 h-[calc(100%-1px)] rounded-md border border-transparent px-2 py-1 text-sm text-foreground dark:text-muted-foreground",
        segmented:
          "relative h-full rounded-full px-4 py-1 text-sm text-muted-foreground hover:text-foreground data-[state=active]:text-foreground",
        buttons:
          "h-8 rounded-md px-3 py-1 text-xs font-medium text-foreground hover:bg-accent hover:text-accent-foreground data-[state=active]:bg-muted data-[state=active]:text-foreground",
        weight:
          "h-auto px-0 py-1 text-sm font-light text-muted-foreground transition-[color,font-weight] hover:text-foreground data-[state=active]:font-normal data-[state=active]:text-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

interface TabsContextValue {
  activeValue: string | undefined;
  previousValue: string | undefined;
  segmentedLayoutId: string | null;
  segmentOrder: Map<string, number>;
  registerSegment: (value: string, element: HTMLElement | null) => void;
}

const TabsContext = createContext<TabsContextValue>({
  activeValue: undefined,
  previousValue: undefined,
  segmentedLayoutId: null,
  segmentOrder: new Map(),
  registerSegment: () => undefined,
});

function Tabs({
  className,
  value,
  defaultValue,
  onValueChange,
  ...props
}: ComponentProps<typeof TabsPrimitive.Root>) {
  const [internalValue, setInternalValue] = useState(defaultValue);
  const activeValue = value ?? internalValue;
  const previousValueRef = useRef(activeValue);
  const previousValue = previousValueRef.current;

  useEffect(() => {
    previousValueRef.current = activeValue;
  }, [activeValue]);

  return (
    <TabsContext.Provider
      value={{
        activeValue,
        previousValue,
        segmentedLayoutId: null,
        segmentOrder: new Map(),
        registerSegment: () => undefined,
      }}
    >
      <TabsPrimitive.Root
        {...getDesignSystemMetadata({
          component: "Tabs",
          slot: "tabs",
          source: "src/shared/ui/tabs.tsx",
          customClassName:
            typeof className === "string" ? className : undefined,
        })}
        data-slot="tabs"
        className={cn("flex flex-col gap-2", className)}
        value={value}
        defaultValue={defaultValue}
        onValueChange={(nextValue) => {
          setInternalValue(nextValue);
          onValueChange?.(nextValue);
        }}
        {...props}
      />
    </TabsContext.Provider>
  );
}

function TabsList({
  className,
  variant,
  ...props
}: ComponentProps<typeof TabsPrimitive.List> &
  VariantProps<typeof tabsListVariants>) {
  const generatedId = useId();
  const [layoutId] = useState(() => `segmented-tabs-${generatedId}`);
  const segmentElementsRef = useRef(new Map<string, HTMLElement>());
  const segmentOrderRef = useRef(new Map<string, number>());
  const registerSegment = useCallback(
    (value: string, element: HTMLElement | null) => {
      if (element) {
        segmentElementsRef.current.set(value, element);
      } else {
        segmentElementsRef.current.delete(value);
      }
      const orderedElements = [...segmentElementsRef.current.entries()].sort(
        ([, left], [, right]) => {
          const position = left.compareDocumentPosition(right);
          return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
        },
      );
      segmentOrderRef.current.clear();
      orderedElements.forEach(([segmentValue], index) => {
        segmentOrderRef.current.set(segmentValue, index);
      });
    },
    [],
  );
  const list = (
    <TabsPrimitive.List
      {...getDesignSystemMetadata({
        component: "Tabs",
        slot: "tabs-list",
        source: "src/shared/ui/tabs.tsx",
        variant: variant ?? "default",
        customClassName: typeof className === "string" ? className : undefined,
      })}
      data-slot="tabs-list"
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  );

  const tabsContext = useContext(TabsContext);

  return variant === "segmented" ? (
    <TabsContext.Provider
      value={{
        ...tabsContext,
        segmentedLayoutId: layoutId,
        segmentOrder: segmentOrderRef.current,
        registerSegment,
      }}
    >
      {list}
    </TabsContext.Provider>
  ) : (
    list
  );
}

function TabsTrigger({
  className,
  variant,
  children,
  ref,
  ...props
}: Omit<ComponentProps<typeof TabsPrimitive.Trigger>, "asChild"> &
  VariantProps<typeof tabsTriggerVariants>) {
  const {
    activeValue,
    previousValue,
    segmentedLayoutId,
    segmentOrder,
    registerSegment,
  } = useContext(TabsContext);
  const reduceMotion = useReducedMotion();
  const [transitionActive, setTransitionActive] = useState(false);
  const isSegmented = variant === "segmented" && segmentedLayoutId !== null;
  const isActiveSegment = isSegmented && activeValue === props.value;
  const hasActiveSegmentChanged =
    previousValue !== undefined && previousValue !== activeValue;
  const previousIndex = previousValue
    ? segmentOrder.get(previousValue)
    : undefined;
  const activeIndex = activeValue ? segmentOrder.get(activeValue) : undefined;
  const slideDirection =
    previousIndex !== undefined &&
    activeIndex !== undefined &&
    activeIndex < previousIndex
      ? "left"
      : "right";
  useEffect(() => {
    if (reduceMotion || !hasActiveSegmentChanged) {
      setTransitionActive(false);
      return;
    }
    setTransitionActive(true);
    const timer = window.setTimeout(() => setTransitionActive(false), 340);
    return () => window.clearTimeout(timer);
  }, [activeValue, hasActiveSegmentChanged, reduceMotion]);

  const setTriggerRef = useCallback(
    (element: HTMLButtonElement | null) => {
      if (typeof ref === "function") {
        ref(element);
      } else if (ref) {
        ref.current = element;
      }
      if (isSegmented) {
        registerSegment(props.value, element);
      }
    },
    [isSegmented, props.value, ref, registerSegment],
  );

  return (
    <TabsPrimitive.Trigger
      {...getDesignSystemMetadata({
        component: "Tabs",
        slot: "tabs-trigger",
        source: "src/shared/ui/tabs.tsx",
        variant: variant ?? "default",
        props: { value: props.value },
        customClassName: typeof className === "string" ? className : undefined,
      })}
      ref={setTriggerRef}
      data-slot="tabs-trigger"
      className={cn(tabsTriggerVariants({ variant }), className)}
      {...props}
    >
      {isActiveSegment ? (
        <motion.span
          layoutId={segmentedLayoutId}
          className="absolute inset-0"
          transition={
            reduceMotion
              ? { duration: 0 }
              : { type: "spring", duration: 0.28, bounce: 0 }
          }
          data-segmented-active-container
        >
          <motion.span
            className="absolute inset-y-0 overflow-hidden rounded-full bg-background shadow-sm"
            initial={false}
            animate={
              reduceMotion || !hasActiveSegmentChanged
                ? { left: "0%", right: "0%" }
                : slideDirection === "right"
                  ? {
                      left: ["0%", "-18%", "-6%", "0%"],
                      right: ["0%", "0%", "0%", "0%"],
                    }
                  : {
                      left: ["0%", "0%", "0%", "0%"],
                      right: ["0%", "-18%", "-6%", "0%"],
                    }
            }
            transition={
              reduceMotion
                ? { duration: 0 }
                : {
                    duration: 0.34,
                    times: [0, 0.42, 0.68, 1],
                    ease: [0.22, 1, 0.36, 1],
                  }
            }
          >
            {transitionActive ? (
              <motion.span
                aria-hidden="true"
                data-segmented-refraction
                className="pointer-events-none absolute inset-y-0 -left-1/3 w-2/3 skew-x-[-18deg] bg-gradient-to-r from-transparent via-foreground/10 to-transparent blur-[0.5px]"
                initial={{ x: "0%", opacity: 0 }}
                animate={{
                  x: ["0%", "55%", "130%", "130%"],
                  opacity: [0, 0.7, 0, 0],
                }}
                transition={{
                  duration: 0.34,
                  times: [0, 0.16, 0.35, 1],
                  ease: "easeOut",
                }}
              />
            ) : null}
          </motion.span>
          {transitionActive ? (
            <span
              aria-hidden="true"
              data-segmented-sparkles
              className="pointer-events-none absolute inset-0"
            >
              {[
                { left: "20%", top: "8%" },
                { left: "48%", top: "72%" },
                { left: "72%", top: "18%" },
                { left: "88%", top: "60%" },
              ].map((sparkle) => (
                <motion.span
                  key={`${sparkle.left}-${sparkle.top}`}
                  className="absolute size-1 rounded-full bg-foreground/35 shadow-[0_0_4px_currentColor]"
                  style={{ left: sparkle.left, top: sparkle.top }}
                  initial={{ scale: 0, opacity: 0 }}
                  animate={{
                    scale: [0, 1.15, 0, 0],
                    opacity: [0, 0.8, 0, 0],
                  }}
                  transition={{
                    duration: 0.34,
                    times: [0, 0.14, 0.35, 1],
                    ease: "easeOut",
                  }}
                />
              ))}
            </span>
          ) : null}
        </motion.span>
      ) : null}
      {isSegmented ? (
        <span className="relative z-10">{children}</span>
      ) : (
        children
      )}
    </TabsPrimitive.Trigger>
  );
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      {...getDesignSystemMetadata({
        component: "Tabs",
        slot: "tabs-content",
        source: "src/shared/ui/tabs.tsx",
        props: { value: props.value },
        customClassName: typeof className === "string" ? className : undefined,
      })}
      data-slot="tabs-content"
      className={cn("flex-1 outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
