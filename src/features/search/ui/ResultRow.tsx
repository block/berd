import { cn } from "@/shared/lib/cn";

interface ResultRowProps {
  id?: string;
  title: string;
  meta: string;
  ariaLabel: string;
  isActive?: boolean;
  onActive?: () => void;
  onClick: () => void;
}

export function ResultRow({
  id,
  title,
  meta,
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
        "group flex w-full flex-col items-start gap-1 rounded-md px-4 py-3 text-left font-sans outline-none focus-visible:ring-1 focus-visible:ring-muted-foreground",
        isActive && "bg-muted",
      )}
    >
      <span className="line-clamp-2 w-full break-words text-[16px] leading-5 text-foreground group-hover:text-foreground group-active:opacity-70">
        {title}
      </span>
      <span className="line-clamp-2 w-full break-words text-[10px] leading-normal text-muted-foreground">
        {meta}
      </span>
    </button>
  );
}
