import { getClient } from "@/shared/api/acpConnection";

export const REASONING_EFFORT_PREFERENCE_KEY = "gooseThinkingEffort";

export async function saveDefaultReasoningEffort(value: string): Promise<void> {
  const client = await getClient();
  await client.goose.GooseUnstablePreferencesSave({
    values: [{ key: REASONING_EFFORT_PREFERENCE_KEY, value }],
  });
}
