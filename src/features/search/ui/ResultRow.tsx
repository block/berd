import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";

interface ResultRowProps {
  id?: string;
  title: string;
  meta: ReactNode;
  query?: string;
  icon?: ReactNode;
  ariaLabel: string;
  isActive?: boolean;
  onActive?: () => void;
  onClick: () => void;
}

function highlightQuery(text: string, query?: string): ReactNode {
  const normalizedQuery = query?.trim();
  if (!normalizedQuery) return text;
  const index = text
    .toLocaleLowerCase()
    .indexOf(normalizedQuery.toLocaleLowerCase());
  if (index < 0) return text;
  return (
    <>
      {text.slice(0, index)}
      <mark className="rounded-[2px] bg-warning/10 px-0 text-inherit">
        {text.slice(index, index + normalizedQuery.length)}
      </mark>
      {text.slice(index + normalizedQuery.length)}
    </>
  );
}

function matchingContext(text: string, query?: string): string {
  const normalizedQuery = query?.trim();
  if (!normalizedQuery) return text;
  const index = text
    .toLocaleLowerCase()
    .indexOf(normalizedQuery.toLocaleLowerCase());
  if (index <= 36) return text;
  const excerptStart = Math.max(0, index - 28);
  return `…${text.slice(excerptStart).trimStart()}`;
}

export function ResultRow({
  id,
  title,
  meta,
  query,
  icon,
  ariaLabel,
  isActive = false,
  onActive,
  onClick,
}: ResultRowProps) {
  return (
    <button
      id={id}
      type="button"
      aria-label={ariaLabel}
      aria-current={isActive ? "true" : undefined}
      data-active={isActive ? "true" : undefined}
      onClick={onClick}
      onFocus={onActive}
      onMouseEnter={onActive}
      className={cn(
        "group -mx-1.5 flex w-[calc(100%+0.75rem)] items-start gap-3 rounded-[var(--radius-md)] p-1.5 text-left font-sans outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-1 focus-visible:ring-muted-foreground",
        isActive && "bg-muted/60",
      )}
    >
      {icon ? (
        <span className="flex size-12 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-muted text-foreground transition-colors duration-200 ease-out group-hover:bg-background group-focus-visible:bg-background [&_svg]:size-5">
          {icon}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 pr-3">
        <span className="line-clamp-2 block w-full break-words text-sm leading-5 text-foreground group-hover:text-foreground group-active:opacity-70">
          {highlightQuery(title, query)}
        </span>
        <span className="block w-full truncate text-sm leading-5 text-muted-foreground">
          {typeof meta === "string"
            ? highlightQuery(matchingContext(meta, query), query)
            : meta}
        </span>
      </span>
    </button>
  );
}
