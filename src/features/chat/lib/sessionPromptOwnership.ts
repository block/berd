const promptOwnerBySession = new Map<string, symbol>();

export function claimSessionPrompt(sessionId: string): symbol {
  const owner = Symbol(sessionId);
  promptOwnerBySession.set(sessionId, owner);
  return owner;
}

export function getSessionPromptOwner(sessionId: string): symbol | null {
  return promptOwnerBySession.get(sessionId) ?? null;
}

export function ownsSessionPrompt(sessionId: string, owner: symbol): boolean {
  return getSessionPromptOwner(sessionId) === owner;
}

export function releaseSessionPrompt(
  sessionId: string,
  owner: symbol,
): boolean {
  if (!ownsSessionPrompt(sessionId, owner)) {
    return false;
  }

  promptOwnerBySession.delete(sessionId);
  return true;
}
