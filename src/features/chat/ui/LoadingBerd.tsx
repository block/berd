import { useTranslation } from "react-i18next";
import { motion, useReducedMotion } from "motion/react";
import {
  RESPONDING_SHIMMER_PROPS,
  Shimmer,
} from "@/shared/ui/ai-elements/shimmer";
import { cn } from "@/shared/lib/cn";

export type LoadingChatState =
  | "idle"
  | "thinking"
  | "streaming"
  | "waiting"
  | "compacting";

interface LoadingBerdProps {
  chatState?: LoadingChatState;
  className?: string;
  motionPreset?: "default" | "responding";
}

const LOADING_FADE_S = 0.45;
const DEFAULT_LOADING_SHIMMER_PROPS = {
  delay: 0.35,
  duration: 2.2,
  spread: 5,
  tone: "current",
} as const;

const MESSAGE_KEY_BY_STATE: Record<
  Exclude<LoadingChatState, "idle">,
  "thinking" | "responding" | "compacting"
> = {
  thinking: "thinking",
  streaming: "responding",
  waiting: "responding",
  compacting: "compacting",
};

export function LoadingBerd({
  chatState = "idle",
  className,
  motionPreset = "default",
}: LoadingBerdProps) {
  const { t } = useTranslation("chat");
  const shouldReduceMotion = useReducedMotion();
  if (chatState === "idle") {
    return null;
  }

  const message = t(`loading.${MESSAGE_KEY_BY_STATE[chatState]}`);

  return (
    <motion.div
      className={cn(
        "mb-3 flex min-h-4 items-center px-1 text-xs font-normal text-current",
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
          {...(motionPreset === "responding"
            ? RESPONDING_SHIMMER_PROPS
            : DEFAULT_LOADING_SHIMMER_PROPS)}
        >
          {message}
        </Shimmer>
      )}
    </motion.div>
  );
}
