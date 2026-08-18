import { AnimatePresence, motion } from "motion/react";
import { resolveAgentIcon } from "@/features/agents/lib/resolveAgentIcon";
import { AvatarVisual } from "@/shared/ui/avatar-visual";
import type { Persona } from "@/shared/types/agents";

/**
 * Resolves and renders a single persona's avatar media (or static fallback).
 * Kept as its own component so each persona instance owns its media hook,
 * which lets an outgoing avatar keep rendering correctly while it fades out.
 */
function PersonaAvatarMedia({ persona }: { persona: Persona }) {
  return (
    <AvatarVisual
      avatar={persona.avatar}
      loadingStrategy="eager"
      className="h-full w-full object-contain"
      fallback={
        <img
          aria-hidden="true"
          alt=""
          src={resolveAgentIcon(persona.id)}
          className="h-full w-full object-contain"
        />
      }
    />
  );
}

/**
 * Renders the selected agent's animated avatar above the empty-state
 * "Start a conversation" text. The avatar cross-fades when the selected agent
 * changes. Reduced-motion / animated-avatar preferences are handled internally
 * by AvatarMedia.
 */
export function ConversationEmptyAvatar({ persona }: { persona: Persona }) {
  return (
    <div className="relative size-40 shrink-0">
      <AnimatePresence>
        <motion.div
          key={persona.id}
          className="absolute inset-0"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25, ease: "easeInOut" }}
        >
          <PersonaAvatarMedia persona={persona} />
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
