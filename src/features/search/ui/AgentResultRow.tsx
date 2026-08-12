import { Bot } from "lucide-react";
import type { Persona } from "@/shared/types/agents";
import { ResultRow } from "./ResultRow";

interface AgentResultRowProps {
  id?: string;
  agent: Persona;
  ariaLabel: string;
  query?: string;
  isActive?: boolean;
  onActive?: () => void;
  onSelect: (agentId: string) => void;
}

export function AgentResultRow({
  id,
  agent,
  ariaLabel,
  query,
  isActive,
  onActive,
  onSelect,
}: AgentResultRowProps) {
  return (
    <ResultRow
      id={id}
      title={agent.displayName}
      meta={agent.systemPrompt}
      icon={<Bot aria-hidden="true" />}
      ariaLabel={ariaLabel}
      query={query}
      isActive={isActive}
      onActive={onActive}
      onClick={() => onSelect(agent.id)}
    />
  );
}
