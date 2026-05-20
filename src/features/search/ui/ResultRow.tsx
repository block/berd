interface ResultRowProps {
  title: string;
  meta: string;
  ariaLabel: string;
  onClick: () => void;
}

export function ResultRow({ title, meta, ariaLabel, onClick }: ResultRowProps) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      className="group flex w-[222px] flex-col items-start gap-1 text-left font-sans outline-none focus-visible:ring-1 focus-visible:ring-muted-foreground"
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
