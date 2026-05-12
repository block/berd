import { invoke } from "@tauri-apps/api/core";
import type { SourceEntry } from "@aaif/goose-sdk";
import { getClient } from "@/shared/api/acpConnection";
import type {
  Persona,
  CreatePersonaRequest,
  UpdatePersonaRequest,
  Avatar,
} from "@/shared/types/agents";
import { normalizeAvatarUrl } from "@/shared/lib/avatarUrl";

const AGENT_SOURCE_TYPE = "agent" as const;
const AGENT_DESCRIPTION = "Agent";

type AgentSourceProperties = {
  [key: string]: unknown;
  provider?: string | null;
  model?: string | null;
  avatar?: string | null;
};

type AgentSourceEntry = SourceEntry & {
  type: typeof AGENT_SOURCE_TYPE;
};

function isAgentSource(source: SourceEntry): source is AgentSourceEntry {
  return source.type === AGENT_SOURCE_TYPE;
}

function avatarToProperty(
  avatar: Avatar | null | undefined,
): string | null | undefined {
  if (avatar === undefined) {
    return undefined;
  }
  if (avatar === null) {
    return null;
  }
  return normalizeAvatarUrl(avatar);
}

function propertyToAvatar(value: unknown): Avatar | null {
  return normalizeAvatarUrl(value) ?? null;
}

function propertyToString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function personaProperties(
  request: CreatePersonaRequest,
): AgentSourceProperties {
  const properties: AgentSourceProperties = {};
  if (request.provider) properties.provider = request.provider;
  if (request.model) properties.model = request.model;

  const avatar = avatarToProperty(request.avatar);
  if (avatar) properties.avatar = avatar;

  return properties;
}

function applyOptionalProperty(
  properties: AgentSourceProperties,
  key: keyof Pick<AgentSourceProperties, "provider" | "model" | "avatar">,
  value: string | null | undefined,
): void {
  if (value === undefined) {
    return;
  }

  if (value === null || value.length === 0) {
    properties[key] = null;
    return;
  }

  properties[key] = value;
}

function mergedPersonaProperties(
  existing: Record<string, unknown> | undefined,
  request: UpdatePersonaRequest,
): AgentSourceProperties {
  const properties: AgentSourceProperties = { ...(existing ?? {}) };

  applyOptionalProperty(properties, "provider", request.provider);
  applyOptionalProperty(properties, "model", request.model);
  applyOptionalProperty(properties, "avatar", avatarToProperty(request.avatar));

  return properties;
}
function isSupportedImportFile(fileName: string): boolean {
  return (
    fileName.endsWith(".agent.json") ||
    fileName.endsWith(".persona.json") ||
    fileName.endsWith(".json")
  );
}

function legacyAvatarToProperty(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizeAvatarUrl(value);
  }

  if (typeof value === "object" && value !== null && "value" in value) {
    const avatar = value as { type?: unknown; value?: unknown };
    if (avatar.type === "url") {
      return normalizeAvatarUrl(avatar.value);
    }
  }

  return undefined;
}

function readImportJson(raw: string): {
  parsed: Record<string, unknown>;
} {
  try {
    return { parsed: JSON.parse(raw) as Record<string, unknown> };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid persona JSON: ${message}`);
  }
}

function validateLegacyPersonaImport(parsed: Record<string, unknown>): void {
  if (parsed.version !== 1) {
    throw new Error(
      `Unsupported persona format version ${String(parsed.version)}. Expected version 1.`,
    );
  }

  if (typeof parsed.displayName !== "string" || !parsed.displayName.trim()) {
    throw new Error("Persona displayName cannot be empty");
  }

  if (typeof parsed.systemPrompt !== "string" || !parsed.systemPrompt.trim()) {
    throw new Error("Persona systemPrompt cannot be empty");
  }
}

function legacyPersonaProperties(
  parsed: Record<string, unknown>,
): AgentSourceProperties {
  const properties: AgentSourceProperties = {};
  applyOptionalProperty(
    properties,
    "provider",
    propertyToString(parsed.provider),
  );
  applyOptionalProperty(properties, "model", propertyToString(parsed.model));
  applyOptionalProperty(
    properties,
    "avatar",
    legacyAvatarToProperty(parsed.avatar),
  );
  return properties;
}

function legacyPersonaToCreateRequest(parsed: Record<string, unknown>) {
  validateLegacyPersonaImport(parsed);

  return {
    type: AGENT_SOURCE_TYPE,
    name: parsed.displayName as string,
    description: AGENT_DESCRIPTION,
    content: parsed.systemPrompt as string,
    global: true,
    properties: legacyPersonaProperties(parsed),
  };
}

function toPersona(source: AgentSourceEntry): Persona {
  const writable = source.writable === true;
  return {
    id: source.path,
    displayName: source.name,
    avatar: propertyToAvatar(source.properties?.avatar),
    systemPrompt: source.content,
    provider: propertyToString(source.properties?.provider),
    model: propertyToString(source.properties?.model),
    isBuiltin: !writable,
    writable,
    sourceDescription: source.description,
    sourceProperties: source.properties ? { ...source.properties } : undefined,
  };
}

async function listAgentSources(): Promise<AgentSourceEntry[]> {
  const client = await getClient();
  const response = await client.goose.GooseSourcesList({
    type: AGENT_SOURCE_TYPE,
  });
  return response.sources.filter(isAgentSource);
}

export async function listPersonas(): Promise<Persona[]> {
  return (await listAgentSources()).map(toPersona);
}

export async function createPersona(
  request: CreatePersonaRequest,
): Promise<Persona> {
  const client = await getClient();
  const response = await client.goose.GooseSourcesCreate({
    type: AGENT_SOURCE_TYPE,
    name: request.displayName,
    description: AGENT_DESCRIPTION,
    content: request.systemPrompt,
    global: true,
    properties: personaProperties(request),
  });

  if (!isAgentSource(response.source)) {
    throw new Error(`Unexpected source type returned: ${response.source.type}`);
  }

  return toPersona(response.source);
}

export async function updatePersona(
  persona: Persona,
  request: UpdatePersonaRequest,
): Promise<Persona> {
  const client = await getClient();
  const description = persona.sourceDescription ?? AGENT_DESCRIPTION;

  const response = await client.goose.GooseSourcesUpdate({
    type: AGENT_SOURCE_TYPE,
    path: persona.id,
    name: request.displayName ?? persona.displayName,
    description,
    content: request.systemPrompt ?? persona.systemPrompt,
    properties: mergedPersonaProperties(persona.sourceProperties, request),
  });

  if (!isAgentSource(response.source)) {
    throw new Error(`Unexpected source type returned: ${response.source.type}`);
  }

  return toPersona(response.source);
}

export async function deletePersona(id: string): Promise<void> {
  const client = await getClient();
  await client.goose.GooseSourcesDelete({
    type: AGENT_SOURCE_TYPE,
    path: id,
  });
}

export async function refreshPersonas(): Promise<Persona[]> {
  return listPersonas();
}

export interface ExportResult {
  json: string;
  filename: string;
}

export async function exportPersona(id: string): Promise<ExportResult> {
  const client = await getClient();
  const response = await client.goose.GooseSourcesExport({
    type: AGENT_SOURCE_TYPE,
    path: id,
  });
  return { json: response.json, filename: response.filename };
}

export async function importPersonas(
  fileContents: string,
  fileName: string,
): Promise<Persona[]> {
  if (!isSupportedImportFile(fileName)) {
    throw new Error(
      "File must have a .agent.json, .persona.json, or .json extension",
    );
  }

  const { parsed } = readImportJson(fileContents);
  const client = await getClient();

  if (parsed.type === AGENT_SOURCE_TYPE) {
    const response = await client.goose.GooseSourcesImport({
      data: fileContents,
      global: true,
    });
    return response.sources.filter(isAgentSource).map(toPersona);
  }

  const response = await client.goose.GooseSourcesCreate(
    legacyPersonaToCreateRequest(parsed),
  );
  if (!isAgentSource(response.source)) {
    throw new Error(`Unexpected source type returned: ${response.source.type}`);
  }
  return [toPersona(response.source)];
}

export interface ImportFileReadResult {
  fileContents: string;
  fileName: string;
}

export async function readImportPersonaFile(
  sourcePath: string,
): Promise<ImportFileReadResult> {
  return invoke<ImportFileReadResult>("read_import_persona_file", {
    sourcePath,
  });
}
