export type CapabilityRenderMode = string;

export interface CapabilityDescriptor<
  RenderMode extends CapabilityRenderMode = CapabilityRenderMode,
> {
  id: string;
  name: string;
  description: string;
  owningFeature: string;
  renderModes: readonly RenderMode[];
  requiredContext: readonly string[];
  states: readonly string[];
  actions: readonly string[];
}
