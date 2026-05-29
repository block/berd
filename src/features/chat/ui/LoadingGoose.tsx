import { useTranslation } from "react-i18next";
import { motion, useReducedMotion } from "motion/react";
import { Shimmer } from "@/shared/ui/ai-elements/shimmer";
import { cn } from "@/shared/lib/cn";

export type LoadingChatState =
  | "idle"
  | "thinking"
  | "streaming"
  | "waiting"
  | "compacting";

interface LoadingGooseProps {
  chatState?: LoadingChatState;
  className?: string;
}

const LOADING_FADE_S = 0.45;
const LOADING_SHIMMER_S = 2.2;
const LOADING_SHIMMER_SPREAD = 5;
const LOADING_SHIMMER_DELAY_S = 0.35;

const MESSAGE_KEY_BY_STATE: Record<
  Exclude<LoadingChatState, "idle">,
  "thinking" | "responding" | "compacting"
> = {
  thinking: "thinking",
  streaming: "responding",
  waiting: "responding",
  compacting: "compacting",
};

export function LoadingGoose({
  chatState = "idle",
  className,
}: LoadingGooseProps) {
  const { t } = useTranslation("chat");
  const shouldReduceMotion = useReducedMotion();
  if (chatState === "idle") {
    return null;
  }

  const message = t(`loading.${MESSAGE_KEY_BY_STATE[chatState]}`);

  return (
    <motion.div
      className={cn(
        "mb-3 flex min-h-4 items-center px-1 text-xs text-muted-foreground",
        className,
      )}
      role="status"
      aria-label={message}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: shouldReduceMotion ? 0 : LOADING_FADE_S }}
    >
      {shouldReduceMotion ? (
        <span>{message}</span>
      ) : (
        <Shimmer
          as="span"
          className="text-xs"
          tone="strong"
          delay={LOADING_SHIMMER_DELAY_S}
          duration={LOADING_SHIMMER_S}
          spread={LOADING_SHIMMER_SPREAD}
        >
          {message}
        </Shimmer>
      )}
    </motion.div>
  );
}
