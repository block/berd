import type { Persona } from "@/shared/types/agents";
import { ResultRow } from "./ResultRow";

interface AgentResultRowProps {
  agent: Persona;
  ariaLabel: string;
  onSelect: (agentId: string) => void;
}

export function AgentResultRow({
  agent,
  ariaLabel,
  onSelect,
}: AgentResultRowProps) {
  return (
    <ResultRow
      title={agent.displayName}
      meta={agent.systemPrompt}
      ariaLabel={ariaLabel}
      onClick={() => onSelect(agent.id)}
    />
  );
}
