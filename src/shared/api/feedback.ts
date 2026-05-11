import { openUrl } from "@tauri-apps/plugin-opener";

export interface FeedbackContext {
  version: string;
  platform: string;
}

export async function openFeedbackForm(
  context: FeedbackContext,
): Promise<void> {
  const body = `Describe your issue or feedback here\n\n---\n**Context**\n- App version: ${context.version}\n- Platform: ${context.platform}`;
  const params = new URLSearchParams({
    project: "Goose Internal Feedback",
    description: body,
  });
  const webUrl = `https://linear.app/squareup/team/BOT/new?${params.toString()}`;
  const desktopUrl = webUrl.replace("https://linear.app/", "linear://");

  try {
    await openUrl(desktopUrl);
  } catch {
    await openUrl(webUrl);
  }
}
