import type { ProviderInventoryEntryDto } from "@aaif/goose-sdk";
import {
  resolveSessionModelPreference,
  sanitizeSessionModelPreference,
  type SessionModelPreference,
} from "@/features/chat/lib/sessionModelPreference";

export async function resolveSupportedSessionModelPreference(
  providerId: string,
  inventoryEntries: Map<string, ProviderInventoryEntryDto>,
  preferredModel?: string,
): Promise<SessionModelPreference> {
  const sessionModelPreference = resolveSessionModelPreference({
    providerId,
    preferredModel,
  });

  if (!sessionModelPreference.modelId) {
    return sessionModelPreference;
  }

  const inventoryEntry = inventoryEntries.get(
    sessionModelPreference.providerId,
  );

  if (!inventoryEntry || inventoryEntry.models.length === 0) {
    return sessionModelPreference;
  }

  return sanitizeSessionModelPreference(sessionModelPreference, inventoryEntry);
}
