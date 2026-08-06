import { ArrowRight, Check, ChevronLeft, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import {
  STARTER_TASKS,
  isStarterTaskComplete,
  type StarterTaskCompletionState,
  type StarterTaskId,
} from "./starterTasks";

export interface StarterTaskListLabels {
  title: string;
  backHome: string;
  dismiss: string;
  tasks: Record<StarterTaskId, string>;
  openTask: (taskLabel: string) => string;
  completedTask: (taskLabel: string) => string;
  checkTask: (taskLabel: string) => string;
  uncheckTask: (taskLabel: string) => string;
}

export interface StarterTaskListProps {
  completionState: StarterTaskCompletionState;
  mode: "canvas" | "overlay";
  labels: StarterTaskListLabels;
  onTaskSelect: (id: StarterTaskId) => void;
  onTaskToggle: (id: StarterTaskId) => void;
  onBackHome: () => void;
  onDismiss: () => void;
  omittedTaskIds?: ReadonlySet<StarterTaskId>;
  className?: string;
}

export function StarterTaskList({
  completionState,
  mode,
  labels,
  onTaskSelect,
  onTaskToggle,
  onBackHome,
  onDismiss,
  omittedTaskIds = new Set(),
  className,
}: StarterTaskListProps) {
  const noteRef = useRef<HTMLElement | null>(null);
  const [overlayPosition, setOverlayPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const dragAbortRef = useRef<AbortController | null>(null);

  const clampOverlayPosition = useCallback(
    (position: { left: number; top: number }) => {
      const rect = noteRef.current?.getBoundingClientRect();
      if (!rect) return position;
      return {
        left: Math.min(
          Math.max(8, position.left),
          Math.max(8, window.innerWidth - rect.width - 8),
        ),
        top: Math.min(
          Math.max(8, position.top),
          Math.max(8, window.innerHeight - rect.height - 8),
        ),
      };
    },
    [],
  );

  useEffect(() => {
    if (mode !== "overlay") return;
    const handleResize = () => {
      setOverlayPosition((position) =>
        position ? clampOverlayPosition(position) : null,
      );
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [clampOverlayPosition, mode]);

  useEffect(() => () => dragAbortRef.current?.abort(), []);

  const handleOverlayDragStart = (event: PointerEvent<HTMLElement>) => {
    if (mode !== "overlay" || event.button !== 0) return;
    const note = noteRef.current;
    if (!note) return;

    event.preventDefault();
    const rect = note.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    event.currentTarget.setPointerCapture(event.pointerId);

    dragAbortRef.current?.abort();
    const controller = new AbortController();
    dragAbortRef.current = controller;
    const handleMove = (moveEvent: globalThis.PointerEvent) => {
      setOverlayPosition(
        clampOverlayPosition({
          left: moveEvent.clientX - offsetX,
          top: moveEvent.clientY - offsetY,
        }),
      );
    };
    const handleEnd = () => {
      controller.abort();
      if (dragAbortRef.current === controller) dragAbortRef.current = null;
    };
    window.addEventListener("pointermove", handleMove, {
      signal: controller.signal,
    });
    window.addEventListener("pointerup", handleEnd, {
      signal: controller.signal,
    });
    window.addEventListener("pointercancel", handleEnd, {
      signal: controller.signal,
    });
  };

  const overlayStyle =
    mode === "overlay" && overlayPosition
      ? ({
          left: overlayPosition.left,
          top: overlayPosition.top,
        } satisfies CSSProperties)
      : undefined;
  const visibleTasks = STARTER_TASKS.filter(
    (task) => !omittedTaskIds.has(task.id),
  );

  return (
    <section
      ref={noteRef}
      aria-labelledby="starter-task-list-title"
      data-mode={mode}
      style={overlayStyle}
      className={cn(
        "h-full w-full overflow-hidden rounded-xs bg-sticky-note-blue px-4 pb-4 pt-3 text-sm text-sticky-note-foreground shadow-sticky-note",
        mode === "overlay" &&
          "fixed right-4 bottom-28 z-40 max-h-[min(24rem,calc(100dvh-8rem))] h-auto w-[min(16rem,calc(100vw-2rem))] overflow-y-auto smooth-shadow-sm",
        overlayPosition && "right-auto bottom-auto",
        className,
      )}
    >
      <header
        className={cn(
          "flex items-center",
          mode === "overlay" &&
            "cursor-grab touch-none select-none active:cursor-grabbing",
        )}
        onPointerDown={handleOverlayDragStart}
      >
        {mode === "overlay" ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={labels.backHome}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={onBackHome}
            className="-ml-1"
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
        ) : null}
        <h2
          id="starter-task-list-title"
          className="min-w-0 flex-1 text-sm font-semibold"
        >
          {labels.title}
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={labels.dismiss}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onDismiss}
          className="-mr-1"
        >
          <X aria-hidden="true" />
        </Button>
      </header>

      <ul className="mt-2 space-y-0.5">
        {visibleTasks.map((task) => {
          const label = labels.tasks[task.id];
          const completed = isStarterTaskComplete(completionState, task.id);

          return (
            <li key={task.id}>
              <div
                className={cn(
                  "group/task grid min-h-8 w-full grid-cols-[16px_minmax(0,1fr)_16px] items-center gap-2 px-1 text-left text-sm",
                  completed && "text-sticky-note-muted",
                )}
              >
                <button
                  type="button"
                  aria-label={
                    completed
                      ? labels.uncheckTask(label)
                      : labels.checkTask(label)
                  }
                  aria-pressed={completed}
                  onClick={(event) => {
                    event.stopPropagation();
                    onTaskToggle(task.id);
                  }}
                  className="-m-2 flex size-8 items-center justify-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="flex size-4 items-center justify-center rounded-[3px] border-[1.5px] border-sticky-note-muted/70">
                    {completed ? (
                      <Check className="size-3 stroke-[2.5]" />
                    ) : null}
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={
                    completed
                      ? labels.completedTask(label)
                      : labels.openTask(label)
                  }
                  onClick={() => onTaskSelect(task.id)}
                  className={cn(
                    "min-w-0 flex-1 whitespace-normal text-left leading-5 group-hover/task:font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    completed && "line-through",
                  )}
                >
                  {label}
                </button>
                <ArrowRight
                  aria-hidden="true"
                  className="size-3.5 justify-self-center opacity-0 group-hover/task:opacity-100"
                />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
