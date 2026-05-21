import { useTranslation } from "react-i18next";
import { Skeleton } from "@/shared/ui/skeleton";

/**
 * Placeholder skeleton shown while session history is being replayed
 * from the backend. Mimics the visual rhythm of a real conversation
 * with alternating user/assistant message shapes.
 */
export function ChatLoadingSkeleton() {
  const { t } = useTranslation("chat");
  return (
    <div
      className="flex flex-1 items-start overflow-hidden"
      role="status"
      aria-label={t("skeleton.loadingConversation")}
    >
      <div className="mx-auto w-full max-w-3xl py-4 space-y-6 px-4">
        {/* Date separator skeleton */}
        <div className="flex items-center gap-3">
          <div className="h-px flex-1 bg-border/80" />
          <Skeleton className="h-3 w-16 rounded-pill" />
          <div className="h-px flex-1 bg-border/80" />
        </div>

        {/* User message */}
        <div className="flex justify-end">
          <div className="space-y-2 max-w-[70%]">
            <Skeleton className="h-4 w-64 rounded-card-sm" />
          </div>
        </div>

        {/* Assistant message — multi-line */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Skeleton className="size-6 rounded-pill" />
            <Skeleton className="h-3 w-14 rounded-pill" />
          </div>
          <div className="pl-8 space-y-2">
            <Skeleton className="h-4 w-full rounded-card-sm" />
            <Skeleton className="h-4 w-[85%] rounded-card-sm" />
            <Skeleton className="h-4 w-[60%] rounded-card-sm" />
          </div>
        </div>

        {/* User message */}
        <div className="flex justify-end">
          <div className="space-y-2 max-w-[70%]">
            <Skeleton className="h-4 w-48 rounded-card-sm" />
          </div>
        </div>

        {/* Assistant message — shorter */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Skeleton className="size-6 rounded-pill" />
            <Skeleton className="h-3 w-14 rounded-pill" />
          </div>
          <div className="pl-8 space-y-2">
            <Skeleton className="h-4 w-full rounded-card-sm" />
            <Skeleton className="h-4 w-[70%] rounded-card-sm" />
          </div>
        </div>

        {/* Tool call block */}
        <div className="pl-8">
          <Skeleton className="h-10 w-[50%] rounded-card-sm" />
        </div>

        {/* Assistant continuation */}
        <div className="pl-8 space-y-2">
          <Skeleton className="h-4 w-full rounded-card-sm" />
          <Skeleton className="h-4 w-[45%] rounded-card-sm" />
        </div>
      </div>
    </div>
  );
}
