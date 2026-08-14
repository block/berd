export const AGENT_CARD_FONT_LOAD_TIMEOUT_MS = 1_500;

const CARD_FONTS = [
  "600 64px Inter",
  "600 42px Inter",
  "600 40px Inter",
  "600 36px Inter",
] as const;

export async function loadAgentCardFonts(
  timeoutMs = AGENT_CARD_FONT_LOAD_TIMEOUT_MS,
): Promise<"loaded" | "timeout" | "unavailable"> {
  if (!document.fonts) return "unavailable";

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timeout = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const loading = Promise.allSettled(
    CARD_FONTS.map((font) => document.fonts.load(font)),
  ).then(() => "loaded" as const);

  const result = await Promise.race([loading, deadline]);
  if (timeout) clearTimeout(timeout);
  return result;
}
