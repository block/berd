import { cn } from "@/shared/lib/cn";

interface SpinnerProps extends React.ComponentProps<"svg"> {
  /**
   * When true, marks the spinner as purely decorative:
   * sets `role="none"`, `aria-hidden="true"`, and removes the label.
   */
  decorative?: boolean;
}

function Spinner({
  className,
  style,
  decorative = false,
  role = decorative ? "none" : "status",
  "aria-label": ariaLabel = decorative ? undefined : "Loading",
  "aria-hidden": ariaHidden = decorative ? true : undefined,
  ...rest
}: SpinnerProps) {
  return (
    <svg
      role={role}
      aria-label={ariaLabel}
      aria-hidden={ariaHidden}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("size-4", className)}
      style={{
        backfaceVisibility: "hidden",
        overflow: "visible",
        ...style,
      }}
      {...rest}
    >
      <g>
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 12 12"
          to="360 12 12"
          dur="1s"
          repeatCount="indefinite"
        />
      </g>
    </svg>
  );
}

export { Spinner };
