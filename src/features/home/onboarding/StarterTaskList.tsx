import { ArrowRight, Check, ChevronLeft, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
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
  backToList: string;
  dismiss: string;
  closeTaskDetails: string;
  markDone: string;
  tasks: Record<StarterTaskId, string>;
  taskDetails: Record<StarterTaskId, string>;
  openTask: (taskLabel: string) => string;
  completedTask: (taskLabel: string) => string;
  checkTask: (taskLabel: string) => string;
  uncheckTask: (taskLabel: string) => string;
}

export interface StarterTaskListProps {
  completionState: StarterTaskCompletionState;
  mode: "canvas" | "overlay";
  labels: StarterTaskListLabels;
  selectedTaskId?: StarterTaskId | null;
  onTaskSelect: (id: StarterTaskId) => void;
  onTaskDetailsBack?: () => void;
  onCloseSecondary?: () => void;
  onTaskToggle: (id: StarterTaskId) => void;
  onBackHome: () => void;
  onDismiss: () => void;
  exiting?: boolean;
  omittedTaskIds?: ReadonlySet<StarterTaskId>;
  className?: string;
}

export function StarterTaskList({
  completionState,
  mode,
  labels,
  selectedTaskId: controlledSelectedTaskId,
  onTaskSelect,
  onTaskDetailsBack,
  onCloseSecondary,
  onTaskToggle,
  onBackHome,
  onDismiss,
  exiting = false,
  omittedTaskIds = new Set(),
  className,
}: StarterTaskListProps) {
  const noteRef = useRef<HTMLElement | null>(null);
  const reduceMotion = useReducedMotion();
  const [localSelectedTaskId, setLocalSelectedTaskId] =
    useState<StarterTaskId | null>(null);
  const selectedTaskId =
    controlledSelectedTaskId !== undefined
      ? controlledSelectedTaskId
      : localSelectedTaskId;
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
  const selectedTask = selectedTaskId
    ? STARTER_TASKS.find((task) => task.id === selectedTaskId)
    : undefined;
  const selectedTaskCompleted = selectedTask
    ? isStarterTaskComplete(completionState, selectedTask.id)
    : false;
  const accessibleTitle = selectedTask
    ? labels.tasks[selectedTask.id]
    : labels.title;

  const taskList = (
    <section
      ref={noteRef}
      aria-label={accessibleTitle}
      data-mode={mode}
      data-starter-task-list="true"
      style={overlayStyle}
      className={cn(
        "h-full w-full overflow-hidden rounded-xs bg-sticky-note-rose px-4 pb-4 pt-2 text-[12px] text-sticky-note-foreground shadow-sticky-note",
        mode === "overlay" &&
          "pointer-events-auto fixed right-4 bottom-28 z-[55] max-h-[min(24rem,calc(100dvh-8rem))] h-auto w-[min(16rem,calc(100vw-2rem))] overflow-y-auto smooth-shadow-sm motion-safe:animate-in motion-safe:slide-in-from-right-8 motion-safe:fade-in-0 motion-safe:duration-500 motion-safe:ease-[cubic-bezier(0.19,1,0.22,1)] motion-safe:will-change-transform motion-reduce:animate-none",
        mode === "overlay" &&
          selectedTask?.id === "create-project" &&
          "right-[min(calc(560px+2.25rem),calc(100vw-17rem))]",
        overlayPosition && "right-auto bottom-auto",
        exiting &&
          "pointer-events-none motion-safe:animate-out motion-safe:slide-out-to-right motion-safe:fade-out-0 motion-safe:duration-300 motion-safe:ease-[cubic-bezier(0.215,0.61,0.355,1)] motion-safe:will-change-transform motion-reduce:animate-none",
        className,
      )}
    >
      <div className="grid">
        <AnimatePresence initial={false}>
          <motion.div
            key={selectedTask ? `details-${selectedTask.id}` : "task-list"}
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduceMotion ? undefined : { opacity: 0 }}
            transition={{ duration: 0.16, ease: "linear" }}
            className="col-start-1 row-start-1"
          >
            <header
              className={cn(
                "flex items-center",
                mode === "overlay" &&
                  "cursor-grab touch-none select-none active:cursor-grabbing",
              )}
              onPointerDown={handleOverlayDragStart}
            >
              {mode === "overlay" || selectedTask ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xxs"
                  aria-label={
                    selectedTask ? labels.backToList : labels.backHome
                  }
                  onPointerDown={(event) => event.stopPropagation()}
                  className="justify-start"
                  onClick={() => {
                    if (selectedTask) {
                      setLocalSelectedTaskId(null);
                      if (mode === "overlay") {
                        onBackHome();
                      } else {
                        onTaskDetailsBack?.();
                      }
                    } else {
                      onBackHome();
                    }
                  }}
                >
                  <ChevronLeft aria-hidden="true" className="size-3" />
                </Button>
              ) : null}
              {!selectedTask ? (
                <h2 className="min-w-0 flex-1 text-[12px] font-semibold">
                  {labels.title}
                </h2>
              ) : (
                <div className="flex-1" />
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={
                  selectedTask ? labels.closeTaskDetails : labels.dismiss
                }
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => {
                  if (selectedTask) {
                    setLocalSelectedTaskId(null);
                    onCloseSecondary?.();
                    return;
                  }
                  onDismiss();
                }}
                className="-mr-1"
              >
                <X aria-hidden="true" className="size-3" />
              </Button>
            </header>

            {selectedTask ? (
              <div className="mt-0.5 flex min-h-32 flex-col">
                <h2 className="text-[12px] font-semibold">
                  {labels.tasks[selectedTask.id]}
                </h2>
                <p className="mt-1 whitespace-pre-line leading-5">
                  {labels.taskDetails[selectedTask.id]}
                </p>
                <Button
                  type="button"
                  onClick={() => {
                    if (!selectedTaskCompleted) onTaskToggle(selectedTask.id);
                    setLocalSelectedTaskId(null);
                    onBackHome();
                  }}
                  size="sm"
                  className="mt-5 self-start px-3"
                >
                  {labels.markDone}
                </Button>
              </div>
            ) : (
              <ul className="mt-2 space-y-0.5">
                {visibleTasks.map((task) => {
                  const label = labels.tasks[task.id];
                  const completed = isStarterTaskComplete(
                    completionState,
                    task.id,
                  );

                  return (
                    <li key={task.id}>
                      <div
                        className={cn(
                          "group/task grid min-h-7 w-full grid-cols-[16px_minmax(0,1fr)_16px] items-center gap-2 px-1 text-left text-[12px]",
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
                          onClick={() => {
                            onTaskSelect(task.id);
                            setLocalSelectedTaskId(task.id);
                          }}
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
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </section>
  );

  if (
    mode === "overlay" &&
    selectedTask?.id === "create-project" &&
    typeof document !== "undefined"
  ) {
    return createPortal(taskList, document.body);
  }

  return taskList;
}
