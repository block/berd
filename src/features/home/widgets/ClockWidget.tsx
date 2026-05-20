import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocaleFormatting } from "@/shared/i18n";
import type { WidgetRenderProps } from "./types";

/**
 * ClockWidget — analog clock with day + date display.
 *
 * Always-dark face per Figma spec (uses --clock-face token, not the app theme
 * surface). Clock hands use --color-red-500 (primitive token: #ef4444).
 *
 * Accepts WidgetRenderProps for type compatibility with the catalog Component
 * field; none of those props are used by this display-only widget.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function ClockWidget(_props: WidgetRenderProps) {
  const { t } = useTranslation("home");
  const [time, setTime] = useState(new Date());
  const { formatDate } = useLocaleFormatting();

  useEffect(() => {
    const interval = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  const day = formatDate(time, { weekday: "short" })
    .replace(/\.$/, "")
    .toUpperCase();
  const date = formatDate(time, {
    month: "numeric",
    day: "numeric",
  });
  const currentLabel = `${t("widgets.clock.current")}: ${formatDate(time, {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })}`;
  const minuteAngle = time.getMinutes() * 6 + time.getSeconds() * 0.1;
  const hourAngle = ((time.getHours() % 12) + time.getMinutes() / 60) * 30;

  return (
    <section
      role="timer"
      aria-label={currentLabel}
      className="relative h-full w-full overflow-hidden rounded-full border border-white/10 bg-clock-face text-white"
    >
      <div aria-hidden="true" className="absolute inset-0">
        {/* Day label — left side */}
        <div className="absolute left-[16%] top-1/2 z-10 -translate-y-1/2 px-1 text-[30px] font-light leading-none tracking-normal">
          {day}
        </div>

        {/* Minute hand */}
        <div
          className="absolute inset-0 z-0"
          style={{ transform: `rotate(${minuteAngle}deg)` }}
        >
          <span className="absolute left-1/2 top-[9%] h-[41%] w-[2px] -translate-x-1/2 rounded-full bg-red-500" />
        </div>

        {/* Hour hand */}
        <div
          className="absolute inset-0 z-0"
          style={{ transform: `rotate(${hourAngle}deg)` }}
        >
          <span className="absolute left-1/2 top-[22%] h-[28%] w-[2px] -translate-x-1/2 rounded-full bg-red-500" />
        </div>

        {/* Center hub */}
        <div className="absolute left-1/2 top-1/2 z-40 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white" />

        {/* Date label — right side */}
        <div className="absolute right-[14%] top-1/2 z-10 -translate-y-1/2 px-1 text-[30px] font-light leading-none tracking-normal">
          {date}
        </div>
      </div>
    </section>
  );
}
