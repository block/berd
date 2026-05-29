import { OAUTH_PROVIDERS } from "@/features/connections/catalog";
import {
  getDisplayName,
  type ExtensionEntry,
} from "@/features/extensions/types";

function toMatchKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const managedConnectionMatchKeys = new Set(
  OAUTH_PROVIDERS.flatMap((provider) =>
    provider.hidden === true
      ? []
      : [provider.provider, provider.displayName].map(toMatchKey),
  ),
);

export function isCompanyManagedExtension(extension: ExtensionEntry): boolean {
  const candidates = [
    extension.config_key,
    extension.name,
    getDisplayName(extension),
  ];
  return candidates.some((candidate) =>
    managedConnectionMatchKeys.has(toMatchKey(candidate)),
  );
}

export function getCompanyManagedExtensionKeys(
  extensions: ExtensionEntry[],
): string[] {
  return extensions
    .filter(isCompanyManagedExtension)
    .map((extension) => extension.config_key);
}
