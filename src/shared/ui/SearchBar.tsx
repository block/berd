import type * as React from "react";
import { Search } from "lucide-react";
import { cn } from "@/shared/lib/cn";
import { Input } from "@/shared/ui/input";

const searchBarSizes = {
  compact: {
    wrapper:
      "rounded-sm border border-border/80 px-2 py-1 text-xs text-muted-foreground hover:bg-transparent hover:text-foreground",
    icon: "left-2.5 size-3",
    input:
      "h-auto border-none bg-transparent px-0 pl-7 pr-0 text-[11px] font-normal shadow-none focus-visible:border-transparent focus-visible:ring-0 focus-visible:ring-offset-0",
    inputVariant: "ghost" as const,
    hideIcon: false,
  },
  small: {
    wrapper:
      "rounded-sm border border-border/80 px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-transparent hover:text-foreground",
    icon: "left-3 size-3.5",
    input:
      "h-auto border-none bg-transparent px-0 pl-6 pr-0 text-xs font-normal shadow-none focus-visible:border-transparent focus-visible:ring-0 focus-visible:ring-offset-0",
    inputVariant: "ghost" as const,
    hideIcon: false,
  },
  picker: {
    wrapper:
      "rounded-sm border border-transparent bg-accent px-0 text-muted-foreground hover:bg-accent focus-within:bg-accent",
    icon: "left-2 size-3.5",
    input:
      "h-auto min-w-0 appearance-none border-none bg-transparent px-0 pr-8 pl-8 text-sm font-normal shadow-none focus-visible:border-transparent focus-visible:ring-0 focus-visible:ring-offset-0 [&::-webkit-search-cancel-button]:hidden",
    inputVariant: "ghost" as const,
    hideIcon: false,
  },
  default: {
    wrapper: "",
    icon: "left-3 size-4",
    input:
      "rounded-sm border-border/80 bg-background pr-3 pl-9 text-sm font-normal hover:border-border/80 focus-visible:border-ring",
    inputVariant: "default" as const,
    hideIcon: false,
  },
  pill: {
    wrapper: "flex items-center rounded-full bg-muted px-4 py-2.5",
    icon: "",
    input:
      "h-auto appearance-none border-none bg-transparent px-0 text-sm font-normal leading-none text-foreground shadow-none focus-visible:border-transparent focus-visible:ring-0 focus-visible:ring-offset-0 placeholder:text-foreground! placeholder:opacity-40",
    inputVariant: "ghost" as const,
    hideIcon: true,
  },
  "pill-card": {
    wrapper:
      "flex h-[30px] items-center rounded-full bg-card pl-3 pr-4 ring-1 ring-transparent transition-shadow focus-within:ring-ring",
    icon: "left-3 size-4",
    input:
      "h-auto appearance-none border-none bg-transparent px-0 pl-5 text-sm font-normal leading-none text-foreground shadow-none focus-visible:border-transparent focus-visible:ring-0 focus-visible:ring-offset-0 placeholder:text-foreground! placeholder:opacity-40 [&::-webkit-search-cancel-button]:hidden",
    inputVariant: "ghost" as const,
    hideIcon: false,
  },
} as const;

interface SearchBarProps {
  /** Current search value (controlled) */
  value: string;
  /** Called when the search term changes */
  onChange: (term: string) => void;
  /** Placeholder text */
  placeholder?: string;
  /** Optional keydown handler for the input */
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  /** Optional className for the wrapper */
  className?: string;
  /** Size variant for the search field */
  size?: keyof typeof searchBarSizes;
  /** Optional ref for the underlying input */
  inputRef?: React.Ref<HTMLInputElement>;
  /** Accessible label for the search input */
  "aria-label"?: string;
}

export function SearchBar({
  value,
  onChange,
  placeholder,
  onKeyDown,
  className,
  size = "default",
  inputRef,
  "aria-label": ariaLabel,
}: SearchBarProps) {
  const styles = searchBarSizes[size];

  return (
    <div className={cn("relative w-full", styles.wrapper, className)}>
      {!styles.hideIcon && (
        <Search
          className={cn(
            "pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted-foreground",
            styles.icon,
          )}
        />
      )}
      <Input
        inputRef={inputRef}
        variant={styles.inputVariant}
        type="search"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className={cn("w-full placeholder:text-muted-foreground", styles.input)}
      />
    </div>
  );
}
