import { resolveAgentIcon } from "@/features/agents/lib/resolveAgentIcon";
import { getAgentShareCardBase } from "./agentShareCard";
import {
  HolographicAgentCard,
  holographicCardPresets,
} from "./HolographicAgentCard";

interface AgentShareCardPreviewProps {
  identity: string;
  displayName: string;
  description: string;
  avatarSrc?: string;
  alt: string;
}

export function AgentShareCardPreview({
  identity,
  displayName,
  description,
  avatarSrc,
  alt,
}: AgentShareCardPreviewProps) {
  return (
    <HolographicAgentCard
      src={getAgentShareCardBase(identity)}
      settings={holographicCardPresets.rainbowPrism}
      alt={alt}
    >
      <div className="absolute inset-x-[8%] top-[7%] bottom-[8%] flex flex-col text-center text-agent-share-card-ink">
        <h3 className="line-clamp-2 shrink-0 break-words pb-[0.08em] text-[clamp(1.5rem,5vw,2.6rem)] font-bold leading-[1.08] tracking-[-0.04em]">
          {displayName}
        </h3>
        <div className="flex min-h-0 flex-1 items-center justify-center px-[9%] py-[5%]">
          <img
            src={avatarSrc ?? resolveAgentIcon(identity)}
            alt=""
            aria-hidden="true"
            className="max-h-full max-w-full object-contain drop-shadow-xl"
          />
        </div>
        <p className="line-clamp-4 shrink-0 break-words text-center text-[12px] leading-snug">
          {description}
        </p>
      </div>
    </HolographicAgentCard>
  );
}
