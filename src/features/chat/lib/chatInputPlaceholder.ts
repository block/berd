const DEFAULT_LABEL_SUFFIX = " (Default)";

interface ChatInputAgentLabelPersona {
  id: string;
  displayName: string;
}

export function getChatInputAgentLabel(
  personaDisplayName: string | undefined,
  providerDisplayName: string,
): string {
  if (personaDisplayName) {
    return personaDisplayName;
  }

  return providerDisplayName.endsWith(DEFAULT_LABEL_SUFFIX)
    ? providerDisplayName.slice(0, -DEFAULT_LABEL_SUFFIX.length)
    : providerDisplayName;
}

export function getChatInputAgentGroupLabel(
  personas: ChatInputAgentLabelPersona[],
  providerDisplayName: string,
  activePersonaId?: string | null,
): string {
  if (personas.length === 0) {
    return getChatInputAgentLabel(undefined, providerDisplayName);
  }

  if (personas.length === 1) {
    return getChatInputAgentLabel(personas[0].displayName, providerDisplayName);
  }

  const activePersona = activePersonaId
    ? personas.find((persona) => persona.id === activePersonaId)
    : null;
  if (activePersona) {
    const mentionedPersonas = personas.filter(
      (persona) => persona.id !== activePersona.id,
    );
    if (mentionedPersonas.length === 1) {
      return `${activePersona.displayName} (can summon ${mentionedPersonas[0].displayName})`;
    }
    if (mentionedPersonas.length === 2) {
      return `${activePersona.displayName} (can summon ${mentionedPersonas[0].displayName}, ${mentionedPersonas[1].displayName})`;
    }
    return `${activePersona.displayName} (can summon ${mentionedPersonas.length} others)`;
  }

  if (personas.length === 2) {
    return `${personas[0].displayName} and ${personas[1].displayName}`;
  }

  return `${personas[0].displayName}, ${personas[1].displayName}, + ${personas.length - 2} more`;
}

export function getChatInputPlaceholder(
  t: (key: string, options?: { agent: string }) => string,
  agent: string,
  isRecording: boolean,
  isTranscribing: boolean,
  override?: string,
): string {
  if (isRecording) return t("toolbar.voiceInputRecording");
  if (isTranscribing) return t("toolbar.voiceInputTranscribing");
  if (override) return override;
  return t("input.placeholder", { agent });
}
