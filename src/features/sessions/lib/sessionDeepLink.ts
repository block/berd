export function createSessionDeepLink(sessionId: string): string {
  return `berd://session/${encodeURIComponent(sessionId)}`;
}
