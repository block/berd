import { cn } from "@/shared/lib/cn";

export function ToolDetailSection({
  label,
  value,
  destructive = false,
}: {
  label: string;
  value: string | null;
  destructive?: boolean;
}) {
  if (!value || value.trim().length === 0) return null;

  return (
    <section className="space-y-1.5">
      <div className="text-xs font-normal text-muted-foreground">{label}</div>
      <div
        className={cn(
          "rounded-sm bg-muted/30 px-3 py-2 text-muted-foreground",
          destructive && "text-destructive",
        )}
      >
        <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-current">
          {value}
        </pre>
      </div>
    </section>
  );
}
