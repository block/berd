import type { Persona } from "@/shared/types/agents";
import { ResultRow } from "./ResultRow";

interface AgentResultRowProps {
  id?: string;
  agent: Persona;
  ariaLabel: string;
  isActive?: boolean;
  onActive?: () => void;
  onSelect: (agentId: string) => void;
}

export function AgentResultRow({
  id,
  agent,
  ariaLabel,
  isActive,
  onActive,
  onSelect,
}: AgentResultRowProps) {
  return (
    <ResultRow
      id={id}
      title={agent.displayName}
      meta={agent.systemPrompt}
      ariaLabel={ariaLabel}
      isActive={isActive}
      onActive={onActive}
      onClick={() => onSelect(agent.id)}
    />
  );
}
