import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocaleFormatting } from "@/shared/i18n";
import type { WidgetRenderProps } from "./types";

// Hour ticks at every 30° (12 marks). Minute ticks at every 6°, skipping the
// 12 hour positions (48 marks). Pre-computed at module load.
const HOUR_TICK_ANGLES = Array.from({ length: 12 }, (_, i) => i * 30);
const MINUTE_TICK_ANGLES = Array.from({ length: 60 }, (_, i) => i * 6).filter(
  (angle) => angle % 30 !== 0,
);

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function ClockWidget(_props: WidgetRenderProps) {
  const { t } = useTranslation("home");
  const { formatDate } = useLocaleFormatting();
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const interval = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

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
      className="relative h-full w-full overflow-hidden rounded-full border border-white/5 bg-clock-face text-white"
    >
      <div aria-hidden="true" className="absolute inset-0">
        {HOUR_TICK_ANGLES.map((angle) => (
          <div
            key={`h-${angle}`}
            className="absolute inset-0"
            style={{ transform: `rotate(${angle}deg)` }}
          >
            <span className="absolute left-1/2 top-[2%] h-[8%] w-[2px] -translate-x-1/2 rounded-full bg-white" />
          </div>
        ))}

        {MINUTE_TICK_ANGLES.map((angle) => (
          <div
            key={`m-${angle}`}
            className="absolute inset-0"
            style={{ transform: `rotate(${angle}deg)` }}
          >
            <span className="absolute left-1/2 top-[3%] h-[2.5%] w-[1px] -translate-x-1/2 rounded-full bg-white/40" />
          </div>
        ))}

        {/* Hour hand — white, stubby (Mondaine proportions). */}
        <div
          className="absolute inset-0 z-10"
          style={{ transform: `rotate(${hourAngle}deg)` }}
        >
          <span className="absolute left-1/2 top-[26%] h-[26%] w-[3px] -translate-x-1/2 rounded-full bg-white" />
        </div>

        {/* Minute hand — red with circular dot at tip (Swiss railway accent). */}
        <div
          className="absolute inset-0 z-20"
          style={{ transform: `rotate(${minuteAngle}deg)` }}
        >
          <span className="absolute left-1/2 top-[10%] h-[42%] w-[3px] -translate-x-1/2 rounded-full bg-clock-hand" />
          <span
            className="absolute left-1/2 top-[10%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-clock-hand"
            style={{
              width:
                "clamp(0.5rem, calc(0.625rem * var(--widget-scale, 1)), 1rem)",
              height:
                "clamp(0.5rem, calc(0.625rem * var(--widget-scale, 1)), 1rem)",
            }}
          />
        </div>

        {/* Center hub */}
        <div
          className="absolute left-1/2 top-1/2 z-30 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white"
          style={{
            width:
              "clamp(0.375rem, calc(0.5rem * var(--widget-scale, 1)), 0.875rem)",
            height:
              "clamp(0.375rem, calc(0.5rem * var(--widget-scale, 1)), 0.875rem)",
          }}
        />
      </div>
    </section>
  );
}
