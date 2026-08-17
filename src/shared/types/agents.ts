// Provider types map to goose serve provider names.
// The provider list is dynamic, so this remains a plain string rather than
// a narrow union.
export type ProviderType = string;

// Avatar values are stored directly in ACP source properties as either
// credential-free http(s) URLs or app-managed refs like app-avatar:gloopy-1.
export type Avatar = string;

// Persona types (from sprout)
export interface Persona {
  id: string;
  displayName: string;
  avatar?: Avatar | null;
  systemPrompt: string;
  provider?: ProviderType;
  modelProviderId?: string;
  model?: string;
  isBuiltin: boolean;
  writable: boolean;
  sourceDescription?: string;
  sourceProperties?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreatePersonaRequest {
  displayName: string;
  description?: string;
  avatar?: Avatar | null;
  systemPrompt: string;
  provider?: ProviderType;
  modelProviderId?: string;
  model?: string;
}

export interface UpdatePersonaRequest {
  displayName?: string;
  description?: string;
  avatar?: Avatar | null;
  systemPrompt?: string;
  provider?: ProviderType | null;
  modelProviderId?: string | null;
  model?: string | null;
}

// Agent types
export type AgentStatus = "online" | "offline" | "starting" | "error";
export type AgentConnectionType = "builtin" | "acp";

export interface Agent {
  id: string;
  name: string;
  personaId?: string;
  persona?: Persona;
  provider: ProviderType;
  model: string;
  systemPrompt?: string;
  connectionType: AgentConnectionType;
  status: AgentStatus;
  isBuiltin: boolean;
  acpEndpoint?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAgentRequest {
  name: string;
  personaId?: string;
  provider: ProviderType;
  model: string;
  systemPrompt?: string;
  connectionType: AgentConnectionType;
  acpEndpoint?: string;
}

// Session, TokenState, and ChatState are defined in ./chat.ts
