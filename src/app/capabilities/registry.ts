import type { CapabilityDescriptor } from "./types";
import { agentBuilderCapabilityDescriptor } from "@/features/agents/capabilities/agentBuilderCapabilityDescriptor";
import { terminalCapabilityDescriptor } from "@/features/terminal/capabilities/terminalCapabilityDescriptor";

export const CAPABILITY_REGISTRY = [
  agentBuilderCapabilityDescriptor,
  terminalCapabilityDescriptor,
] as const satisfies readonly CapabilityDescriptor[];

export type RegisteredCapabilityId = (typeof CAPABILITY_REGISTRY)[number]["id"];

export function getCapabilityDescriptor(
  id: RegisteredCapabilityId,
): CapabilityDescriptor | undefined {
  return CAPABILITY_REGISTRY.find((capability) => capability.id === id);
}
