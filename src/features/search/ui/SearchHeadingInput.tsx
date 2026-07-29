import { forwardRef } from "react";
import type { KeyboardEvent } from "react";

interface SearchHeadingInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
  activeDescendant?: string | null;
  controlsId?: string;
  isRaised: boolean;
  variant?: "page" | "dialog";
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
}

export const SearchHeadingInput = forwardRef<
  HTMLInputElement,
  SearchHeadingInputProps
>(function SearchHeadingInput(
  {
    value,
    onChange,
    placeholder,
    ariaLabel,
    activeDescendant,
    controlsId,
    variant = "page",
    onKeyDown,
  },
  ref,
) {
  return (
    <input
      ref={ref}
      type="text"
      aria-label={ariaLabel}
      aria-activedescendant={activeDescendant ?? undefined}
      aria-controls={controlsId}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      autoCorrect="off"
      autoCapitalize="none"
      spellCheck={false}
      className={
        variant === "dialog"
          ? "h-12 w-full appearance-none border-0 border-b border-border bg-transparent pl-8 pr-8 font-sans text-sm font-normal text-foreground shadow-none outline-none ring-0 placeholder:text-muted-foreground focus:border-border focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0"
          : "absolute left-8 top-5 z-10 h-12 w-[calc(100%-64px)] appearance-none border-0 border-b border-border bg-transparent pl-10 font-sans text-xl font-normal tracking-normal text-foreground shadow-none outline-none ring-0 placeholder:text-muted-foreground focus:border-border focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0"
      }
      style={{ boxShadow: "none" }}
    />
  );
});
