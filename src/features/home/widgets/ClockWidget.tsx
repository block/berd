import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocaleFormatting } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import type { WidgetRenderProps } from "./types";

// Hour ticks at every 30° (12 marks). Minute ticks at every 6°, skipping the
// 12 hour positions (48 marks). Pre-computed at module load.
const HOUR_TICK_ANGLES = Array.from({ length: 12 }, (_, i) => i * 30);
const MINUTE_TICK_ANGLES = Array.from({ length: 60 }, (_, i) => i * 6).filter(
  (angle) => angle % 30 !== 0,
);

const CENTER_HUB_SIZE =
  "clamp(0.375rem, calc(0.5rem * var(--widget-scale, 1)), 0.875rem)";
const SECOND_HAND_DOT_SIZE =
  "clamp(0.5rem, calc(0.625rem * var(--widget-scale, 1)), 1rem)";

/** Hand reach/tail as % of widget height from center; second reach clears minute ticks (~5.5% from rim). */
const CLOCK_HAND_LENGTH = {
  hour: { reach: 26, tail: 6 },
  minute: { reach: 40, tail: 8 },
  second: { reach: 42, tail: 10 },
} as const;

type ClockHandProps = {
  angle: number;
  lengthPercent: number;
  tailPercent: number;
  colorClass: string;
  zIndex: number;
  dotAtTip?: boolean;
};

/** 1px hand centered on the face, extending past the hub on both sides. */
function ClockHand({
  angle,
  lengthPercent,
  tailPercent,
  colorClass,
  zIndex,
  dotAtTip = false,
}: ClockHandProps) {
  return (
    <div
      className="absolute inset-0"
      style={{ transform: `rotate(${angle}deg)`, zIndex }}
    >
      <span
        className={cn(
          "absolute left-1/2 top-1/2 w-px -translate-x-1/2",
          colorClass,
        )}
        style={{
          height: `${lengthPercent}%`,
          transform: "translateX(-50%) translateY(-100%)",
          transformOrigin: "bottom center",
        }}
      />
      <span
        className={cn("absolute left-1/2 top-1/2 w-px -translate-x-1/2", colorClass)}
        style={{
          height: `${tailPercent}%`,
          transformOrigin: "top center",
        }}
      />
      {dotAtTip ? (
        <span
          className="absolute left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-clock-hand"
          style={{
            top: `${50 - lengthPercent}%`,
            width: SECOND_HAND_DOT_SIZE,
            height: SECOND_HAND_DOT_SIZE,
          }}
        />
      ) : null}
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function ClockWidget(_props: WidgetRenderProps) {
  const { t } = useTranslation("home");
  const { formatDate } = useLocaleFormatting();
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const interval = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  const secondAngle = time.getSeconds() * 6;
  const minuteAngle = time.getMinutes() * 6 + time.getSeconds() * 0.1;
  const hourAngle = ((time.getHours() % 12) + time.getMinutes() / 60) * 30;

  const currentLabel = `${t("widgets.clock.current")}: ${formatDate(time, {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })}`;

  return (
    <section
      role="timer"
      aria-label={currentLabel}
      className="relative h-full w-full overflow-hidden rounded-full border border-clock-mark/5 bg-clock-face text-white"
    >
      <div aria-hidden="true" className="absolute inset-0">
        {HOUR_TICK_ANGLES.map((angle) => (
          <div
            key={`h-${angle}`}
            className="absolute inset-0"
            style={{ transform: `rotate(${angle}deg)` }}
          >
            <span className="absolute left-1/2 top-[2%] h-[8%] w-px -translate-x-1/2 bg-clock-mark" />
          </div>
        ))}

        {MINUTE_TICK_ANGLES.map((angle) => (
          <div
            key={`m-${angle}`}
            className="absolute inset-0"
            style={{ transform: `rotate(${angle}deg)` }}
          >
            <span className="absolute left-1/2 top-[3%] h-[2.5%] w-px -translate-x-1/2 bg-clock-mark/40" />
          </div>
        ))}

        <ClockHand
          angle={hourAngle}
          lengthPercent={CLOCK_HAND_LENGTH.hour.reach}
          tailPercent={CLOCK_HAND_LENGTH.hour.tail}
          colorClass="bg-clock-mark"
          zIndex={10}
        />

        <ClockHand
          angle={minuteAngle}
          lengthPercent={CLOCK_HAND_LENGTH.minute.reach}
          tailPercent={CLOCK_HAND_LENGTH.minute.tail}
          colorClass="bg-clock-minute-hand"
          zIndex={20}
        />

        <ClockHand
          angle={secondAngle}
          lengthPercent={CLOCK_HAND_LENGTH.second.reach}
          tailPercent={CLOCK_HAND_LENGTH.second.tail}
          colorClass="bg-clock-hand"
          zIndex={25}
          dotAtTip
        />

        <div
          className="absolute left-1/2 top-1/2 z-30 -translate-x-1/2 -translate-y-1/2 rounded-full bg-clock-mark"
          style={{
            width: CENTER_HUB_SIZE,
            height: CENTER_HUB_SIZE,
          }}
        />
      </div>
    </section>
  );
}
