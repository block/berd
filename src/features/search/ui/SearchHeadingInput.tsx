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
    isRaised,
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
      className="absolute left-10 z-10 w-[calc(100%-80px)] appearance-none border-0 bg-transparent font-sans text-[114px] font-light leading-[0.96] tracking-normal text-foreground shadow-none outline-none ring-0 transition-[top] duration-[250ms] ease-out placeholder:text-foreground placeholder:opacity-10 focus:border-0 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 motion-reduce:transition-none"
      style={{
        top: isRaised ? "var(--search-heading-raised-top)" : "calc(50% - 90px)",
        boxShadow: "none",
      }}
    />
  );
});
