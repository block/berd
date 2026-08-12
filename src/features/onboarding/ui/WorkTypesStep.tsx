import {
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import Matter from "matter-js";
import { useTranslation } from "react-i18next";
import { useReducedMotion } from "motion/react";
import { Button } from "@/shared/ui/button";
import { cn } from "@/shared/lib/cn";
import { WORK_TYPES, type WorkTypeId } from "../model";
import { OnboardingShell } from "./OnboardingShell";

interface WorkTypesStepProps {
  selectedIds: readonly string[];
  onToggle: (id: WorkTypeId) => void;
  onBack: () => void;
  onNext: () => void;
}

const PILL_HEIGHT = 76;
const STACK_GAP = 8;
const MIN_PILL_SCALE = 0.68;
const STACK_VERTICAL_INSET = 16;
const STACK_HEIGHT =
  WORK_TYPES.length * PILL_HEIGHT + (WORK_TYPES.length - 1) * STACK_GAP;
// The shell's content region already ends above the CTA. This inset leaves a
// little visual breathing room between the physics floor and the button zone.
const CTA_CLEARANCE = 16;
const PILL_WIDTHS: Record<WorkTypeId, number> = {
  engineering: 302,
  legal: 190,
  marketing: 270,
  product: 232,
  design: 216,
  writing: 220,
  "not-sure": 240,
};

interface DragState {
  body: Matter.Body;
  constraint: Matter.Constraint;
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  lastTime: number;
  velocityX: number;
  velocityY: number;
  moved: boolean;
}

export function WorkTypesStep({
  selectedIds,
  onToggle,
  onBack,
  onNext,
}: WorkTypesStepProps) {
  const { t } = useTranslation("onboarding");
  const reduceMotion = useReducedMotion();
  // Entering this step always begins as the still stack. Physics belongs to
  // this visit and starts only when the user interacts with an option.
  const [fallen, setFallen] = useState(false);
  const [stackScale, setStackScale] = useState(1);
  const areaRef = useRef<HTMLDivElement>(null);
  const pillRefs = useRef(new Map<WorkTypeId, HTMLButtonElement>());
  const engineRef = useRef<Matter.Engine | null>(null);
  const bodiesRef = useRef(new Map<WorkTypeId, Matter.Body>());
  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef<{
    target: HTMLButtonElement;
    timeout: number;
  } | null>(null);

  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area || fallen) return;
    const updateScale = () => {
      const availableHeight = Math.max(
        0,
        area.clientHeight - STACK_VERTICAL_INSET * 2,
      );
      setStackScale(
        Math.min(1, Math.max(MIN_PILL_SCALE, availableHeight / STACK_HEIGHT)),
      );
    };
    updateScale();
    const observer = new ResizeObserver(updateScale);
    observer.observe(area);
    return () => observer.disconnect();
  }, [fallen]);

  useLayoutEffect(() => {
    if (!fallen || reduceMotion || !areaRef.current) return;
    const area = areaRef.current;
    let width = area.clientWidth;
    let height = area.clientHeight;
    const scaledPillHeight = PILL_HEIGHT * stackScale;
    const scaledGap = STACK_GAP * stackScale;
    const scaledStackHeight = STACK_HEIGHT * stackScale;
    const stackTop = (height - scaledStackHeight) / 2;
    const engine = Matter.Engine.create({ gravity: { x: 0, y: 1.65 } });
    engineRef.current = engine;

    // Bodies begin at the exact center of their rendered stack positions. The
    // first physics frame therefore continues from the list instead of
    // teleporting every pill back to a shared spawn point.
    const bodies = WORK_TYPES.map((item, index) => {
      const pillWidth = PILL_WIDTHS[item.id] * stackScale;
      const body = Matter.Bodies.rectangle(
        width / 2,
        stackTop +
          index * (scaledPillHeight + scaledGap) +
          scaledPillHeight / 2,
        pillWidth,
        scaledPillHeight,
        {
          chamfer: { radius: scaledPillHeight / 2 },
          restitution: 0.22,
          friction: 0.58,
          frictionAir: 0.012,
          label: item.id,
        },
      );
      bodiesRef.current.set(item.id, body);
      return body;
    });
    const boundaryThickness = 80;
    let floorY = height - CTA_CLEARANCE;
    const floor = Matter.Bodies.rectangle(
      width / 2,
      floorY + boundaryThickness / 2,
      width + boundaryThickness * 2,
      boundaryThickness,
      { isStatic: true },
    );
    const ceiling = Matter.Bodies.rectangle(
      width / 2,
      -boundaryThickness / 2,
      width + boundaryThickness * 2,
      boundaryThickness,
      { isStatic: true },
    );
    const leftWall = Matter.Bodies.rectangle(
      -boundaryThickness / 2,
      floorY / 2,
      boundaryThickness,
      floorY + boundaryThickness * 2,
      { isStatic: true },
    );
    const rightWall = Matter.Bodies.rectangle(
      width + boundaryThickness / 2,
      floorY / 2,
      boundaryThickness,
      floorY + boundaryThickness * 2,
      { isStatic: true },
    );
    Matter.Composite.add(engine.world, [
      ...bodies,
      floor,
      ceiling,
      leftWall,
      rightWall,
    ]);

    const sync = () => {
      for (const item of WORK_TYPES) {
        const body = bodiesRef.current.get(item.id);
        const node = pillRefs.current.get(item.id);
        if (!body || !node) continue;

        // Walls handle normal collisions. This final bounds correction also
        // prevents a very fast fling from tunneling through a wall between
        // Matter updates.
        let correctionX = 0;
        let correctionY = 0;
        if (body.bounds.min.x < 0) correctionX = -body.bounds.min.x;
        else if (body.bounds.max.x > width)
          correctionX = width - body.bounds.max.x;
        if (body.bounds.min.y < 0) correctionY = -body.bounds.min.y;
        else if (body.bounds.max.y > floorY)
          correctionY = floorY - body.bounds.max.y;
        if (correctionX !== 0 || correctionY !== 0) {
          Matter.Body.translate(body, { x: correctionX, y: correctionY });
          Matter.Body.setVelocity(body, {
            x: correctionX === 0 ? body.velocity.x : 0,
            y: correctionY === 0 ? body.velocity.y : 0,
          });
        }

        node.style.transform = `translate(${body.position.x - (PILL_WIDTHS[item.id] * stackScale) / 2}px, ${body.position.y - scaledPillHeight / 2}px) rotate(${body.angle}rad)`;
      }
    };
    sync();
    Matter.Events.on(engine, "afterUpdate", sync);
    const resizeObserver = new ResizeObserver(() => {
      width = area.clientWidth;
      height = area.clientHeight;
      floorY = height - CTA_CLEARANCE;
      Matter.Body.setPosition(floor, {
        x: width / 2,
        y: floorY + boundaryThickness / 2,
      });
      Matter.Body.setPosition(ceiling, {
        x: width / 2,
        y: -boundaryThickness / 2,
      });
      Matter.Body.setPosition(leftWall, {
        x: -boundaryThickness / 2,
        y: floorY / 2,
      });
      Matter.Body.setPosition(rightWall, {
        x: width + boundaryThickness / 2,
        y: floorY / 2,
      });
    });
    resizeObserver.observe(area);

    const runner = Matter.Runner.create();
    // Wait until the DOM has painted in its exact static-stack position before
    // advancing physics. This also lets React's development effect probe clean
    // up without briefly running a throwaway engine and causing a visible
    // one-frame jitter.
    const startFrame = requestAnimationFrame(() => {
      for (const [index, item] of WORK_TYPES.entries()) {
        const body = bodiesRef.current.get(item.id);
        if (!body) continue;
        Matter.Body.setVelocity(body, {
          x: (index % 2 === 0 ? -1 : 1) * (1.2 + index * 0.14),
          y: 1.1,
        });
        Matter.Body.setAngularVelocity(
          body,
          (index % 2 === 0 ? -1 : 1) * (0.014 + index * 0.002),
        );
      }
      Matter.Runner.run(runner, engine);
    });

    return () => {
      cancelAnimationFrame(startFrame);
      resizeObserver.disconnect();
      Matter.Events.off(engine, "afterUpdate", sync);
      Matter.Runner.stop(runner);
      Matter.Engine.clear(engine);
      engineRef.current = null;
      bodiesRef.current.clear();
      dragRef.current = null;
      if (suppressClickRef.current) {
        window.clearTimeout(suppressClickRef.current.timeout);
        suppressClickRef.current = null;
      }
    };
  }, [fallen, reduceMotion, stackScale]);

  const pointerInArea = (event: ReactPointerEvent) => {
    const bounds = areaRef.current?.getBoundingClientRect();
    return {
      x: event.clientX - (bounds?.left ?? 0),
      y: event.clientY - (bounds?.top ?? 0),
    };
  };

  const handlePointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
    id: WorkTypeId,
  ) => {
    const engine = engineRef.current;
    const body = bodiesRef.current.get(id);
    if (!fallen || reduceMotion || !engine || !body) return;

    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointerInArea(event);
    const localPoint = Matter.Vector.rotate(
      Matter.Vector.sub(point, body.position),
      -body.angle,
    );
    const constraint = Matter.Constraint.create({
      pointA: point,
      bodyB: body,
      pointB: localPoint,
      stiffness: 0.16,
      damping: 0.08,
      length: 0,
    });
    Matter.Sleeping.set(body, false);
    Matter.Composite.add(engine.world, constraint);
    dragRef.current = {
      body,
      constraint,
      pointerId: event.pointerId,
      startX: point.x,
      startY: point.y,
      lastX: point.x,
      lastY: point.y,
      lastTime: event.timeStamp,
      velocityX: 0,
      velocityY: 0,
      moved: false,
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = pointerInArea(event);
    const elapsed = Math.max(8, event.timeStamp - drag.lastTime);
    drag.velocityX = ((point.x - drag.lastX) / elapsed) * 16.67;
    drag.velocityY = ((point.y - drag.lastY) / elapsed) * 16.67;
    drag.lastX = point.x;
    drag.lastY = point.y;
    drag.lastTime = event.timeStamp;
    drag.constraint.pointA = point;
    drag.moved ||= Math.hypot(point.x - drag.startX, point.y - drag.startY) > 6;
  };

  const releaseDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    completedPointerSequence: boolean,
  ) => {
    const drag = dragRef.current;
    const engine = engineRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !engine) return;
    Matter.Composite.remove(engine.world, drag.constraint);
    if (drag.moved) {
      Matter.Body.setVelocity(drag.body, {
        x: Math.max(-28, Math.min(28, drag.velocityX)),
        y: Math.max(-28, Math.min(28, drag.velocityY)),
      });
      if (completedPointerSequence) {
        if (suppressClickRef.current) {
          window.clearTimeout(suppressClickRef.current.timeout);
        }
        const target = event.currentTarget;
        suppressClickRef.current = {
          target,
          timeout: window.setTimeout(() => {
            suppressClickRef.current = null;
          }, 0),
        };
      }
    }
    dragRef.current = null;
  };

  return (
    <OnboardingShell
      onBack={onBack}
      title={t("workTypes.title")}
      description={
        <>
          {t("workTypes.descriptionLine1")}
          <br />
          {t("workTypes.descriptionLine2")}
        </>
      }
      actions={
        <Button
          type="button"
          onClick={onNext}
          disabled={selectedIds.length === 0}
        >
          {t("workTypes.next")}
        </Button>
      }
    >
      <div
        ref={areaRef}
        className="relative mx-auto h-full min-h-[427px] w-full max-w-[720px] touch-none select-none"
      >
        {WORK_TYPES.map((item, index) => (
          <button
            key={item.id}
            ref={(node) => {
              if (node) pillRefs.current.set(item.id, node);
              else pillRefs.current.delete(item.id);
            }}
            type="button"
            aria-pressed={selectedIds.includes(item.id)}
            onClick={(event) => {
              if (suppressClickRef.current?.target === event.currentTarget) {
                window.clearTimeout(suppressClickRef.current.timeout);
                suppressClickRef.current = null;
                return;
              }
              onToggle(item.id);
              // Pointer users get the playful physics interaction. Keyboard
              // users keep the stable list so visual and focus order agree.
              if (event.detail > 0 && !reduceMotion) setFallen(true);
            }}
            onPointerDown={(event) => handlePointerDown(event, item.id)}
            onPointerMove={handlePointerMove}
            onPointerUp={(event) => releaseDrag(event, true)}
            onPointerCancel={(event) => releaseDrag(event, false)}
            className={cn(
              "absolute z-10 flex cursor-grab items-center justify-center rounded-full transition-[color,background-color] focus-visible:outline-2 focus-visible:outline-offset-2 active:cursor-grabbing",
              selectedIds.includes(item.id)
                ? "bg-info text-info-foreground"
                : "bg-primary text-primary-foreground",
              !fallen && "left-1/2 -translate-x-1/2",
            )}
            style={{
              width: PILL_WIDTHS[item.id] * stackScale,
              height: PILL_HEIGHT * stackScale,
              fontSize: 40 * stackScale,
              ...(fallen
                ? { left: 0, top: 0 }
                : {
                    top: `calc(50% - ${(STACK_HEIGHT * stackScale) / 2}px + ${index * (PILL_HEIGHT + STACK_GAP) * stackScale}px)`,
                  }),
            }}
          >
            {t(`workTypes.items.${item.id}.label`)}
          </button>
        ))}
      </div>
    </OnboardingShell>
  );
}
