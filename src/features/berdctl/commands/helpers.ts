/** Truncate with an ellipsis; shared by previews/summaries/message bodies. */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export const sessionNotFoundMessage = (id: string) =>
  `No session "${id}"; list sessions with \`berdctl session list\`.`;

export const backendArchiveFailedMessage = (
  kind: "session" | "project",
  id: string,
) =>
  `The app backend refused to archive "${id}"; confirm the id with \`berdctl ${kind} list\` and retry.`;
