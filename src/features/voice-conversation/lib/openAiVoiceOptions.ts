export const DEFAULT_OPENAI_VOICE = "marin";

export function openAiVoiceLabel(voice: string): string {
  return `${voice.charAt(0).toUpperCase()}${voice.slice(1)}`;
}

export function openAiVoiceOptions(voices: readonly string[]) {
  return Array.from(new Set(voices), (voice) => ({
    value: voice,
    label: openAiVoiceLabel(voice),
  }));
}
